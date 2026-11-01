// DSP-Test: alle 44 Algorithmen, Looper, Hold und Bypass offline durchrechnen.
// Aufruf: node tests/dsp-test.mjs
import { loadProcessor, send, makeTestSignal, run, rms, hasNaN, peak } from './harness.mjs';

const SR = 48000;
const NAMES = ['MOSAIC', 'SEQ', 'GLIDE', 'HAZE', 'TUNNEL', 'STRUM', 'BLOCKS', 'INTERRUPT', 'ARP', 'PATTERN', 'WARP'];
const Proc = await loadProcessor(SR);
const input = makeTestSignal(SR, 8);
const inRms = rms(input);
let failures = 0;
const fail = (msg) => { failures++; console.log('  FEHLER: ' + msg); };

console.log(`Eingang RMS ${inRms.toFixed(4)}`);
console.log('Effekt       Var  Wet/In   Peak   Ø ms/Block  max ms  Stimmen');
const proc = new Proc();
const rows = [];
for (let fx = 0; fx < 11; fx++) {
  for (let va = 0; va < 4; va++) {
    send(proc, { type: 'panic' });
    send(proc, { type: 'params', values: { effect: fx, variation: va, mix: 1, space: 0, activity: 0.6, repeats: 0.5, shape: 0.45, filter: 1, effVol: 0.5, modDepth: 0 } });
    let maxVoices = 0;
    const res = run(proc, input, 128, () => { const c = proc.countVoices(); if (c > maxVoices) maxVoices = c; });
    const wetRms = rms(res.outL, SR * 1, input.length);
    const ratio = wetRms / inRms;
    const pk = Math.max(peak(res.outL), peak(res.outR));
    rows.push({ fx, va, ratio });
    console.log(`${NAMES[fx].padEnd(12)} ${'ABCD'[va]}   ${ratio.toFixed(2).padStart(6)}  ${pk.toFixed(2).padStart(5)}  ${res.avgMs.toFixed(3).padStart(9)}  ${res.maxMs.toFixed(2).padStart(6)}  ${String(maxVoices).padStart(4)}`);
    if (hasNaN(res.outL) || hasNaN(res.outR)) fail(`${NAMES[fx]} ${'ABCD'[va]}: NaN im Ausgang`);
    if (ratio < 0.08) fail(`${NAMES[fx]} ${'ABCD'[va]}: Effekt zu leise (${ratio.toFixed(3)})`);
    if (res.avgMs > 1.5) fail(`${NAMES[fx]} ${'ABCD'[va]}: zu langsam (${res.avgMs.toFixed(2)} ms/Block)`);
  }
}
// Durchschnittlicher Pegel je Effekt (für WET_NORM)
const avg = [];
for (let fx = 0; fx < 11; fx++) {
  const r = rows.filter(x => x.fx === fx).map(x => x.ratio);
  avg.push(r.reduce((a, b) => a + b, 0) / r.length);
}
console.log('\nØ Wet/In je Effekt: ' + avg.map((v, i) => NAMES[i] + '=' + v.toFixed(2)).join(' '));

