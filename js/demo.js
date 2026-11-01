// Eingebaute Demo-Signale (werden im Browser synthetisiert, keine Samples nötig)

export const DEMO_BPM = 96;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Gezupfte Saiten (Karplus-Strong) – Arpeggio über Am – F – C – G
function plucks(sr) {
  const beat = 60 / DEMO_BPM, bars = 4, len = Math.floor(sr * beat * 4 * bars);
  const L = new Float32Array(len), R = new Float32Array(len);
  const r = rng(42);
  const chords = [[57, 60, 64, 69, 72], [53, 57, 60, 65, 69], [48, 55, 60, 64, 67], [55, 59, 62, 67, 71]];
  const pattern = [0, 2, 3, 4, 3, 2, 1, 3];
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar];
    for (let s = 0; s < 8; s++) {
      if (bar === 3 && s >= 6) continue;
      const note = ch[pattern[s]] + (s === 4 && bar % 2 ? 12 : 0);
      const t0 = Math.floor(((bar * 4) + s * 0.5) * beat * sr);
      const f = midi(note);
      const period = sr / f;
      const N = Math.floor(period);
      const buf = new Float32Array(N + 1);
      for (let j = 0; j <= N; j++) buf[j] = r() * 2 - 1;
      // leicht gedämpftes Anregungsrauschen
      for (let j = 1; j <= N; j++) buf[j] = 0.6 * buf[j] + 0.4 * buf[j - 1];
      const dur = Math.floor(sr * 1.6);
      let idx = 0;
      const pan = 0.5 + (pattern[s] - 2) * 0.12;
      const vel = 0.32 + r() * 0.08;
      for (let j = 0; j < dur && t0 + j < len; j++) {
        const a = buf[idx], b = buf[(idx + 1) % N];
        const v = 0.5 * (a + b) * 0.9985;
        buf[idx] = v; idx = (idx + 1) % N;
        const env = j < 24 ? j / 24 : 1;
        L[t0 + j] += v * vel * env * (1 - pan) * 1.4;
        R[t0 + j] += v * vel * env * pan * 1.4;
      }
    }
  }
  return [L, R];
}

// E-Piano-artige Akkorde (FM) mit Melodie
function keys(sr) {
  const beat = 60 / DEMO_BPM, bars = 4, len = Math.floor(sr * beat * 4 * bars);
  const L = new Float32Array(len), R = new Float32Array(len);
  const chords = [[50, 57, 60, 65], [46, 53, 58, 62], [48, 55, 59, 64], [45, 52, 57, 60]];
  const mel = [[72, 0], [74, 1.5], [76, 2], [77, 3], [76, 4.5], [74, 6], [72, 7], [71, 8.5], [72, 10], [74, 12], [76, 13.5], [79, 14]];
  const note = (m, t, d, vel, pan) => {
    const f = midi(m), t0 = Math.floor(t * sr), n = Math.floor(d * sr);
    for (let j = 0; j < n && t0 + j < len; j++) {
      const tt = j / sr;
      const env = Math.min(1, j / 60) * Math.exp(-tt * 2.2);
      const modEnv = Math.exp(-tt * 6);
      const s = Math.sin(2 * Math.PI * f * tt + 1.6 * modEnv * Math.sin(2 * Math.PI * f * tt));
      const rel = j > n - 800 ? (n - j) / 800 : 1;
      const v = s * env * vel * rel;
      L[t0 + j] += v * (1 - pan); R[t0 + j] += v * pan;
    }
  };
  for (let bar = 0; bar < bars; bar++) {
    for (const hit of [0, 2.5]) {
      chords[bar].forEach((m, i) => note(m, (bar * 4 + hit) * beat + i * 0.012, beat * 2.4, 0.11, 0.35 + i * 0.1));
    }
  }
  for (const [m, b] of mel) note(m, b * beat, beat * 1.4, 0.16, 0.55);
  return [L, R];
}

// Kleiner Beat (Kick, Snare, Hats) für Glitch-Effekte
function beat(sr) {
  const bt = 60 / DEMO_BPM, bars = 2, len = Math.floor(sr * bt * 4 * bars);
  const L = new Float32Array(len), R = new Float32Array(len);
  const r = rng(7);
  const add = (t, fn, dur, pan = 0.5) => {
    const t0 = Math.floor(t * sr), n = Math.floor(dur * sr);
    for (let j = 0; j < n && t0 + j < len; j++) { const v = fn(j / sr); L[t0 + j] += v * (1 - pan) * 2; R[t0 + j] += v * pan * 2; }
  };
  const kick = (t) => { let ph = 0; let last = 0; return (tt) => { const f = 45 + 120 * Math.exp(-tt * 30); ph += 2 * Math.PI * f / sr; last = Math.sin(ph) * Math.exp(-tt * 7) * 0.5; return last; }; };
  const snare = () => { let lp = 0; return (tt) => { const nz = r() * 2 - 1; lp += (nz - lp) * 0.5; return (lp * 0.3 * Math.exp(-tt * 18) + Math.sin(2 * Math.PI * 190 * tt) * 0.18 * Math.exp(-tt * 25)); }; };
  const hat = (open) => { let hp = 0, prev = 0; return (tt) => { const nz = r() * 2 - 1; hp = 0.85 * (hp + nz - prev); prev = nz; return hp * 0.07 * Math.exp(-tt * (open ? 9 : 45)); }; };
  for (let bar = 0; bar < bars; bar++) {
    const o = bar * 4 * bt;
    for (const k of [0, 1.75, 2.5]) add(o + k * bt, kick(), 0.5);
    for (const s of [1, 3]) add(o + s * bt, snare(), 0.3, 0.52);
    for (let h = 0; h < 8; h++) add(o + h * 0.5 * bt, hat(h === 7), h === 7 ? 0.3 : 0.08, 0.65);
    // kleine Bassfigur
    const bass = [[0, 40], [0.75, 40], [1.5, 43], [2.5, 38], [3.25, 45]];
    for (const [b, m] of bass) {
      const f = midi(m);
      add(o + b * bt, (tt) => Math.sin(2 * Math.PI * f * tt) * 0.16 * Math.exp(-tt * 4) * Math.min(1, tt * 400), 0.45, 0.45);
    }
  }
  return [L, R];
}

export const DEMOS = [
  { id: 'plucks', name: 'Demo: Zupf-Arpeggio', gen: plucks },
  { id: 'keys', name: 'Demo: E-Piano', gen: keys },
  { id: 'beat', name: 'Demo: Beat', gen: beat },
];

export function makeDemoBuffer(ctx, id) {
  const d = DEMOS.find((x) => x.id === id) || DEMOS[0];
  const [L, R] = d.gen(ctx.sampleRate);
  const buf = ctx.createBuffer(2, L.length, ctx.sampleRate);
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  return buf;
}
