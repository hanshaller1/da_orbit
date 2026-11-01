// da_orbit – App-Logik: Oberfläche ↔ Audio-Engine
import { Engine, encodeWav } from './engine.js';
import { DEMOS } from './demo.js';
import { Knob } from './ui/knob.js';
import { Selector } from './ui/selector.js';
import { Visualizer } from './ui/visualizer.js';
import { PresetStore, loadGlobal, saveGlobal, loadCurrent, saveCurrent } from './presets.js';
import { Midi } from './midi.js';
import {
  EFFECTS, CATEGORIES, KNOBS, BANKS, DEFAULT_GLOBAL, MIDI_CC, PC_ORDER,
  SUBDIV_LONG, SUBDIV_LABELS, SUBDIV_SHORT, timeLabel, shapeLabel, glideShapeLabel,
  sanitizeParams, sanitizeLooperOpts, sanitizeGlobal,
} from './data.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const store = new PresetStore();

/* ---------------- Zustand ---------------- */
const saved = loadCurrent();
const params = sanitizeParams(saved && saved.params);
const looperOpts = sanitizeLooperOpts(saved && saved.looperOpts);
const global = loadGlobal();
const ui = {
  shiftLatch: false, shiftKey: false, looperMode: false, hold: false, bypass: false,
  saveMode: false, currentSlot: -1, loopState: null, extClock: false, started: false,
  taps: [], bpm: 100,
};

/* ---------------- Hilfen ---------------- */
let toastTimer = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrent({ params, looperOpts }), 400);
}
function sendParams(values) { engine.setParams(values); persist(); }
async function download(blob, name) {
  // In einer eingebetteten Ansicht (claude.ai-Artifact) laufen Downloads über die downloads-Fähigkeit
  const cl = window.claude;
  if (cl && typeof cl.use === 'function') {
    let dl = null;
    try { dl = await cl.use('downloads'); } catch (_) { dl = null; }
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); return true; } catch (err) {
        const code = err && err.code;
        if (code === 'declined') return false;
        toast(code === 'rejected_extension' ? 'Dieses Format lässt sich hier nicht speichern (lokale Version nutzen)' : 'Speichern ist hier nicht möglich');
        return false;
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
function stamp() { const d = new Date(); return d.toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

/* ---------------- Farbschema ---------------- */
const THEME_KEY = 'da_orbit.theme';
const rootEl = document.documentElement;
const hostTheme = rootEl.dataset.theme || null; // von einer einbettenden Seite gesetzt
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function resolveScheme() {
  const t = rootEl.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && darkMq.matches);
  rootEl.dataset.scheme = dark ? 'dark' : 'light';
}
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') rootEl.dataset.theme = mode;
  else if (hostTheme) rootEl.dataset.theme = hostTheme;
  else delete rootEl.dataset.theme;
  resolveScheme();
}
let themeMode = 'auto';
try { themeMode = localStorage.getItem(THEME_KEY) || 'auto'; } catch (_) { /* kein Speicher */ }
applyTheme(themeMode);
darkMq.addEventListener?.('change', resolveScheme);
new MutationObserver(resolveScheme).observe(rootEl, { attributes: true, attributeFilter: ['data-theme'] });
$('themeBtn').addEventListener('click', () => {
  themeMode = themeMode === 'auto' ? 'dark' : themeMode === 'dark' ? 'light' : 'auto';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch (_) { /* kein Speicher */ }
  applyTheme(themeMode);
  toast('Farbschema: ' + ({ auto: 'automatisch', dark: 'dunkel', light: 'hell' })[themeMode]);
});

/* ---------------- Regler ---------------- */
const knobs = {};
const knobHost = $('knobHost');
for (const def of KNOBS) {
  knobs[def.main.key] = new Knob(knobHost, def, params, onKnob);
}
function knobFor(key) { return Object.values(knobs).find((k) => k.def.main.key === key || k.def.alt.key === key); }
function onKnob(key, v) {
  params[key] = v;
  const values = { [key]: v };
  sendParams(values);
  if (key === 'time') updateTimeDisplay();
  if (key === 'shape') updateFxInfo();
}
function refreshKnobs() { Object.values(knobs).forEach((k) => k.render()); }
function updateTimeDisplay() {
  const tk = knobs.time;
  tk.setFormatter('time', (v) => timeLabel(v, params.timeMode));
  tk.setSteps('time', params.timeMode === 1 ? 0 : 6);
  $('timeModeText').textContent = params.timeMode === 1 ? 'Tempo' : 'Teilung';
  $('timeModeBtn').classList.toggle('is-on', params.timeMode === 1);
  const idx = params.timeMode === 1 ? 2 : Math.min(5, Math.floor(params.time * 6));
  $('subdivChip').textContent = params.timeMode === 1 ? 'Tempo-Modus' : SUBDIV_LABELS[idx] + ' · ' + SUBDIV_SHORT[idx];
  $('subdivChip').title = params.timeMode === 1 ? 'Zeit-Regler stellt das Tempo' : SUBDIV_LONG[idx];
}
function setShiftVisual() {
  const on = ui.shiftLatch || ui.shiftKey;
  Object.values(knobs).forEach((k) => k.setShift(on));
  $('shiftBtn').classList.toggle('is-on', on);
}
$('shiftBtn').addEventListener('click', () => { ui.shiftLatch = !ui.shiftLatch; setShiftVisual(); });
$('timeModeBtn').addEventListener('click', toggleTimeMode);
function toggleTimeMode() {
  params.timeMode = params.timeMode === 1 ? 0 : 1;
  if (params.timeMode === 1) params.time = Math.max(0, Math.min(1, (ui.bpm - 40) / 200));
  else params.time = 2.5 / 6;
  sendParams({ timeMode: params.timeMode, time: params.time });
  if (params.timeMode === 1) engine.post({ type: 'bpm', bpm: ui.bpm });
  updateTimeDisplay(); refreshKnobs();
  toast(params.timeMode === 1 ? 'Zeit-Regler stellt das Tempo' : 'Zeit-Regler stellt die Teilung');
}