/* ---- Looper: Aufnahme + Wiedergabe ---- */
{
  console.log('\nLooper-Test');
  const p = new Proc();
  send(p, { type: 'params', values: { mix: 0, space: 0, effect: 0, loopLevel: Math.sqrt(1 / 1.5) } });
  send(p, { type: 'looperOpts', values: { pre: false, fadeShape: 3 } });
  const sig = makeTestSignal(SR, 4, 7);
  const silence = new Float32Array(SR * 2);
  const both = new Float32Array(sig.length + silence.length);
  both.set(sig); both.set(silence, sig.length);
  // Aufnahme starten bei Block 0, schließen nach 2 s
  const closeBlock = Math.floor(2 * SR / 128);
  send(p, { type: 'looper', cmd: 'main' });
  const res = run(p, both, 128, (b) => { if (b === closeBlock) send(p, { type: 'looper', cmd: 'main' }); });
  const st = p.lp;
  console.log(`  Zustand ${st.st} (2=PLAY), Länge ${(st.len / SR).toFixed(3)} s`);
  if (st.st !== 2) fail('Looper spielt nach Aufnahme nicht');
  if (Math.abs(st.len / SR - 2.0) > 0.01) fail('Looper-Länge falsch');
  // In der Stille (ab 4 s) muss der Loop hörbar sein und dem Original ähneln
  const a = res.outL.subarray(4 * SR + 1000, 5 * SR);
  const loopRms = rms(a);
  console.log(`  Loop-RMS in der Stille: ${loopRms.toFixed(4)} (Original ${rms(sig, 1000, SR).toFixed(4)})`);
  if (loopRms < 0.02) fail('Loop nicht hörbar');
  // Undo/Overdub
  send(p, { type: 'looper', cmd: 'main' }); // -> DUB
  if (p.lp.st !== 3) fail('Overdub startet nicht');
  send(p, { type: 'looper', cmd: 'undo' });
  if (p.lp.dubOn) fail('Undo schaltet Overdub nicht stumm');
  send(p, { type: 'looper', cmd: 'erase' });
  if (p.lp.st !== 0) fail('Löschen funktioniert nicht');
  // Quantisierung
  send(p, { type: 'bpm', bpm: 120 });
  send(p, { type: 'looperOpts', values: { quant: true } });
  send(p, { type: 'looper', cmd: 'main' });
  run(p, makeTestSignal(SR, 1.1, 3), 128);
  send(p, { type: 'looper', cmd: 'main' });
  console.log(`  quantisierte Länge bei 120 BPM aus 1.1 s: ${(p.lp.len / SR).toFixed(3)} s (erwartet 1.0)`);
  if (Math.abs(p.lp.len / SR - 1.0) > 0.002) fail('Quantisierung falsch');
}

/* ---- Hold ---- */
{
  console.log('\nHold-Test');
  const p = new Proc();
  send(p, { type: 'params', values: { effect: 0, variation: 0, mix: 1, space: 0, activity: 0.3, repeats: 0.6 } });
  const sig = makeTestSignal(SR, 3, 11);
  const silence = new Float32Array(SR * 3);
  run(p, sig, 128);
  send(p, { type: 'hold', on: true });
  const res = run(p, silence, 128);
  const r = rms(res.outL, SR, 3 * SR);
  console.log(`  Ausgang bei Stille mit Hold: RMS ${r.toFixed(4)}`);
  if (r < 0.01) fail('Hold hält kein Material');
  send(p, { type: 'hold', on: false });
  const res2 = run(p, new Float32Array(SR * 6), 128);
  const r2 = rms(res2.outL, 5 * SR, 6 * SR);
  console.log(`  nach Hold-Ende und Stille: RMS ${r2.toFixed(5)}`);
  if (r2 > 0.01) fail('Effekt klingt nach Hold nicht aus');
}

/* ---- Bypass ---- */
{
  console.log('\nBypass-Test');
  const p = new Proc();
  send(p, { type: 'params', values: { effect: 9, variation: 0, mix: 0.5, space: 0.5, repeats: 0.8, bypassStyle: 0 } });
  const sig = makeTestSignal(SR, 2, 5);
  send(p, { type: 'bypass', on: true });
  const res = run(p, sig, 128);
  let maxDiff = 0;
  for (let i = SR * 0.1; i < sig.length; i++) maxDiff = Math.max(maxDiff, Math.abs(res.outL[i] - Math.max(-1, Math.min(1, sig[i] * 1.6))));
  console.log(`  Abweichung Bypass ohne Trails vs. Eingang: ${maxDiff.toFixed(5)}`);
  if (maxDiff > 0.02) fail('Bypass ist nicht transparent');
}

