// Lädt den AudioWorklet-Prozessor in Node, indem die Worklet-Globals nachgebildet werden.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function loadProcessor(sr = 48000) {
  globalThis.sampleRate = sr;
  let Klass = null;
  globalThis.registerProcessor = (name, cls) => { Klass = cls; };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, sent: [], postMessage(m) { this.sent.push(m); if (this.sent.length > 50) this.sent.shift(); } };
    }
  };
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../js/orbit-processor.js');
  await import(pathToFileURL(file).href + '?t=' + Date.now());
  return Klass;
}

export function send(proc, msg) { proc.port.onmessage({ data: msg }); }

// Testsignal: gezupfte Töne (Karplus-Strong) mit Pausen
export function makeTestSignal(sr, seconds, seed = 1) {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const notes = [220, 261.63, 329.63, 392, 440, 523.25, 329.63, 293.66];
  let t = Math.floor(0.05 * sr), k = 0;
  while (t < n - sr * 0.5) {
    const f = notes[k % notes.length];
    const period = Math.round(sr / f);
    const buf = new Float32Array(period);
    for (let j = 0; j < period; j++) buf[j] = rnd() * 2 - 1;
    const len = Math.floor(sr * 0.6);
    let idx = 0;
    for (let j = 0; j < len && t + j < n; j++) {
      const a = buf[idx], b = buf[(idx + 1) % period];
      const v = 0.5 * (a + b) * 0.996;
      buf[idx] = v; idx = (idx + 1) % period;
      out[t + j] += v * 0.45;
    }
    k++;
    t += Math.floor(sr * (k % 4 === 0 ? 0.6 : 0.3));
  }
  return out;
}

export function run(proc, input, block = 128, onBlock) {
  const n = input.length;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const inBlock = new Float32Array(block);
  const oL = new Float32Array(block), oR = new Float32Array(block);
  let maxMs = 0, totalMs = 0, blocks = 0;
  for (let pos = 0; pos + block <= n; pos += block) {
    inBlock.set(input.subarray(pos, pos + block));
    const t0 = performance.now();
    proc.process([[inBlock, inBlock]], [[oL, oR]], {});
    const dt = performance.now() - t0;
    totalMs += dt; blocks++; if (dt > maxMs && blocks > 10) maxMs = dt;
    outL.set(oL, pos); outR.set(oR, pos);
    if (onBlock) onBlock(pos / block);
  }
  return { outL, outR, avgMs: totalMs / blocks, maxMs };
}

export function rms(a, from = 0, to = a.length) {
  let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
export function hasNaN(a) { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true; return false; }
export function peak(a) { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; }