/* ---------------- Effektwahl ---------------- */
const selector = new Selector($('selectorHost'), (fx, va) => selectEffect(fx, va, true), (rev) => {
  params.effRev = rev ? 1 : 0; sendParams({ effRev: params.effRev });
  toast(rev ? 'Effekt rückwärts' : 'Effekt vorwärts');
});
const viz = new Visualizer($('viz'));

function selectEffect(fx, va, fromUser) {
  const changedFx = fx !== params.effect;
  params.effect = fx; params.variation = va;
  const values = { effect: fx, variation: va };
  if (fromUser && global.suggest) {
    const s = EFFECTS[fx].sugg;
    if (changedFx) {
      for (const k of ['activity', 'repeats', 'shape']) { params[k] = s[k]; values[k] = s[k]; }
      if (params.timeMode === 0) { params.time = s.time; values.time = s.time; }
    }
  }
  sendParams(values);
  selector.select(fx, va, false);
  refreshKnobs(); updateTimeDisplay(); updateFxInfo();
}
function updateFxInfo() {
  const fx = EFFECTS[params.effect];
  const color = CATEGORIES[fx.cat].color;
  document.documentElement.style.setProperty('--fx', color);
  const cs = getComputedStyle(document.documentElement);
  const varName = color.match(/var\((--[^)]+)\)/);
  viz.setColor(varName ? cs.getPropertyValue(varName[1]).trim() : color);
  $('fxName').textContent = fx.name;
  $('fxVar').textContent = 'ABCD'[params.variation];
  $('fxVarName').textContent = fx.vars[params.variation];
  $('fxDesc').textContent = fx.desc;
  $('fxAct').textContent = fx.act;
  $('fxRep').textContent = fx.rep;
  const sh = $('fxShape'), shDt = document.querySelector('.fx-shape-dt');
  sh.hidden = shDt.hidden = !fx.shapeNote;
  if (fx.shapeNote) sh.textContent = fx.shapeNote;
  knobs.shape.setFormatter('shape', fx.name === 'GLIDE' ? glideShapeLabel : fx.name === 'PATTERN' || fx.name === 'WARP' ? patternShapeLabel : shapeLabel);
}
function patternShapeLabel(v) { return v < 0.4 ? 'Ansteigend' : v < 0.6 ? 'Gleich' : 'Abfallend'; }

/* ---------------- Tap-Tempo ---------------- */
function tap() {
  if (ui.extClock) { toast('Tempo kommt gerade per MIDI-Clock'); return; }
  const now = performance.now();
  ui.taps = ui.taps.filter((t) => now - t < 2500);
  ui.taps.push(now);
  if (ui.taps.length >= 2) {
    const iv = [];
    for (let i = 1; i < ui.taps.length; i++) iv.push(ui.taps[i] - ui.taps[i - 1]);
    const recent = iv.slice(-4);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    setBpm(60000 / avg, true);
  } else {
    engine.post({ type: 'bpm', bpm: ui.bpm, resync: true });
  }
}
function setBpm(bpm, resync) {
  bpm = Math.max(20, Math.min(300, bpm));
  ui.bpm = bpm;
  engine.post({ type: 'bpm', bpm, resync });
  if (params.timeMode === 1) { params.time = Math.max(0, Math.min(1, (bpm - 40) / 200)); knobs.time.render(); persist(); }
  $('bpmText').textContent = Math.round(bpm) + ' BPM';
}

/* ---------------- Fußschalter ---------------- */
const LONG_MS = 650;
function footswitch(btnId, handlers) {
  const btn = $(btnId);
  let timer = 0, longFired = false, down = false;
  const press = () => {
    if (down) return; down = true; longFired = false;
    btn.classList.add('is-down');
    handlers.down && handlers.down();
    if (handlers.long) timer = setTimeout(() => { longFired = true; handlers.long(); }, LONG_MS);
  };
  const release = () => {
    if (!down) return; down = false;
    btn.classList.remove('is-down');
    clearTimeout(timer);
    handlers.up && handlers.up(longFired);
  };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); press(); });
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); press(); } });
  btn.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); release(); } });
  return { press, release };
}
const fsLeft = footswitch('fsLeft', {
  down: () => {
    if (!ui.looperMode) return tap();
    if (looperOpts.burst) return engine.post({ type: 'looper', cmd: 'burstStart' });
    engine.post({ type: 'looper', cmd: 'main' });
  },
  long: () => { if (ui.looperMode && !looperOpts.burst) { engine.post({ type: 'looper', cmd: 'undo' }); toast('Overdub rückgängig / wiederhergestellt'); } },
  up: () => { if (ui.looperMode && looperOpts.burst) engine.post({ type: 'looper', cmd: 'burstEnd' }); },
});
const fsMid = footswitch('fsMid', { down: () => setBypass(!ui.bypass) });
const fsRight = footswitch('fsRight', {
  down: () => {
    if (ui.looperMode) return;
    if (global.holdMode === 1) setHold(true); else setHold(!ui.hold);
  },
  long: () => { if (ui.looperMode) { engine.post({ type: 'looper', cmd: 'erase' }); toast('Loop gelöscht'); } },
  up: (long) => {
    if (ui.looperMode) { if (!long) engine.post({ type: 'looper', cmd: 'stop' }); return; }
    if (global.holdMode === 1) setHold(false);
  },
});
function setBypass(on) {
  ui.bypass = on;
  engine.post({ type: 'bypass', on });
  $('bypChip').hidden = !on;
  updateFootswitchUI();
}
function setHold(on) {
  if (on && ui.loopState && ui.loopState.st !== 0) { toast('Hold ist nicht verfügbar, solange ein Loop existiert'); return; }
  ui.hold = on;
  engine.post({ type: 'hold', on });
  updateFootswitchUI();
}
function setLooperMode(on) {
  ui.looperMode = on;
  if (on && ui.hold) setHold(false);
  $('looperBtn').classList.toggle('is-on', on);
  updateFootswitchUI();
}
$('looperBtn').addEventListener('click', () => setLooperMode(!ui.looperMode));
$('loopRevBtn').addEventListener('click', () => engine.post({ type: 'looper', cmd: 'reverse' }));