/* ================= Robustheit, Echtzeit, Knackser ================= */
const sine = (sr, sec, f, a, ph = 0) => { const o = new Float32Array(Math.floor(sr * sec)); for (let i = 0; i < o.length; i++) o[i] = a * Math.sin(2 * Math.PI * f * i / sr + ph); return o; };
// Knack-Maß: größte zweite Differenz. Ein glatter Sinus liegt bei A·(2πf/SR)², ein Sprung beim Vielfachen davon.
const click = (a, from = 1, to = a.length - 1) => { let m = 0; for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i + 1] - 2 * a[i] + a[i - 1])); return m; };
const B128 = (x) => Math.floor(x / 128) * 128; // Teilstücke blockgenau schneiden, sonst springt das Testsignal selbst
function capture(p) { // alle Nachrichten des Prozessors mitschneiden
  const msgs = [];
  p.port.postMessage = (m) => { if (m.type !== 'state') msgs.push(m); };
  return msgs;
}
const silenceBlock = new Float32Array(128);
const blocks = (p, k) => { for (let j = 0; j < k; j++) run(p, silenceBlock, 128); };

/* ---- Ungültige Parameter (z. B. aus einer kaputten Preset-Datei) ---- */
{
  console.log('\nUngültige Parameter');
  const p = new Proc();
  let threw = null;
  try {
    send(p, { type: 'params', values: { mix: NaN, filter: 'x', effect: 99, variation: 7, reverbMode: -5, space: Infinity, time: null, ['__proto__']: { evil: 1 }, foo: 3 } });
    send(p, { type: 'looperOpts', values: { len: 1e9, st: 2, pos: NaN, pre: 1, fadeShape: 17 } });
    send(p, { type: 'bpm', bpm: NaN });
    send(p, { type: 'params', values: undefined });
    send(p, { type: 'looper', cmd: { toString: null } }); send(p, { type: 'setLoop', L: 'x' }); send(p, { type: 'getLoop' });
    send(p, null);
  } catch (e) { threw = e; }
  if (threw) fail('Nachricht mit ungültigen Werten wirft: ' + threw.message);
  const res = run(p, input.subarray(0, SR * 2), 128);
  console.log(`  effect=${p.p.effect} variation=${p.p.variation} mix=${p.p.mix} bpm=${p.bpm} lp.len=${p.lp.len} fadeShape=${p.lp.fadeShape}`);
  if (hasNaN(res.outL) || hasNaN(res.outR)) fail('NaN im Ausgang nach ungültigen Parametern');
  if (p.p.effect !== 10 || p.p.variation !== 3) fail('Effekt/Variante nicht begrenzt');
  if (p.lp.len !== 0 || p.lp.st !== 0) fail('looperOpts überschreibt Looper-Zustand');
  if (!(p.bpm > 0)) fail('Tempo ungültig');
  if (Object.getPrototypeOf(p.p) !== Object.prototype || 'foo' in p.p) fail('Unbekannte Schlüssel landen im Parameterobjekt');
  if (rms(res.outL, SR, 2 * SR) < 0.005) fail('Kein Ausgang nach ungültigen Parametern');
}

/* ---- NaN-Notbremse ---- */
{
  console.log('\nNaN-Notbremse');
  const p = new Proc();
  const msgs = capture(p);
  send(p, { type: 'params', values: { effect: 9, mix: 0.5, space: 0.5 } });
  run(p, input.subarray(0, SR), 128);
  p.sm.mixD = NaN; p.space.lp[0] = NaN; // Zustand absichtlich vergiften
  const res = run(p, input.subarray(SR, SR * 3), 128);
  const tail = res.outL.subarray(SR * 0.5);
  console.log(`  recovered-Meldungen: ${msgs.filter((m) => m.type === 'recovered').length}, NaN danach: ${hasNaN(tail)}, RMS danach ${rms(tail).toFixed(4)}`);
  if (hasNaN(res.outL)) fail('NaN gelangt in den Ausgang');
  if (!msgs.some((m) => m.type === 'recovered')) fail('Keine recovered-Meldung');
  if (rms(tail) < 0.005) fail('Kein Klang nach der Notbremse');
}

