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

console.log(failures ? `\n${failures} Fehler` : '\nAlle Tests bestanden');
process.exit(failures ? 1 : 0);