function updateFootswitchUI() {
  if (ui.looperMode) {
    $('fsLeftLabel').textContent = looperOpts.burst ? 'BURST' : 'REC · PLAY · DUB';
    $('fsLeftSub').textContent = looperOpts.burst ? 'Halten = aufnehmen · Q' : 'lang: Undo · Q';
    $('fsRightLabel').textContent = 'STOPP';
    $('fsRightSub').textContent = 'lang: Löschen · E';
  } else {
    $('fsLeftLabel').textContent = 'TAP';
    $('fsLeftSub').textContent = 'Tempo tippen · Q';
    $('fsRightLabel').textContent = 'HOLD';
    $('fsRightSub').textContent = (global.holdMode === 1 ? 'Halten = einfrieren' : 'Einfrieren') + ' · E';
  }
  $('fsMidLed').className = 'fs-led' + (ui.bypass ? '' : ' c-fx');
  $('fsMidSub').textContent = (ui.bypass ? 'aus' : 'aktiv') + ' · W';
}

/* ---------------- Looper-Panel ---------------- */
const optMap = { optPre: 'pre', optQuant: 'quant', optOnly: 'only', optBurst: 'burst' };
for (const [id, key] of Object.entries(optMap)) {
  const cb = $(id);
  cb.checked = !!looperOpts[key];
  cb.addEventListener('change', () => { looperOpts[key] = cb.checked; sendLooperOpts(); updateFootswitchUI(); persist(); });
}
function sendLooperOpts() {
  engine.post({ type: 'looperOpts', values: { ...looperOpts, order: global.looperOrder | 0, fadeShape: global.fadeShape | 0 } });
}
$('loopUndoBtn').addEventListener('click', () => engine.post({ type: 'looper', cmd: 'undo' }));
$('loopExportBtn').addEventListener('click', async () => {
  const d = await engine.getLoop();
  if (!d || !d.L) { toast('Kein Loop vorhanden'); return; }
  await download(encodeWav(d.L, d.R, d.sr), `da_orbit-loop-${stamp()}.wav`);
});
$('loopImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    await ensureStarted();
    const buf = await engine.ctx.decodeAudioData(await f.arrayBuffer());
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    if (!engine.setLoop(L, R, buf.sampleRate)) { toast('Datei ist zu kurz für einen Loop'); return; }
    setLooperMode(true);
    const sec = Math.min(60, buf.duration);
    toast(`Loop geladen (${sec.toFixed(1)} s${buf.duration > 60 ? ', auf 60 s gekürzt' : ''}) – linker Schalter startet ihn`);
  } catch (err) { toast('Datei konnte nicht gelesen werden'); }
});
const LOOP_NAMES = ['leer', 'Aufnahme', 'Wiedergabe', 'Overdub', 'gestoppt'];
const LOOP_CLASSES = ['', 's-rec', 's-play', 's-dub', ''];