/* ---- Delay-Feedback im Takt (früher +128 Samples je Wiederholung) ---- */
{
  console.log('\nFeedback-Timing PATTERN');
  const p = new Proc();
  send(p, { type: 'bpm', bpm: 120 });
  send(p, { type: 'params', values: { effect: 9, variation: 0, activity: 0, repeats: 0.9, mix: 1, space: 0, filter: 1, resonance: 0, modDepth: 0, time: 0.42, effVol: 0.5 } });
  const U = 0.5 * SR, t0 = Math.floor(0.25 * SR);
  const imp = new Float32Array(Math.floor(4 * SR)); imp[t0] = 0.9;
  const res = run(p, imp, 128);
  const errs = [];
  for (let k = 1; k <= 6; k++) {
    const c = t0 + k * U; let best = 0, at = -1;
    for (let i = c - 1500; i < c + 1500; i++) { const v = Math.abs(res.outL[i]) + Math.abs(res.outR[i]); if (v > best) { best = v; at = i; } }
    errs.push(at - c);
  }
  console.log(`  Abweichung der Wiederholungen 1–6 vom Raster (Samples): ${errs.join(', ')}`);
  // die Feedback-Dämpfung verschmiert den Impuls um wenige Samples; ohne Fix wären es 128, 256, 384 …
  if (errs.some((e, k) => Math.abs(e) > 2 + k)) fail('Delay-Wiederholungen laufen aus dem Takt');
}

/* ---- Loop-Export in Stücken (früher: 23 MB Kopie in einem Audio-Block) ---- */
{
  console.log('\nLoop-Export');
  const p = new Proc();
  const msgs = capture(p);
  send(p, { type: 'params', values: { mix: 0, space: 0 } });
  send(p, { type: 'looperOpts', values: { fadeShape: 3 } });
  send(p, { type: 'looper', cmd: 'main' });
  run(p, makeTestSignal(SR, 3.2, 21), 128);
  send(p, { type: 'looper', cmd: 'main' });
  const len = p.lp.len;
  let t = performance.now();
  send(p, { type: 'getLoop', id: 7 });
  const dtMsg = performance.now() - t;
  let worst = 0;
  for (let j = 0; j < 40; j++) { t = performance.now(); run(p, silenceBlock, 128); worst = Math.max(worst, performance.now() - t); }
  const chunks = msgs.filter((m) => m.type === 'loopChunk' && m.id === 7);
  const done = msgs.find((m) => m.type === 'loopData' && m.id === 7);
  const L = new Float32Array(done ? done.len : 0);
  for (const c of chunks) L.set(c.L, c.off);
  let diff = 0; for (let j = 0; j < L.length; j++) diff = Math.max(diff, Math.abs(L[j] - p.lbL[j]));
  console.log(`  ${chunks.length} Stücke, Länge ${done && done.len} (Loop ${len}), Abweichung ${diff}, getLoop ${dtMsg.toFixed(3)} ms, Block max ${worst.toFixed(3)} ms`);
  if (!done || done.len !== len) fail('Export unvollständig');
  if (diff > 0) fail('Exportierte Daten weichen ab');
  if (dtMsg > 1) fail('getLoop blockiert den Audio-Thread');
  // Erneuter Export während des Löschens → Abbruch statt Datenmüll
  msgs.length = 0;
  send(p, { type: 'getLoop', id: 8 });
  run(p, silenceBlock, 128);
  send(p, { type: 'looper', cmd: 'erase' });
  blocks(p, 3);
  const ab = msgs.find((m) => m.type === 'loopData' && m.id === 8);
  if (!ab || ab.len !== 0) fail('Export nach Löschen nicht abgebrochen');
}

