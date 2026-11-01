// Browser-Test mit Playwright/Chromium: App laden, Demo starten, alle Effekte durchschalten,
// Hold, Looper und Bypass bedienen, Screenshots erstellen.
// Aufruf: node tests/browser-test.mjs [ausgabe-ordner]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(root, 'tests', 'out');
mkdirSync(outDir, { recursive: true });
const PORT = 8765;

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

let failures = 0;
const fail = (m) => { failures++; console.log('FEHLER: ' + m); };
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.screenshot({ path: path.join(outDir, '01-start.png') });
  await page.click('[data-start="demo:plucks"]');
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ ctx: window.daOrbit.engine.ctx.state, sr: window.daOrbit.engine.ctx.sampleRate }));
  console.log('AudioContext', st);
  if (st.ctx !== 'running') fail('AudioContext läuft nicht');
  // Zustand der Engine abgreifen
  await page.evaluate(() => {
    window.__last = null;
    window.daOrbit.engine.addEventListener('state', (e) => { window.__last = e.detail; window.__maxOut = Math.max(window.__maxOut || 0, e.detail.peakL); });
  });
  await page.waitForTimeout(800);
  const s0 = await page.evaluate(() => window.__last && { peakIn: window.__last.peakIn, peakL: window.__last.peakL, voices: window.__last.voices.length / 4 });
  console.log('Zustand nach Start', s0);
  if (!s0) fail('Keine Zustandsmeldungen vom Worklet');
  await page.screenshot({ path: path.join(outDir, '02-running-dark.png') });

  // Alle Effekte und Varianten
  const names = ['MOSAIC', 'SEQ', 'GLIDE', 'HAZE', 'TUNNEL', 'STRUM', 'BLOCKS', 'INTERRUPT', 'ARP', 'PATTERN', 'WARP'];
  for (let fx = 0; fx < 11; fx++) {
    let maxV = 0, maxT = 0;
    for (let va = 0; va < 4; va++) {
      await page.evaluate(([f, v]) => window.daOrbit.selectEffect(f, v, true), [fx, va]);
      await page.evaluate(() => { window.__maxOut = 0; });
      for (let k = 0; k < 6; k++) {
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => window.__last && [window.__last.voices.length / 4, window.__last.taps.length / 3]);
        if (r) { maxV = Math.max(maxV, r[0]); maxT = Math.max(maxT, r[1]); }
      }
    }
    const out = await page.evaluate(() => window.__maxOut);
    console.log(`${names[fx].padEnd(10)} max. Stimmen ${maxV}, Taps ${maxT}, Ausgangsspitze ${out.toFixed(3)}`);
    if (maxV === 0 && maxT === 0) fail(`${names[fx]}: keine Aktivität`);
    if (fx === 5) await page.screenshot({ path: path.join(outDir, '03-strum.png') });
  }
  // Haze für Screenshot
  await page.evaluate(() => window.daOrbit.selectEffect(3, 1, true));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, '04-haze.png') });

  // Hold per Tastatur
  await page.keyboard.down('e'); await page.keyboard.up('e');
  await page.waitForTimeout(600);
  const hold = await page.evaluate(() => window.__last.hold);
  console.log('Hold aktiv:', hold);
  if (!hold) fail('Hold ließ sich nicht aktivieren');
  await page.keyboard.down('e'); await page.keyboard.up('e');

  // Shift-Ebene
  await page.keyboard.down('Shift');
  await page.waitForTimeout(150);
  const shiftLabel = await page.textContent('.knob[data-id="k7"] .knob-label');
  await page.screenshot({ path: path.join(outDir, '05-shift.png') });
  await page.keyboard.up('Shift');
  console.log('Raum-Regler mit Shift:', shiftLabel);
  if (!/Hall/.test(shiftLabel)) fail('Shift-Ebene zeigt nicht die Zweitfunktion');

  // Regler per Tastatur bedienen
  await page.focus('.knob[data-id="k1"] .knob-dial');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  const act = await page.evaluate(() => window.daOrbit.params.activity);
  console.log('Aktivität nach 5× Pfeil hoch:', act.toFixed(2));

  // Looper: einschalten, 2 s aufnehmen, abspielen, Overdub, Stopp
  await page.evaluate(() => window.daOrbit.selectEffect(9, 0, true));
  await page.keyboard.press('l');
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(2000);
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(700);
  let lp = await page.evaluate(() => window.__last.loop);
  console.log('Looper nach Aufnahme:', lp.st, lp.len.toFixed(2) + ' s');
  if (lp.st !== 2 || lp.len < 1.8) fail('Looper spielt nicht korrekt');
  await page.screenshot({ path: path.join(outDir, '06-looper.png') });
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(400);
  lp = await page.evaluate(() => window.__last.loop);
  if (lp.st !== 3) fail('Overdub startet nicht');
  await page.keyboard.down('e'); await page.keyboard.up('e');
  await page.waitForTimeout(600);
  lp = await page.evaluate(() => window.__last.loop);
  console.log('Looper nach Stopp:', lp.st);
  if (lp.st !== 4) fail('Looper stoppt nicht');

  // Preset speichern + laden
  await page.click('.slot >> nth=0', { modifiers: ['Shift'] });
  await page.waitForTimeout(500);
  const slotText = await page.textContent('.slot >> nth=0');
  console.log('Preset-Platz 1:', slotText);
  if (!/PATTE/.test(slotText)) fail('Preset wurde nicht gespeichert');

  // Bypass
  await page.keyboard.down('w'); await page.keyboard.up('w');
  await page.waitForTimeout(300);
  const byp = await page.isVisible('#bypChip');
  if (!byp) fail('Bypass-Anzeige fehlt');
  await page.keyboard.down('w'); await page.keyboard.up('w');

  // Hilfe und Einstellungen
  await page.click('#helpBtn'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '07-help.png') });
  await page.keyboard.press('Escape');
  await page.click('#settingsBtn'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '08-settings.png') });
  await page.keyboard.press('Escape');

  // Audio-Eingang (Fake-Gerät von Chromium): Leiste, Geräte- und Kanalwahl, Pegel, Trennen/Wiederverbinden
  await page.selectOption('#sourceSel', 'input');
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__maxIn = 0; window.daOrbit.engine.addEventListener('state', (e) => { window.__maxIn = Math.max(window.__maxIn, e.detail.peakIn); }); });
  await page.waitForTimeout(1600);
  const inp = await page.evaluate(() => {
    const e = window.daOrbit.engine;
    return {
      kind: e.sourceKind, info: e.inputInfo, route: e.inputRoute, maxIn: window.__maxIn,
      bar: !document.getElementById('inputBar').hidden,
      devs: [...document.querySelectorAll('#inDevice option')].map((o) => o.text),
      routes: [...document.querySelectorAll('#inRoute option')].map((o) => o.value),
      info2: document.getElementById('inInfo').textContent,
    };
  });
  console.log('Audio-Eingang:', inp.kind, inp.info && inp.info.label, '| Kanäle', inp.info && inp.info.channels, '| Route', inp.route, '| Pegel', inp.maxIn.toFixed(3));
  console.log('  Geräte:', inp.devs.join(' / '), '| Kanaloptionen:', inp.routes.join(' '), '| Info:', inp.info2);
  if (inp.kind !== 'input') fail('Audio-Eingang ließ sich nicht aktivieren');
  if (!inp.bar) fail('Eingangsleiste wird nicht angezeigt');
  if (!inp.devs.length) fail('Keine Geräte in der Liste');
  if (!inp.routes.length) fail('Keine Kanaloptionen');
  if (!(inp.maxIn > 0.001)) fail('Kein Eingangspegel vom Testgerät');
  await page.screenshot({ path: path.join(outDir, '11-input.png') });
  if (inp.routes.includes('1,1')) {
    await page.selectOption('#inRoute', '1,1');
    const r = await page.evaluate(() => window.daOrbit.engine.inputRoute);
    if (r.a !== 1 || r.b !== 1) fail('Kanalwahl wird nicht übernommen');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('da_orbit.input.v1')));
    console.log('  Gespeichert:', JSON.stringify(stored));
    if (!stored || !stored.routes || !Object.values(stored.routes).some((x) => x.a === 1)) fail('Kanalwahl wird nicht gespeichert');
  }
  if (inp.devs.length > 1) {
    const vals = await page.evaluate(() => [...document.querySelectorAll('#inDevice option')].map((o) => o.value));
    const cur = await page.evaluate(() => window.daOrbit.engine.inputInfo.deviceId);
    const other = vals.find((v) => v && v !== cur && v !== 'default');
    if (other) {
      await page.selectOption('#inDevice', other);
      await page.waitForTimeout(800);
      const now = await page.evaluate(() => window.daOrbit.engine.inputInfo && window.daOrbit.engine.inputInfo.deviceId);
      console.log('  Gerätewechsel:', now === other ? 'ok' : now);
      if (now !== other) fail('Gerätewechsel funktioniert nicht');
    }
  }
  // Gerät „abziehen“ und wieder „anstecken“
  await page.evaluate(() => window.daOrbit.engine.mediaStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForTimeout(200);
  const lost = await page.evaluate(() => ({ kind: window.daOrbit.engine.sourceKind, bar: !document.getElementById('inputBar').hidden, lost: document.getElementById('inputBar').classList.contains('is-lost') }));
  if (lost.kind !== 'none' || !lost.bar || !lost.lost) fail('Getrenntes Gerät wird nicht angezeigt ' + JSON.stringify(lost));
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await page.waitForTimeout(1000);
  const back = await page.evaluate(() => window.daOrbit.engine.sourceKind);
  console.log('  Nach Trennen/Wiederverbinden:', back);
  if (back !== 'input') fail('Gerät wird nicht automatisch wieder verbunden');
  // zurück zur Demo: Leiste verschwindet
  await page.selectOption('#sourceSel', 'demo:plucks');
  await page.waitForTimeout(300);
  if (await page.isVisible('#inputBar')) fail('Eingangsleiste bleibt bei Demo sichtbar');

  // Mehrkanal-Routing: Gerät mit 4 Kanälen simulieren (Pegel 0.1/0.2/0.4/0.8 je Kanal)
  const mc = await page.evaluate(async () => {
    const e = window.daOrbit.engine, ctx = e.ctx;
    const merger = ctx.createChannelMerger(4);
    [0.1, 0.2, 0.4, 0.8].forEach((g, i) => { const o = ctx.createOscillator(); const a = ctx.createGain(); a.gain.value = g; o.connect(a); a.connect(merger, 0, i); o.start(); });
    const dest = ctx.createMediaStreamDestination();
    const tr = dest.stream.getAudioTracks()[0], orig = tr.getSettings.bind(tr);
    tr.getSettings = () => ({ ...orig(), channelCount: 4 });
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    const sel = document.getElementById('sourceSel'); sel.value = 'input'; sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    e.source.disconnect(); merger.connect(e.inNodes.splitter); // MediaStreams tragen in Chromium nur 2 Kanäle
    const sp = ctx.createChannelSplitter(2), an = [ctx.createAnalyser(), ctx.createAnalyser()];
    e.inNodes.merger.connect(sp); sp.connect(an[0], 0); sp.connect(an[1], 1);
    const peak = async () => { await new Promise((r) => setTimeout(r, 200)); return an.map((x) => { const b = new Float32Array(x.fftSize); x.getFloatTimeDomainData(b); return Math.round(Math.max(...b.map(Math.abs)) * 100) / 100; }); };
    const out = { options: [...document.querySelectorAll('#inRoute option')].map((o) => o.value) };
    for (const v of ['2,3', '3,3', '0,1']) {
      const rs = document.getElementById('inRoute'); rs.value = v; rs.dispatchEvent(new Event('change'));
      out[v] = await peak();
    }
    return out;
  });
  console.log('Mehrkanal-Routing:', JSON.stringify(mc));
  if (mc.options.join(' ') !== '0,1 2,3 0,0 1,1 2,2 3,3') fail('Kanaloptionen für 4 Kanäle falsch');
  if (mc['2,3'].join() !== '0.4,0.8' || mc['3,3'].join() !== '0.8,0.8' || mc['0,1'].join() !== '0.1,0.2') fail('Kanalrouting falsch');

  // Quelle wechseln, während der Eingang noch angefragt wird: die spätere Wahl (Demo) muss gewinnen
  const race = await page.evaluate(async () => {
    const e = window.daOrbit.engine, sel = document.getElementById('sourceSel');
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { await new Promise((r) => setTimeout(r, 300)); return orig(c); };
    sel.value = 'input'; sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 50));
    sel.value = 'demo:beat'; sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    navigator.mediaDevices.getUserMedia = orig;
    return { kind: e.sourceKind, stream: !!e.mediaStream, sel: sel.value, bar: !document.getElementById('inputBar').hidden };
  });
  console.log('Quellenwechsel während der Freigabe:', JSON.stringify(race));
  if (race.kind !== 'demo' || race.stream || race.sel !== 'demo:beat' || race.bar) fail('Verspätete Eingangsfreigabe überschreibt die gewählte Demo');

  // Loop mit Preset speichern und wieder laden (Transfer in Stücken in beide Richtungen)
  const loopRt = await page.evaluate(async () => {
    const d = window.daOrbit, e = d.engine, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    e.post({ type: 'looper', cmd: 'erase' });
    e.post({ type: 'looper', cmd: 'rec' }); await wait(1500); e.post({ type: 'looper', cmd: 'play' }); await wait(300);
    const a = await e.getLoop();
    await d.savePreset(5);
    e.post({ type: 'looper', cmd: 'erase' }); await wait(200);
    await d.loadPreset(5); await wait(600);
    const b = await e.getLoop();
    let diff = 0; if (a && b) for (let i = 200; i < a.L.length - 200; i += 97) diff = Math.max(diff, Math.abs(a.L[i] - b.L[i]));
    return { lenA: a && a.L.length, lenB: b && b.L.length, sr: e.ctx.sampleRate, diff, slot: d.store.get(5) && d.store.get(5).hasLoop };
  });
  console.log('Loop über Preset:', JSON.stringify(loopRt));
  if (!loopRt.lenA || loopRt.lenA < loopRt.sr * 1.2) fail('Loop-Export liefert keinen vollständigen Loop');
  if (loopRt.lenB !== loopRt.lenA || loopRt.diff > 1e-4 || !loopRt.slot) fail('Loop wird über Preset nicht korrekt gespeichert/geladen');

  // Kaputte Preset-Datei importieren: keine Abstürze, Werte begrenzt
  const imp = await page.evaluate(async () => {
    const d = window.daOrbit;
    const bad = { app: 'da_orbit', version: 1, presets: new Array(16).fill(null) };
    bad.presets[0] = { name: 'Kaputt', params: { effect: 99, variation: -3, mix: 'x', filter: null, time: 7 }, looperOpts: { len: 1e9 } };
    bad.presets[1] = { params: 'nix' };
    bad.presets[2] = 42;
    d.store.importJSON(JSON.stringify(bad));
    await d.loadPreset(0);
    await new Promise((r) => setTimeout(r, 300));
    return { p: { ...d.params }, slots: [...document.querySelectorAll('.slot')].slice(0, 3).map((x) => x.textContent), out: window.__last && window.__last.peakL };
  });
  console.log('Import kaputter Presets:', JSON.stringify({ effect: imp.p.effect, variation: imp.p.variation, mix: imp.p.mix, time: imp.p.time, slots: imp.slots }));
  if (imp.p.effect !== 10 || imp.p.variation !== 0 || !(imp.p.mix >= 0 && imp.p.mix <= 1) || imp.p.time !== 1) fail('Importierte Presets werden nicht geprüft');
  if (!Number.isFinite(imp.out)) fail('Audio nach kaputtem Preset nicht mehr endlich');

  // MIDI-CC 5 (Teilung) im Tempo-Modus darf das Tempo nicht verstellen
  const cc5 = await page.evaluate(async () => {
    const d = window.daOrbit, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (d.params.timeMode !== 1) document.getElementById('timeModeBtn').click();
    await wait(200);
    const before = window.__last.bpm;
    d.midi.onMessage(new Uint8Array([0xb0, 5, 1]), performance.now());
    await wait(300);
    // Active Sensing darf nicht als Aktivität zählen
    d.midi.onMessage(new Uint8Array([0xfe]), performance.now());
    const act = document.getElementById('midiBtn').classList.contains('is-act');
    return { before, after: window.__last.bpm, timeMode: d.params.timeMode, act };
  });
  console.log('MIDI-CC 5 im Tempo-Modus:', JSON.stringify(cc5));
  if (Math.abs(cc5.after - cc5.before) > 0.5 || cc5.timeMode !== 0) fail('CC 5 verstellt das Tempo');
  if (cc5.act) fail('Active Sensing löst die MIDI-Aktivitätsanzeige aus');

  // Momentanes Hold: Fenster verliert den Fokus, während E gehalten wird → Hold muss enden
  await page.evaluate(() => {
    window.daOrbit.engine.post({ type: 'looper', cmd: 'erase' }); // Hold geht nur ohne Loop
    if (window.daOrbit.ui.looperMode) window.daOrbit.setLooperMode(false);
    const el = document.querySelector('#settingsDlg [data-g="holdMode"]'); el.value = '1'; el.dispatchEvent(new Event('change'));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
  });
  await page.waitForTimeout(200);
  await page.keyboard.down('e');
  await page.waitForTimeout(300);
  const heldOn = await page.evaluate(() => window.daOrbit.ui.hold);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(300);
  const heldAfter = await page.evaluate(() => ({ ui: window.daOrbit.ui.hold, dsp: window.__last.hold }));
  await page.keyboard.up('e');
  console.log('Momentanes Hold bei Fokusverlust:', heldOn, '→', JSON.stringify(heldAfter));
  if (!heldOn || heldAfter.ui || heldAfter.dsp) fail('Gehaltene Taste bleibt nach Fokusverlust hängen');

  if (errors.length) { console.log('Konsolenfehler:', errors); fail('Konsolenfehler vorhanden'); }

  // Hell + Mobil
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://localhost:${PORT}/`);
  await p2.click('[data-start="demo:plucks"]');
  await p2.waitForSelector('#startOverlay', { state: 'hidden' });
  await p2.selectOption('#sourceSel', 'demo:keys');
  await p2.waitForTimeout(1500);
  await p2.screenshot({ path: path.join(outDir, '09-mobile-light.png'), fullPage: true });
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('Horizontaler Überlauf mobil:', overflow);
  if (overflow > 1) fail('Horizontaler Überlauf auf dem Handy');
  await p2.selectOption('#sourceSel', 'input');
  await p2.waitForTimeout(800);
  const overflowIn = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await p2.screenshot({ path: path.join(outDir, '12-mobile-input.png') });
  console.log('Horizontaler Überlauf mobil mit Eingangsleiste:', overflowIn);
  if (overflowIn > 1) fail('Eingangsleiste läuft auf dem Handy über');
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const p3 = await ctx3.newPage();
  await p3.goto(`http://localhost:${PORT}/`);
  await p3.click('[data-start="demo:plucks"]');
  await p3.waitForSelector('#startOverlay', { state: 'hidden' });
  await p3.selectOption('#sourceSel', 'demo:beat');
  await p3.evaluate(() => window.daOrbit.selectEffect(7, 0, true));
  await p3.waitForTimeout(1800);
  await p3.screenshot({ path: path.join(outDir, '10-desktop-light.png') });
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} Fehler` : 'Browser-Test bestanden');
process.exit(failures ? 1 : 0);