/* ---------------- Presets ---------------- */
const bankHost = $('bankHost');
const slotEls = [];
BANKS.forEach((b, bi) => {
  const row = document.createElement('div'); row.className = 'bank'; row.style.setProperty('--bc', b.color);
  const nm = document.createElement('div'); nm.className = 'bank-name'; nm.textContent = b.name; row.appendChild(nm);
  for (let s = 0; s < 4; s++) {
    const idx = bi * 4 + s;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'slot';
    btn.addEventListener('click', (e) => onSlot(idx, e.shiftKey));
    row.appendChild(btn); slotEls.push(btn);
  }
  bankHost.appendChild(row);
});
function renderSlots() {
  slotEls.forEach((el, i) => {
    const p = store.get(i);
    el.classList.toggle('has', !!p);
    el.classList.toggle('is-current', i === ui.currentSlot);
    el.textContent = p ? p.name : `${i % 4 + 1}`;
    el.title = p ? `${p.name} – ${EFFECTS[p.params.effect].name} ${'ABCD'[p.params.variation]}${p.hasLoop ? ' + Loop' : ''}` : 'leer';
    if (p && p.hasLoop) { const m = document.createElement('span'); m.className = 'loop-mark'; el.appendChild(m); }
  });
}
async function onSlot(idx, shift) {
  if (ui.saveMode || shift) return savePreset(idx);
  const p = store.get(idx);
  if (!p) { toast('Leerer Platz – zum Speichern Shift + Klick'); return; }
  await loadPreset(idx);
}
async function savePreset(idx) {
  const fx = EFFECTS[params.effect];
  const name = `${fx.name.slice(0, 5)} ${'ABCD'[params.variation]}`;
  const loop = engine.node ? await engine.getLoop() : null;
  const withLoop = !!(loop && loop.L);
  const loopSaved = await store.save(idx, { name, params: { ...params }, looperOpts: { ...looperOpts } }, withLoop ? loop : null);
  ui.currentSlot = idx; ui.saveMode = false;
  $('saveModeBtn').classList.remove('is-on'); document.querySelector('.preset-panel').classList.remove('is-saving');
  renderSlots();
  const where = `${BANKS[idx >> 2].name} ${idx % 4 + 1}`;
  if (withLoop && !loopSaved) toast(`Gespeichert auf ${where}, aber ohne Loop (Browser-Speicher voll oder gesperrt)`);
  else toast(`Gespeichert auf ${where}${withLoop ? ' (mit Loop)' : ''}`);
}
async function loadPreset(idx) {
  const p = store.get(idx);
  if (!p) return;
  Object.assign(params, sanitizeParams(p.params));
  Object.assign(looperOpts, sanitizeLooperOpts(p.looperOpts));
  for (const [id, key] of Object.entries(optMap)) $(id).checked = !!looperOpts[key];
  engine.setParams({ ...params });
  sendLooperOpts();
  selector.select(params.effect, params.variation, false);
  selector.setRev(!!params.effRev);
  refreshKnobs(); updateTimeDisplay(); updateFxInfo();
  ui.currentSlot = idx; renderSlots(); persist();
  if (p.hasLoop) {
    const loop = await store.loadLoop(idx);
    if (loop && loop.L && engine.setLoop(loop.L, loop.R, loop.sr)) {
      setLooperMode(true);
      toast(`${p.name} geladen – Loop bereit (linker Schalter)`);
      return;
    }
  }
  toast(`${p.name} geladen`);
}
$('saveModeBtn').addEventListener('click', () => {
  ui.saveMode = !ui.saveMode;
  $('saveModeBtn').classList.toggle('is-on', ui.saveMode);
  document.querySelector('.preset-panel').classList.toggle('is-saving', ui.saveMode);
  if (ui.saveMode) toast('Platz zum Speichern anklicken');
});
$('suggBtn').addEventListener('click', () => {
  const s = EFFECTS[params.effect].sugg;
  const values = { activity: s.activity, repeats: s.repeats, shape: s.shape };
  if (params.timeMode === 0) values.time = s.time;
  Object.assign(params, values); sendParams(values); refreshKnobs(); updateTimeDisplay(); updateFxInfo();
  toast('Vorschlagswerte geladen');
});
$('exportBtn').addEventListener('click', () => download(new Blob([store.exportJSON()], { type: 'application/json' }), `da_orbit-presets-${stamp()}.json`));
$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { store.importJSON(await f.text()); renderSlots(); toast('Presets importiert (ohne Loops)'); } catch (err) { toast(err.message || 'Import fehlgeschlagen'); }
});

/* ---------------- Einstellungen ---------------- */
const chSel = $('midiChSel');
chSel.innerHTML = '<option value="0">Omni (alle)</option>' + Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
function syncSettingsForm() {
  document.querySelectorAll('[data-g]').forEach((el) => { el.value = String(global[el.dataset.g]); });
}
document.querySelectorAll('[data-g]').forEach((el) => {
  el.addEventListener('change', () => {
    const k = el.dataset.g;
    // ungültige Eingaben (leeres Zahlenfeld, CC 0 …) fallen auf den bisherigen Wert zurück
    Object.assign(global, sanitizeGlobal({ ...global, [k]: el.value }, global));
    saveGlobal(global); applyGlobal(); syncSettingsForm();
  });
});
function applyGlobal() {
  engine.setParams({ mono: global.mono | 0, inputLine: global.inputLine | 0, bypassStyle: global.bypassStyle | 0 });
  sendLooperOpts();
  midi.channel = global.midiChannel | 0;
  updateFootswitchUI();
}
$('settingsBtn').addEventListener('click', () => {
  syncSettingsForm();
  $('settingsDlg').showModal();
});
$('panicBtn').addEventListener('click', () => { engine.post({ type: 'panic' }); toast('Puffer geleert'); });
$('resetGlobalBtn').addEventListener('click', () => { Object.assign(global, DEFAULT_GLOBAL); saveGlobal(global); syncSettingsForm(); applyGlobal(); toast('Zurückgesetzt'); });
$('helpBtn').addEventListener('click', () => $('helpDlg').showModal());
$('helpEffects').innerHTML = EFFECTS.map((fx) => `
  <div class="help-fx" style="--c:${CATEGORIES[fx.cat].color}">
    <b>${fx.name}</b> <span class="hint">· ${CATEGORIES[fx.cat].name}</span><br>${fx.desc} <i>Aktivität:</i> ${fx.act}. <i>Wiederholung:</i> ${fx.rep}.${fx.shapeNote ? ' <i>Form:</i> ' + fx.shapeNote + '.' : ''}
    <ol>${fx.vars.map((v) => `<li>${v}</li>`).join('')}</ol>
  </div>`).join('');