/* ---- Loop-Import in Stücken + Nahtblende ---- */
{
  console.log('\nLoop-Import');
  const p = new Proc();
  const n = Math.floor(10 * SR);
  const L = sine(SR, 10, 330, 0.5, 1), R = sine(SR, 10, 440, 0.5, 1);
  const t = performance.now();
  send(p, { type: 'setLoop', L, R });
  const dt = performance.now() - t;
  send(p, { type: 'looper', cmd: 'main' }); // während des Ladens ignoriert (darf keine Aufnahme starten)
  if (p.lp.st === 1) fail('Looper-Befehl während des Ladens startet eine Aufnahme');
  let k = 0; while (p.loading && k < 1000) { run(p, silenceBlock, 128); k++; }
  console.log(`  geladen nach ${k} Blöcken, setLoop ${dt.toFixed(3)} ms, Zustand ${p.lp.st}, Länge ${p.lp.len}, Naht ${p.lbL[0].toFixed(4)}/${p.lbL[n - 1].toFixed(4)}`);
  if (p.lp.st !== 4 || p.lp.len !== n) fail('Loop nicht geladen');
  if (p.lbL[0] !== 0 || p.lbL[n - 1] !== 0) fail('Keine Nahtblende beim Import');
  if (Math.abs(p.lbR[n >> 1] - R[n >> 1]) > 1e-6) fail('Importierte Daten weichen ab');
  if (dt > 1) fail('setLoop blockiert den Audio-Thread');
}

/* ---- Looper ohne Knackser: Löschen, Stopp ohne Fade, neue Aufnahme, Undo/Redo ---- */
{
  console.log('\nLooper-Knackser (max. 2. Differenz, Grenze 0.006; glatter Sinus ≈ 0.001)');
  const f = 220, A = 0.3, LIMIT = 0.006; // Summe aus Loop + Overdub bleibt unter dem Soft-Clip-Knie
  const setup = () => {
    const p = new Proc();
    send(p, { type: 'params', values: { mix: 0, space: 0, loopLevel: Math.sqrt(1 / 1.5) } });
    send(p, { type: 'looperOpts', values: { fadeShape: 3 } });
    send(p, { type: 'looper', cmd: 'main' });
    run(p, sine(SR, 1, f, A), 128);
    send(p, { type: 'looper', cmd: 'main' }); // → Wiedergabe
    run(p, new Float32Array(B128(SR * 0.3)), 128);
    return p;
  };
  const check = (name, p, cmd) => {
    const before = run(p, new Float32Array(128 * 5), 128);
    send(p, { type: 'looper', cmd });
    const after = run(p, new Float32Array(128 * 20), 128);
    const all = new Float32Array(before.outL.length + after.outL.length);
    all.set(before.outL); all.set(after.outL, before.outL.length);
    const c = click(all);
    console.log(`  ${name}: ${c.toFixed(4)}`);
    if (c > LIMIT) fail(`${name} knackt`);
  };
  check('Löschen', setup(), 'erase');
  check('Stopp ohne Fade', setup(), 'stop');
  check('Neue Aufnahme', setup(), 'rec');
  // Overdub + Undo/Redo
  const p = setup();
  send(p, { type: 'looper', cmd: 'main' }); // Overdub
  run(p, sine(SR, 1, f * 1.5, A, 0.3), 128);
  send(p, { type: 'looper', cmd: 'main' }); // Wiedergabe
  run(p, new Float32Array(B128(SR * 0.4)), 128);
  check('Undo', p, 'undo');
  check('Redo', p, 'undo');
  // Undo → neuer Overdub: alte Ebene wird stückweise geleert und ist danach weg
  send(p, { type: 'looper', cmd: 'undo' });
  send(p, { type: 'looper', cmd: 'main' }); // Overdub über verworfener Ebene
  blocks(p, 60);
  let rest = 0; for (let j = 0; j < p.lp.len; j++) rest = Math.max(rest, Math.abs(p.ldL[j]));
  console.log(`  Overdub-Ebene nach Undo + neuem Overdub (Stille): max ${rest.toFixed(5)}`);
  if (rest > 1e-6) fail('Verworfene Overdub-Ebene wurde nicht geleert');
}

/* ---- Hold ohne Knackser beim Ein-/Ausschalten ---- */
{
  console.log('\nHold-Überblendung');
  const p = new Proc();
  send(p, { type: 'params', values: { effect: 0, mix: 1, space: 0 } });
  const s = sine(SR, 3, 317.3, 0.5); // nicht phasengleich zur Hold-Länge (0,6 s), sonst fiele ein Sprung nicht auf
  const a = B128(SR * 1.37), b = B128(SR * 2.2), c = B128(SR * 2.6);
  run(p, s.subarray(0, a), 128);
  const w0 = p.w;
  send(p, { type: 'hold', on: true });
  run(p, s.subarray(a, b), 128);
  const w1 = p.w;
  send(p, { type: 'hold', on: false });
  run(p, s.subarray(b, c), 128);
  const M = p.hL.length - 1;
  const clickAt = (w) => { let m = 0; for (let k = -400; k < 400; k++) { const i = (w + k) & M; m = Math.max(m, Math.abs(p.hL[(i + 1) & M] - 2 * p.hL[i] + p.hL[(i - 1) & M])); } return m; };
  const c0 = clickAt(w0), c1 = clickAt(w1);
  console.log(`  2. Differenz im Verlaufspuffer: Hold an ${c0.toFixed(4)}, Hold aus ${c1.toFixed(4)}`);
  if (c0 > 0.006 || c1 > 0.006) fail('Hold knackt beim Umschalten');
}

/* ---- Stimmenvergabe: bei vollem Pool weich ausblenden ---- */
{
  console.log('\nStimmenvergabe');
  const p = new Proc();
  for (let j = 0; j < 92; j++) { const v = p.voices[j]; v.reset(); v.active = true; v.dur = SR * 10; v.amp = 1; v.gain = 0.5 + j / 200; }
  const v = p.allocVoice();
  const fading = p.voices.filter((x) => x.kill > 0).length;
  console.log(`  freie Stimme: ${!v.active}, weich ausgeblendet: ${fading}`);
  if (v.active) fail('Aktive Stimme wurde hart übernommen, obwohl noch Stimmen frei sind');
  if (fading !== 1) fail('Leiseste Stimme wird nicht vorsorglich ausgeblendet');
}

/* ---- Hall-Typ-Wechsel ohne Sprung ---- */
{
  console.log('\nHall-Typ-Wechsel');
  const p = new Proc();
  send(p, { type: 'params', values: { mix: 0, space: 1, reverbMode: 0 } });
  const s = sine(SR, 3, 300, 0.08); // leise, damit der Soft-Clip nicht mitmisst
  const a = B128(SR * 1.5);
  run(p, s.subarray(0, a), 128);
  const before = run(p, s.subarray(a, a + 1280), 128);
  send(p, { type: 'params', values: { reverbMode: 0.99 } });
  const after = run(p, s.subarray(a + 1280, a + 1280 + 2560), 128);
  // Ein Sprung zeigt sich sofort; danach ändert sich der Klang gewollt (andere Größe, Modulation)
  const c0 = click(before.outL), c1 = click(after.outL.subarray(0, 512));
  console.log(`  2. Differenz vorher ${c0.toFixed(4)}, direkt nach dem Wechsel ${c1.toFixed(4)}`);
  if (c1 > c0 * 3) fail('Hall-Typ-Wechsel knackt');
}

console.log(failures ? `\n${failures} Fehler` : '\nAlle Tests bestanden');
process.exit(failures ? 1 : 0);