/* ---------------- MIDI ---------------- */
let midiActTimer = 0, clockWatch = 0;
function setExtClock(on) {
  if (ui.extClock === on) return;
  ui.extClock = on;
  engine.post({ type: 'extClock', on });
  $('clockChip').hidden = !on;
  if (on) toast('Tempo folgt der MIDI-Clock');
}
const midi = new Midi({
  cc: (cc, val) => handleCC(cc, val),
  pc: (p) => handlePC(p),
  clockStart: () => {
    if (!global.midiClock) return;
    setExtClock(true);
    // Start ohne folgende Clock-Ticks darf das Tap-Tempo nicht dauerhaft sperren
    clearTimeout(clockWatch); clockWatch = setTimeout(() => setExtClock(false), 1500);
    engine.post({ type: 'bpm', bpm: ui.bpm, resync: true });
  },
  clockStop: () => { /* Clock-Ticks laufen bei vielen Geräten weiter; der Watchdog beendet den externen Takt */ },
  clockBpm: (bpm) => {
    if (!global.midiClock) return;
    setExtClock(true);
    clearTimeout(clockWatch); clockWatch = setTimeout(() => setExtClock(false), 1500);
    if (Math.abs(bpm - ui.bpm) > 0.4) setBpm(Math.round(bpm * 10) / 10, false);
  },
  activity: () => { $('midiBtn').classList.add('is-act'); clearTimeout(midiActTimer); midiActTimer = setTimeout(() => $('midiBtn').classList.remove('is-act'), 120); },
  devices: (names) => { if (names.length) toast('MIDI: ' + names.join(', ')); },
});
$('midiBtn').addEventListener('click', async () => {
  try {
    await midi.enable(); midi.channel = global.midiChannel | 0;
    $('midiBtn').classList.add('is-on');
    toast('MIDI aktiv');
  } catch (err) { toast(err.message || 'MIDI nicht verfügbar'); }
});
function setParamFromExternal(key, v) {
  params[key] = v;
  sendParams({ [key]: v });
  const k = knobFor(key); if (k) k.render();
  if (key === 'time') updateTimeDisplay();
}
function handleCC(cc, val) {
  const v = val / 127, on = val >= 64;
  if (cc === (global.expCC | 0)) { setParamFromExternal(global.expTarget, v); return; }
  const m = MIDI_CC[cc];
  if (!m) return;
  switch (m.kind) {
    case 'param': setParamFromExternal(m.key, v); break;
    case 'subdiv': {
      // timeMode und time in EINER Nachricht: einzeln interpretierte der Prozessor den neuen Zeitwert
      // noch im Tempo-Modus und setzte das Tempo auf ~57 BPM
      params.timeMode = 0; params.time = (Math.min(5, val) + 0.5) / 6;
      sendParams({ timeMode: 0, time: params.time });
      knobs.time.render(); updateTimeDisplay();
      break;
    }
    case 'loopSpeedStep': {
      const steps = [0.25, 0.5, 1, 2, 4];
      const s = steps[Math.min(4, Math.floor(v * 5))];
      setParamFromExternal('loopSpeed', 0.5 + Math.log2(s) / 4);
      break;
    }
    case 'toggle':
      if (m.key === 'looperMode') setLooperMode(on);
      else if (m.key === 'loopRev') { if (!!(ui.loopState && ui.loopState.rev) !== on) engine.post({ type: 'looper', cmd: 'reverse' }); }
      else if (m.key === 'effRev') { params.effRev = on ? 1 : 0; selector.setRev(on); sendParams({ effRev: params.effRev }); }
      else if (m.key === 'hold') setHold(on);
      else if (m.key in looperOpts) {
        looperOpts[m.key] = on; const id = Object.keys(optMap).find((x) => optMap[x] === m.key); if (id) $(id).checked = on;
        sendLooperOpts(); updateFootswitchUI();
      }
      break;
    case 'looper': if (val > 0) engine.post({ type: 'looper', cmd: m.cmd }); break;
    case 'tap': if (val > 0) tap(); break;
    case 'bypassCC': setBypass(!on); break;
    case 'savePreset': if (val > 0 && ui.currentSlot >= 0) savePreset(ui.currentSlot); break;
  }
}
function handlePC(p) {
  if (p < 44) {
    const name = PC_ORDER[Math.floor(p / 4)];
    const fx = EFFECTS.findIndex((e) => e.name === name);
    if (fx >= 0) selectEffect(fx, p % 4, true);
  } else if (p < 60) loadPreset(p - 44);
}

/* ---------------- Tastatur ---------------- */
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') { ui.shiftKey = true; setShiftVisual(); return; }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.repeat && 'qwe'.includes(k)) { e.preventDefault(); return; }
  if (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'slider' && e.key.startsWith('Arrow')) return;
  switch (k) {
    case 'q': held.add('q'); fsLeft.press(); break;
    case 'w': held.add('w'); fsMid.press(); break;
    case 'e': held.add('e'); fsRight.press(); break;
    case 'l': setLooperMode(!ui.looperMode); break;
    case 'r': engine.post({ type: 'looper', cmd: 'reverse' }); break;
    case 'v': selector.setRev(!selector.rev); params.effRev = selector.rev ? 1 : 0; sendParams({ effRev: params.effRev }); break;
    case 't': toggleTimeMode(); break;
    case 'arrowright': selector.step(1); break;
    case 'arrowleft': selector.step(-1); break;
    case 'arrowdown': selector.stepEffect(1); break;
    case 'arrowup': selector.stepEffect(-1); break;
    case '1': case '2': case '3': case '4': selectEffect(params.effect, Number(k) - 1, true); break;
    default: return;
  }
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') { ui.shiftKey = false; setShiftVisual(); return; }
  const k = e.key.toLowerCase();
  if (!held.has(k)) return;
  held.delete(k);
  if (k === 'q') fsLeft.release(); else if (k === 'w') fsMid.release(); else if (k === 'e') fsRight.release();
});
// Fenster verliert den Fokus, während Q/W/E gehalten wird: keyup kommt nie an → Schalter lösen
// (sonst bliebe z. B. Burst-Aufnahme oder momentanes Hold hängen)
function releaseHeldKeys() {
  for (const k of held) { if (k === 'q') fsLeft.release(); else if (k === 'w') fsMid.release(); else if (k === 'e') fsRight.release(); }
  held.clear();
}
window.addEventListener('blur', () => { ui.shiftKey = false; setShiftVisual(); releaseHeldKeys(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeldKeys(); });

/* ---------------- Engine-Zustand → Oberfläche ---------------- */
let lastBeat = -1, beatLedTimer = 0;
engine.addEventListener('state', (ev) => {
  const s = ev.detail;
  viz.update(s);
  const meter = (id, v) => { $(id).style.width = Math.min(100, Math.sqrt(v) * 100) + '%'; };
  if (!$('inputBar').hidden) {
    const lv = s.peakIn > 0.98 ? 'clip' : s.peakIn > 0.003 ? 'sig' : '';
    const led = $('inLed'); if (led.dataset.lv !== lv) { led.dataset.lv = lv; }
  }
  meter('meterIn', s.peakIn); meter('meterL', s.peakL); meter('meterR', s.peakR);
  if (Math.abs(s.bpm - ui.bpm) > 0.05 && !ui.extClock) { ui.bpm = s.bpm; }
  $('bpmText').textContent = Math.round(s.bpm) + ' BPM';
  $('voiceChip').textContent = (s.voices.length / 4) + (s.taps.length ? ` Stimmen · ${s.taps.length / 3} Taps` : ' Stimmen');
  if (s.beat !== lastBeat) {
    lastBeat = s.beat;
    $('beatLed').classList.add('on');
    if (!ui.looperMode) $('fsLeftLed').className = 'fs-led c-fx';
    clearTimeout(beatLedTimer);
    beatLedTimer = setTimeout(() => { $('beatLed').classList.remove('on'); if (!ui.looperMode) $('fsLeftLed').className = 'fs-led'; }, 90);
  }
  // Hold
  if (s.hold !== ui.hold && !(global.holdMode === 1)) { ui.hold = s.hold; }
  $('holdChip').hidden = !s.hold;
  const ht = $('holdText');
  ht.textContent = s.hold ? `an · ${s.holdLen.toFixed(2)} s` : 'aus';
  ht.className = 'ro-val' + (s.hold ? ' v-hold' : '');
  $('unitText').textContent = s.unitSec >= 1 ? s.unitSec.toFixed(2) + ' s' : Math.round(s.unitSec * 1000) + ' ms';
  if (!ui.looperMode) $('fsRightLed').className = 'fs-led' + (s.hold ? ' c-blue' : '');
  // Looper
  const lp = s.loop; ui.loopState = lp;
  const st = $('loopState');
  st.textContent = LOOP_NAMES[lp.st] + (lp.hasDub && !lp.dubOn ? ' (Undo)' : '') + (lp.rev ? ' ⟲' : '');
  st.className = 'loop-state ' + LOOP_CLASSES[lp.st];
  $('loopTime').textContent = lp.st === 1 ? `${lp.rec.toFixed(1)} s / 60 s` : `${(lp.pos * lp.len).toFixed(1)} / ${lp.len.toFixed(1)} s · ${lp.speed.toFixed(2)}×`;
  const bar = $('loopBar');
  bar.style.width = (lp.st === 1 ? Math.min(100, lp.rec / 60 * 100) : lp.pos * 100) + '%';
  bar.style.background = lp.st === 1 ? 'var(--led-red)' : lp.st === 3 ? 'var(--led-yellow)' : 'var(--led-green)';
  $('loopRevBtn').classList.toggle('is-on', !!lp.rev);
  const lm = $('loopMini');
  lm.textContent = lp.st === 0 ? 'leer' : lp.st === 1 ? `● ${lp.rec.toFixed(1)} s` : `${LOOP_NAMES[lp.st]} ${lp.len.toFixed(1)} s`;
  lm.className = 'ro-val ' + (['', 'v-rec', 'v-play', 'v-dub', ''][lp.st]);
  if (ui.looperMode) {
    const c = lp.st === 1 ? 'c-red' : lp.st === 2 ? 'c-green' : lp.st === 3 ? 'c-yellow' : '';
    $('fsLeftLed').className = 'fs-led ' + c + (lp.st === 1 && lp.rec > 55 ? ' blink' : '');
    $('fsRightLed').className = 'fs-led' + (lp.st === 4 ? ' c-red' : '');
  }
});

engine.addEventListener('recovered', (e) => {
  toast(e.detail && e.detail.loopCleared ? 'Audiofehler abgefangen – Effekte und Loop zurückgesetzt' : 'Audiofehler abgefangen – Effekte zurückgesetzt');
});
engine.addEventListener('processorerror', () => toast('Der Audio-Prozessor ist abgestürzt – bitte die Seite neu laden'));
engine.addEventListener('recordererror', async () => {
  $('recBtn').classList.remove('is-on');
  const blob = await engine.stopRecording(); // bisher Aufgenommenes nicht verlieren
  toast('Aufnahme abgebrochen');
  if (blob) saveRecording(blob);
});

/* ---------------- Audio-Eingang (Interface, USB-Gerät, Mikrofon) ---------------- */
const INPUT_KEY = 'da_orbit.input.v1';
function loadInputPrefs() {
  try { const v = JSON.parse(localStorage.getItem(INPUT_KEY)); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
function saveInputPrefs() { try { localStorage.setItem(INPUT_KEY, JSON.stringify(inputPrefs)); } catch (_) { /* kein Speicher */ } }
const inputPrefs = loadInputPrefs();
let inputDevices = [], inputLost = false;

function routeLabel(r) { return !r ? '' : r.a === r.b ? `Kanal ${r.a + 1}` : `Kanal ${r.a + 1}+${r.b + 1}`; }
// Gespeichertes Gerät wiederfinden: erst über die ID, sonst über den Namen
function resolveDevice() {
  if (!inputPrefs.deviceId && !inputPrefs.label) return undefined;
  if (!inputDevices.some((d) => d.deviceId)) return inputPrefs.deviceId;
  const byId = inputDevices.find((d) => d.deviceId === inputPrefs.deviceId);
  if (byId) return byId.deviceId;
  const byLabel = inputPrefs.label && inputDevices.find((d) => d.label === inputPrefs.label);
  return byLabel ? byLabel.deviceId : undefined;
}
async function refreshDevices() {
  try { inputDevices = await engine.listInputs(); } catch (_) { inputDevices = []; }
  fillDeviceSelect();
  return inputDevices;
}
function fillDeviceSelect() {
  const sel = $('inDevice'), info = engine.inputInfo;
  sel.textContent = '';
  inputDevices.forEach((d, i) => sel.add(new Option(d.label || `Eingang ${i + 1}`, d.deviceId)));
  if (info && info.deviceId && !inputDevices.some((d) => d.deviceId === info.deviceId)) sel.add(new Option(info.label, info.deviceId));
  if (!sel.options.length) sel.add(new Option('Standard-Eingang', ''));
  const cur = info ? info.deviceId : resolveDevice();
  if (cur !== undefined && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function fillRouteSelect() {
  const sel = $('inRoute'), info = engine.inputInfo;
  sel.textContent = '';
  if (!info) { sel.add(new Option('–', '')); return; }
  const n = info.channels;
  for (let a = 0; a + 1 < n; a += 2) sel.add(new Option(`${a + 1}+${a + 2} Stereo-Paar`, `${a},${a + 1}`));
  for (let a = 0; a < n; a++) sel.add(new Option(`${a + 1} Mono`, `${a},${a}`));
  const r = engine.inputRoute;
  if (r) sel.value = `${r.a},${r.b}`;
}
function updateInputBar() {
  if (engine.sourceKind !== 'input' && engine.sourceKind !== 'none') inputLost = false;
  const show = engine.sourceKind === 'input' || inputLost;
  $('inputBar').hidden = !show;
  if (!show) return;
  syncSettingsForm();
  fillDeviceSelect(); fillRouteSelect();
  const info = engine.inputInfo, r = engine.inputRoute;
  $('inRoute').disabled = !info || info.channels < 2;
  $('inMode').disabled = !info || !r || r.a === r.b;
  $('inputBar').classList.toggle('is-lost', !info);
  const hints = [];
  if (info) {
    const khz = (info.sampleRate / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    const lat = info.latency > 0 ? ` · ca. ${Math.round(info.latency * 1000)} ms` : '';
    $('inInfo').textContent = `${info.channels} ${info.channels === 1 ? 'Kanal' : 'Kanäle'} · ${khz} kHz${lat}`;
    if (info.channels === 2) hints.push('Mehr Eingänge am Interface? Wie viele Kanäle ankommen, entscheiden Browser und Treiber; oft sind es nur die ersten zwei.');
    if (/mic|mikro|microphone|headset/i.test(info.label)) hints.push('Mikrofon: bitte Kopfhörer benutzen, sonst koppelt der Lautsprecher zurück.');
  } else {
    $('inInfo').textContent = 'getrennt';
    hints.push('Das Gerät wurde getrennt. Sobald es wieder angeschlossen ist, verbindet da_orbit es automatisch.');
  }
  $('inHint').textContent = hints.join(' ');
  $('inHint').hidden = !hints.length;
}
async function startInput(deviceId) {
  if (!inputDevices.length) await refreshDevices();
  const id = deviceId !== undefined ? deviceId : resolveDevice();
  let info;
  try {
    info = await engine.useInput(id || undefined);
  } catch (err) {
    // gespeichertes Gerät nicht mehr da → Standard-Eingang
    if (id && err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) info = await engine.useInput(undefined);
    else throw err;
  }
  inputLost = false;
  const saved = inputPrefs.routes && inputPrefs.routes[info.label];
  if (saved) engine.setInputRoute(saved);
  inputPrefs.deviceId = info.deviceId; inputPrefs.label = info.label;
  saveInputPrefs();
  await refreshDevices(); // nach der Freigabe sind die Gerätenamen lesbar
  updateSrcText();
  return info;
}
$('inDevice').addEventListener('change', async (e) => {
  const seq = ++srcSeq;
  try {
    await ensureStarted();
    const info = await startInput(e.target.value);
    if (seq !== srcSeq) return;
    $('sourceSel').value = 'input'; ui.srcVal = 'input'; updateSrcText();
    toast(info.label + ' aktiv');
  } catch (err) { if (!isSuperseded(err)) toast(errorText(err)); updateInputBar(); }
});
$('inRoute').addEventListener('change', (e) => {
  const [a, b] = e.target.value.split(',').map(Number);
  const r = engine.setInputRoute({ a, b });
  if (!r) return;
  if (r.a !== r.b && global.mono) { global.mono = 0; saveGlobal(global); applyGlobal(); toast('Stereo-Verarbeitung an'); }
  inputPrefs.routes = { ...(inputPrefs.routes || {}), [engine.inputInfo.label]: r };
  saveInputPrefs();
  updateSrcText();
});
$('inRefresh').addEventListener('click', async () => {
  await refreshDevices(); updateInputBar();
  toast(`${inputDevices.length} ${inputDevices.length === 1 ? 'Eingang' : 'Eingänge'} gefunden`);
});
engine.addEventListener('inputended', () => {
  if (engine.sourceKind !== 'input') return;
  engine.stopSource();
  inputLost = true;
  toast('Audio-Eingang getrennt');
  updateSrcText();
});
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    if (inputLost && ui.srcVal === 'input') {
      const id = resolveDevice();
      if (id && inputDevices.some((d) => d.deviceId === id)) {
        try { const info = await startInput(id); toast(info.label + ' wieder verbunden'); } catch (_) { /* weiter warten */ }
      }
    }
    updateInputBar();
  });
}

/* ---------------- Quellen & Start ---------------- */
async function ensureStarted() {
  if (ui.started) { await engine.init(); return; }
  await engine.init();
  ui.started = true;
  engine.setParams({ ...params, mono: global.mono | 0, inputLine: global.inputLine | 0, bypassStyle: global.bypassStyle | 0 });
  sendLooperOpts();
  engine.post({ type: 'bpm', bpm: ui.bpm, resync: true });
  engine.setInputGain(Number($('inGain').value));
  engine.setMaster(Number($('outGain').value));
}
let srcSeq = 0;
async function useSource(val) {
  const seq = ++srcSeq;
  if (val !== 'input') inputLost = false;
  await ensureStarted();
  if (val.startsWith('demo:')) {
    const bpm = await engine.useDemo(val.slice(5));
    if (!ui.extClock) setBpm(bpm, true);
    toast(DEMOS.find((d) => 'demo:' + d.id === val).name + ' läuft in Schleife');
  } else if (val === 'input') {
    const info = await startInput();
    if (seq !== srcSeq) return;
    toast(info.label + ' aktiv');
  } else if (val === 'file') {
    if (engine.fileBuffer) { await engine.useFile(); toast(engine.fileName + ' läuft in Schleife'); }
    else {
      // erst nach der Dateiauswahl umschalten; bis dahin (oder bei Abbruch) bleibt die bisherige Quelle
      $('sourceSel').value = ui.srcVal || 'none';
      $('sourceFile').click();
      return;
    }
  } else engine.useNone();
  if (seq !== srcSeq) return;
  $('sourceSel').value = val; ui.srcVal = val;
  updateSrcText();
}
function updateSrcText() {
  const sel = $('sourceSel');
  const txt = engine.sourceKind === 'file' ? engine.fileName
    : engine.sourceKind === 'input' && engine.inputInfo ? engine.inputInfo.label + ' ' + routeLabel(engine.inputRoute)
      : sel.options[sel.selectedIndex].text.replace('Demo: ', '');
  $('srcText').textContent = engine.sourceKind === 'none' ? 'keiner' : txt;
  $('srcText').title = txt;
  updateInputBar();
}
$('sourceSel').addEventListener('change', async (e) => {
  try { await useSource(e.target.value); } catch (err) {
    if (isSuperseded(err)) return; // inzwischen andere Quelle gewählt
    toast(errorText(err)); $('sourceSel').value = ui.srcVal || 'none'; updateSrcText();
  }
});
$('sourceFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await ensureStarted(); await engine.loadFile(f); await engine.useFile(); $('sourceSel').value = 'file'; ui.srcVal = 'file'; updateSrcText(); toast(f.name + ' läuft in Schleife'); } catch (err) { toast('Datei konnte nicht gelesen werden'); }
});
const isSuperseded = (err) => !!err && err.name === 'SupersededError';
function errorText(err) {
  if (err && err.name === 'NotAllowedError') return 'Zugriff auf Audio-Eingänge wurde verweigert oder ist in dieser Ansicht gesperrt';
  if (err && err.name === 'NotFoundError') return 'Kein Audio-Eingang gefunden';
  if (err && err.name === 'NotReadableError') return 'Das Gerät ist belegt oder lässt sich nicht öffnen (anderes Programm schließen?)';
  return (err && err.message) || String(err);
}
document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', async () => {
  try {
    await useSource(b.dataset.start);
    $('startOverlay').hidden = true;
  } catch (err) {
    if (isSuperseded(err)) return;
    const el = $('startError'); el.hidden = false; el.textContent = errorText(err);
  }
}));
$('startFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    await ensureStarted(); await engine.loadFile(f); await engine.useFile();
    $('sourceSel').value = 'file'; ui.srcVal = 'file'; updateSrcText(); $('startOverlay').hidden = true; toast(f.name + ' läuft in Schleife');
  } catch (err) { const el = $('startError'); el.hidden = false; el.textContent = 'Datei konnte nicht gelesen werden'; }
});
// Drag & Drop einer Audiodatei
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f || !f.type.startsWith('audio')) return;
  try { await ensureStarted(); await engine.loadFile(f); await engine.useFile(); $('sourceSel').value = 'file'; ui.srcVal = 'file'; updateSrcText(); $('startOverlay').hidden = true; toast(f.name + ' läuft in Schleife'); } catch (_) { toast('Datei konnte nicht gelesen werden'); }
});

$('inGain').addEventListener('input', (e) => engine.ctx && engine.setInputGain(Number(e.target.value)));
$('outGain').addEventListener('input', (e) => engine.ctx && engine.setMaster(Number(e.target.value)));

/* ---------------- Aufnahme ---------------- */
$('recBtn').addEventListener('click', async () => {
  const btn = $('recBtn');
  if (!engine.recorder) {
    try {
      await ensureStarted();
      engine.startRecording(); btn.classList.add('is-on'); toast('Aufnahme läuft');
    } catch (err) { toast(err && err.message ? err.message : 'Aufnahme nicht möglich'); }
  } else {
    const blob = await engine.stopRecording(); btn.classList.remove('is-on');
    if (blob) saveRecording(blob);
  }
});
async function saveRecording(blob) {
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
  if (await download(blob, `da_orbit-${stamp()}.${ext}`)) toast('Aufnahme gespeichert');
}

/* ---------------- Initialisierung ---------------- */
selector.select(params.effect, params.variation, false);
selector.setRev(!!params.effRev);
updateTimeDisplay(); updateFxInfo(); renderSlots(); setShiftVisual(); updateFootswitchUI();
$('bpmText').textContent = Math.round(ui.bpm) + ' BPM';
midi.channel = global.midiChannel | 0;
// Für Tests und Konsolen-Experimente
window.daOrbit = { engine, params, ui, store, midi, selectEffect, setHold, setBypass, setLooperMode, savePreset, loadPreset };
