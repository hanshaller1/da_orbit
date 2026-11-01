/*
 * da_orbit – DSP-Kern (AudioWorkletProcessor)
 *
 * Signalfluss:
 *   Eingang ─┬─(PRE-Looper)─► Verlaufspuffer ─► Effekt-Engine (Stimmen + Delay-Taps)
 *            │                    ▲   (Hold friert den Puffer ein, Feedback schreibt zurück)
 *            │                    └─ Feedback
 *            │   Effekt ─► Pitch-Modulation ─► Resonanzfilter ─► Effekt-Vol
 *            └─► Dry ─(Mix)─► Summe ─(POST-Looper)─► Raum (Hall + Delay) ─► Bypass ─► Ausgang
 *
 * Alles läuft in diesem einen Prozessor, damit Timing (Tempo, Onsets, Looper)
 * samplegenau bleibt.
 */

const SR = sampleRate;
// Verlaufspuffer: mindestens ~42 s, auch bei 88,2/96 kHz (Zweierpotenz für Masken-Arithmetik)
const BUF_BITS = Math.max(21, Math.ceil(Math.log2(42 * SR)));
const BUF = 1 << BUF_BITS;
const MASK = BUF - 1;
const MAX_VOICES = 96;
const VOICE_RESERVE = 6;              // ab hier werden leise Stimmen weich ausgeblendet statt abgeschnitten
const NUM_TAPS = 8;
const HOLD_MAX = Math.floor(8 * SR);
const LOOP_MAX = Math.floor(60 * SR);
const SUBDIV = [4, 2, 1, 0.5, 0.25, 0.125];
const MOD_SIZE = 4096, MOD_MASK = MOD_SIZE - 1;
const TWO_PI = Math.PI * 2;
const DECLICK = Math.max(16, Math.round(0.006 * SR)); // kurze Blende gegen Knackser (~6 ms)
const XFER_CHUNK = 16384;             // Loop-Export/-Import: Samples pro Block (echtzeitsicher statt alles auf einmal)
const SWEEP_CHUNK = 65536;            // Overdub-Ebene leeren: Samples pro Block
const TAP_MIN = 256;                  // kürzeste Tap-Verzögerung; muss > Blockgröße sein (Feedback wird im Block geschrieben)
const DMIX = [0.22, 0.25, 0.3, 0.38]; // Delay-Anteil je Hall-Typ

// Erlaubte Parameter: alles Übrige ist 0..1, diese hier sind ganzzahlig mit Bereich
const PARAM_INT = { timeMode: [0, 1], effect: [0, 10], variation: [0, 3], effRev: [0, 1], mono: [0, 1], inputLine: [0, 1], bypassStyle: [0, 2] };
const LOOP_FLAGS = ['pre', 'quant', 'only', 'burst'];

const FX = { MOSAIC: 0, SEQ: 1, GLIDE: 2, HAZE: 3, TUNNEL: 4, STRUM: 5, BLOCKS: 6, INTERRUPT: 7, ARP: 8, PATTERN: 9, WARP: 10 };
// Pegelausgleich je Effekt (empirisch mit tests/dsp-test.mjs abgestimmt)
const WET_NORM = [2.0, 1.9, 0.9, 1.4, 1.8, 1.8, 1.5, 2.2, 1.25, 0.75, 0.9];

const L_EMPTY = 0, L_REC = 1, L_PLAY = 2, L_DUB = 3, L_STOP = 4;

const EXP_N = 2048, EXP_MAX = 16;
const EXP_TAB = new Float32Array(EXP_N + 2);
for (let i = 0; i <= EXP_N + 1; i++) EXP_TAB[i] = Math.exp(-i * EXP_MAX / EXP_N);
function fexp(u) { // exp(-u) für u >= 0
  if (u >= EXP_MAX) return 0;
  const x = u * (EXP_N / EXP_MAX), i = x | 0, f = x - i;
  return EXP_TAB[i] + (EXP_TAB[i + 1] - EXP_TAB[i]) * f;
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function softClip(x) { // linear bis 0.7, dann weich gegen 1
  const a = x < 0 ? -x : x;
  if (a <= 0.7) return x;
  const y = 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
  return x < 0 ? -y : y;
}
function rd(buf, p) { // lineare Interpolation im Ringpuffer, p in (-BUF, BUF)
  if (p < 0) p += BUF;
  const i0 = p | 0, f = p - i0, a = buf[i0];
  return a + (buf[(i0 + 1) & MASK] - a) * f;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Nur bekannte Schlüssel mit endlichen Zahlen übernehmen (Presets/Speicher können beliebige Werte enthalten;
// ein einziges NaN würde sonst die Glättungs- und Filterzustände dauerhaft lahmlegen)
function applyParams(p, values) {
  if (!values || typeof values !== 'object') return;
  for (const k of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
    let v = values[k];
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (!isNum(v)) continue;
    const r = PARAM_INT[k];
    p[k] = r ? clamp(Math.round(v), r[0], r[1]) : clamp(v, 0, 1);
  }
}
function applyLooperOpts(lp, values) {
  if (!values || typeof values !== 'object') return;
  for (const k of LOOP_FLAGS) if (k in values) lp[k] = !!values[k];
  if (isNum(values.order)) lp.order = clamp(Math.round(values.order), 0, 1);
  if (isNum(values.fadeShape)) lp.fadeShape = clamp(Math.round(values.fadeShape), 0, 3);
}

class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
}

/* Hüllkurve aus dem FORM-Regler: Rückwärts-Schwellen → Schwellen → weich → Gate → perkussiv */
const SHAPE_KEYS = [
  [0.00, 0.92, 0.04, 0],
  [0.20, 0.92, 0.04, 0],
  [0.45, 0.45, 0.45, 0],
  [0.65, 0.03, 0.03, 0],
  [0.82, 0.008, 0.06, 2.5],
  [1.00, 0.004, 0.03, 9],
];
function shapeParams(s, out) {
  let k = 0;
  while (k < SHAPE_KEYS.length - 2 && s > SHAPE_KEYS[k + 1][0]) k++;
  const a = SHAPE_KEYS[k], b = SHAPE_KEYS[k + 1];
  const t = clamp((s - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
  out.att = lerp(a[1], b[1], t);
  out.rel = lerp(a[2], b[2], t);
  out.perc = lerp(a[3], b[3], t);
  out.rev = s < 0.2;
  return out;
}

/* Form-Regler bei GLIDE: Verlauf des Pitch-Glides */
function glideShape(s) {
  if (s < 0.3) return { p: 3 - (s / 0.3) * 2, step: false, ping: false };
  if (s < 0.55) return { p: 1, step: false, ping: false };
  if (s < 0.75) return { p: 1 / (1 + ((s - 0.55) / 0.2) * 2), step: false, ping: false };
  if (s < 0.9) return { p: 1, step: true, ping: false };
  return { p: 1, step: false, ping: true };
}

class Voice {
  constructor() { this.active = false; this.reset(); }
  reset() {
    this.delay = 0; this.t = 0; this.dur = 1;
    this.start = 0; this.seg = 1; this.segCur = 1; this.phase = 0;
    this.rate = 1; this.dir = 1;
    this.glide = false; this.lr0 = 0; this.lr1 = 0; this.glideLen = 1; this.glideP = 1; this.glideStep = false; this.glidePing = false;
    this.gain = 1; this.pl = Math.SQRT1_2; this.pr = Math.SQRT1_2;
    this.att = 0.05; this.rel = 0.05; this.perc = 0;
    this.decay = 1; this.amp = 1; this.fadeIn = 64; this.fadeOut = 256;
    this.ftype = 0; this.f0 = 1000; this.f1 = 1000; this.fq = 0.707; this.flfoRate = 0; this.flfoDepth = 0; this.flfoPh = 0;
    this.a1 = 0; this.a2 = 0; this.a3 = 0; this.fk = 1;
    this.s1L = 0; this.s2L = 0; this.s1R = 0; this.s2R = 0;
    this.crushQ = 0; this.crushHold = 1; this.crushCnt = 0; this.chL = 0; this.chR = 0;
    this.smDepth = 0; this.smRate = 0; this.smPh = 0; this.smEnv = 0;
    this.level = 0;
    this.kill = 0; // > 0: Stimme wird gerade weich ausgeblendet (verbleibende Samples)
  }
}

class Tap {
  constructor() {
    this.on = false; this.fade = 0; this.gain = 0;
    this.d = SR * 0.5; this.dT = SR * 0.5;
    this.pl = Math.SQRT1_2; this.pr = Math.SQRT1_2;
    this.mode = 0; this.rate = 1; this.W = 0.08 * SR; this.ph = 0;
    this.xfRate = 0; this.xfPh = 0;
    this.ftype = 0; this.fc = 1000; this.q = 1; this.env = 0;
    this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1;
    this.s1L = 0; this.s2L = 0; this.s1R = 0; this.s2R = 0;
    this.level = 0;
    // geglättete Werte (Pegel, Panorama, Feedback-Anteil), damit Reglerbewegungen nicht knistern
    this.gS = 0; this.plS = Math.SQRT1_2; this.prS = Math.SQRT1_2; this.fbT = 0; this.fbW = 0;
  }
}

/* Feedback-Delay-Network-Hall mit 4 Modi + tempo-synchrones Ping-Pong-Delay */
class Space {
  constructor() {
    this.lensMs = [31.3, 37.9, 41.3, 45.7, 53.9, 61.1, 67.3, 79.1];
    this.size = 1 << Math.ceil(Math.log2(0.0791 * 2.0 * SR + 64));
    this.mask = this.size - 1;
    this.bufs = []; this.lens = new Float64Array(8); this.lensM = new Float64Array(8); this.lensT = new Float64Array(8); this.g = new Float64Array(8); this.lp = new Float64Array(8);
    for (let i = 0; i < 8; i++) this.bufs.push(new Float32Array(this.size));
    this.w = 0;
    this.apMs = [4.77, 3.59, 12.73, 9.31];
    this.ap = this.apMs.map(ms => ({ buf: new Float32Array(1 << Math.ceil(Math.log2(ms * 0.001 * SR + 8))), len: Math.round(ms * 0.001 * SR), w: 0 }));
    this.preSize = 1 << Math.ceil(Math.log2(0.08 * SR + 8));
    this.preL = new Float32Array(this.preSize); this.preR = new Float32Array(this.preSize); this.preW = 0; this.preD = 1; this.preDM = 1; this.preDT = 1;
    this.dlySize = 1 << Math.ceil(Math.log2(2.6 * SR));
    this.dlyL = new Float32Array(this.dlySize); this.dlyR = new Float32Array(this.dlySize); this.dlyW = 0;
    this.dlyD = 0.4 * SR; this.dlyDT = 0.4 * SR; this.dlyLpL = 0; this.dlyLpR = 0;
    this.modPh = 0; this.modDepth = 0; this.modDepthT = 0; this.damp = 0.3; this.dampS = 0.3; this.mode = -1; this.timeScale = 1;
    this.dmix = DMIX[1]; this.dmixT = DMIX[1];
    this.oL = 0; this.oR = 0;
    this._y = new Float64Array(8);
    this.setMode(1, 1);
    this.lens.set(this.lensT); this.lensM.set(this.lensT); this.preD = this.preDM = this.preDT; this.modDepth = this.modDepthT; this.dmix = this.dmixT;
    this.dampS = this.damp;
  }
  // Setzt nur Zielwerte; Längen, Pre-Delay, Modulation und Delay-Anteil gleiten in process() dorthin,
  // sonst springen die Lesepositionen beim Wechsel des Hall-Typs und es knackt. Längen und Pre-Delay
  // gleiten zweistufig, damit auch die Lesegeschwindigkeit sanft anläuft.
  setMode(m, timeScale) {
    if (m === this.mode && timeScale === this.timeScale) return;
    this.mode = m; this.timeScale = timeScale;
    const size = [0.55, 1.0, 1.45, 1.9][m];
    const rt = [0.8, 2.1, 4.2, 11][m] * timeScale;
    this.damp = [0.12, 0.58, 0.3, 0.4][m];
    this.preDT = Math.max(1, Math.round([4, 12, 25, 45][m] * 0.001 * SR));
    this.modDepthT = [0, 0.5, 3, 10][m];
    this.dmixT = DMIX[m];
    for (let i = 0; i < 8; i++) {
      const L = this.lensMs[i] * 0.001 * SR * size;
      this.lensT[i] = L;
      this.g[i] = Math.pow(10, -3 * L / (rt * SR));
    }
  }
  setDelayTime(samples) { this.dlyDT = clamp(samples, 0.05 * SR, 2.5 * SR); }
  process(inL, inR) {
    // Pre-Delay (gleitend, mit Interpolation)
    const pm = this.preSize - 1;
    this.preL[this.preW] = inL; this.preR[this.preW] = inR;
    this.preDM += (this.preDT - this.preDM) * 0.0005; this.preD += (this.preDM - this.preD) * 0.0005;
    let pp = this.preW - this.preD; if (pp < 0) pp += this.preSize;
    const p0 = pp | 0, pf = pp - p0, p1 = (p0 + 1) & pm, pi0 = p0 & pm;
    let xL = this.preL[pi0] + (this.preL[p1] - this.preL[pi0]) * pf;
    let xR = this.preR[pi0] + (this.preR[p1] - this.preR[pi0]) * pf;
    this.preW = (this.preW + 1) & pm;
    // Diffusion (Allpässe, mono-summiert + Stereo-Rest)
    let x = (xL + xR) * 0.5;
    for (let a = 0; a < 4; a++) {
      const ap = this.ap[a], m = ap.buf.length - 1;
      const dv = ap.buf[(ap.w - ap.len) & m];
      const v = x + 0.62 * dv;
      ap.buf[ap.w] = v; ap.w = (ap.w + 1) & m;
      x = dv - 0.62 * v;
    }
    const side = (xL - xR) * 0.5;
    // FDN lesen
    this.dampS += (this.damp - this.dampS) * 0.0005;
    const mask = this.mask, w = this.w, b = this.bufs, lens = this.lens, lensM = this.lensM, lensT = this.lensT, lp = this.lp, d = this.dampS;
    this.modPh += 0.37 / SR; if (this.modPh > 1) this.modPh -= 1;
    this.modDepth += (this.modDepthT - this.modDepth) * 0.0003;
    const mo = this.modDepth > 1e-3 ? this.modDepth * Math.sin(TWO_PI * this.modPh) : 0;
    const y = this._y;
    for (let i = 0; i < 8; i++) {
      lensM[i] += (lensT[i] - lensM[i]) * 0.0004; lens[i] += (lensM[i] - lens[i]) * 0.0004;
      let L = lens[i];
      if (i < 2) L += (i === 0 ? mo : -mo);
      let p = w - L; if (p < 0) p += this.size;
      const i0 = p | 0, f = p - i0, bi = b[i];
      const s = bi[i0 & mask] + (bi[(i0 + 1) & mask] - bi[i0 & mask]) * f;
      lp[i] = s * (1 - d) + lp[i] * d;
      y[i] = lp[i];
    }
    // Hadamard 8x8 (schnelle Walsh-Hadamard-Transformation)
    let a0 = y[0] + y[1], a1 = y[0] - y[1], a2 = y[2] + y[3], a3 = y[2] - y[3];
    let a4 = y[4] + y[5], a5 = y[4] - y[5], a6 = y[6] + y[7], a7 = y[6] - y[7];
    let c0 = a0 + a2, c1 = a1 + a3, c2 = a0 - a2, c3 = a1 - a3;
    let c4 = a4 + a6, c5 = a5 + a7, c6 = a4 - a6, c7 = a5 - a7;
    const h = 0.35355339059327373;
    const m0 = (c0 + c4) * h, m1 = (c1 + c5) * h, m2 = (c2 + c6) * h, m3 = (c3 + c7) * h;
    const m4 = (c0 - c4) * h, m5 = (c1 - c5) * h, m6 = (c2 - c6) * h, m7 = (c3 - c7) * h;
    const g = this.g;
    b[0][w] = m0 * g[0] + x + side; b[1][w] = m1 * g[1] + x - side;
    b[2][w] = m2 * g[2] + x;        b[3][w] = m3 * g[3] - x;
    b[4][w] = m4 * g[4] + x + side; b[5][w] = m5 * g[5] - x + side;
    b[6][w] = m6 * g[6] + x - side; b[7][w] = m7 * g[7] - x;
    this.w = (w + 1) & mask;
    let rL = (y[0] - y[2] + y[4] - y[6] + y[1] * 0.5) * 0.42;
    let rR = (y[1] - y[3] + y[5] - y[7] + y[0] * 0.5) * 0.42;
    // Ping-Pong-Delay (punktierte Achtel)
    const dm = this.dlySize - 1;
    this.dlyD += (this.dlyDT - this.dlyD) * 0.0002;
    let p = this.dlyW - this.dlyD; if (p < 0) p += this.dlySize;
    const i0 = p | 0, f = p - i0;
    const dL = this.dlyL[i0 & dm] + (this.dlyL[(i0 + 1) & dm] - this.dlyL[i0 & dm]) * f;
    const dR = this.dlyR[i0 & dm] + (this.dlyR[(i0 + 1) & dm] - this.dlyR[i0 & dm]) * f;
    this.dlyLpL += (dL - this.dlyLpL) * 0.45; this.dlyLpR += (dR - this.dlyLpR) * 0.45;
    this.dlyL[this.dlyW] = (inL + inR) * 0.5 + this.dlyLpR * 0.42;
    this.dlyR[this.dlyW] = this.dlyLpL * 0.42;
    this.dlyW = (this.dlyW + 1) & dm;
    this.dmix += (this.dmixT - this.dmix) * 0.0005;
    this.oL = rL + dL * this.dmix;
    this.oR = rR + dR * this.dmix;
  }
  clear() {
    for (const bb of this.bufs) bb.fill(0);
    this.lp.fill(0); this.dlyL.fill(0); this.dlyR.fill(0); this.preL.fill(0); this.preR.fill(0);
    for (const ap of this.ap) ap.buf.fill(0);
    this.dlyLpL = 0; this.dlyLpR = 0; this.oL = 0; this.oR = 0;
    // Gleitwerte direkt aufs Ziel setzen (falls ein ungültiger Wert hineingeraten ist)
    this.lens.set(this.lensT); this.lensM.set(this.lensT); this.preD = this.preDM = this.preDT;
    this.modDepth = this.modDepthT; this.dmix = this.dmixT; this.dampS = this.damp;
    if (!isNum(this.dlyD)) this.dlyD = this.dlyDT;
  }
}

class OrbitProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rng = new Rng(0x51ed27 ^ (Date.now() & 0xffffff));
    // Verlaufspuffer
    this.hL = new Float32Array(BUF); this.hR = new Float32Array(BUF);
    this.w = 0; this.clock = 0;
    // Hold-Sampler (holdOn = Ziel, holdX = Überblendung 0 live … 1 Hold)
    this.holdL = new Float32Array(HOLD_MAX); this.holdR = new Float32Array(HOLD_MAX);
    this.holdL.fill(0); this.holdR.fill(0); // Seiten jetzt anfassen statt beim ersten Hold im Audio-Takt
    this.holdOn = false; this.holdLen = 0; this.holdPos = 0; this.holdX = 0;
    // Looper
    this.lbL = new Float32Array(LOOP_MAX); this.lbR = new Float32Array(LOOP_MAX);
    this.ldL = new Float32Array(LOOP_MAX); this.ldR = new Float32Array(LOOP_MAX);
    this.lp = {
      st: L_EMPTY, len: 0, rec: 0, pos: 0, speed: 1, speedT: 1, rev: false,
      dubOn: true, hasDub: false, dubG: 1, fade: 1, fadeT: 1, fadeFast: false, stopping: false,
      pre: false, quant: false, only: false, burst: false, order: 0, fadeShape: 0, fadeSec: 0.08,
    };
    // Ausklang beim abrupten Ende der Loop-Wiedergabe (Löschen, neue Aufnahme, Stopp ohne Fade)
    this.tail = { n: 0, pos: 0, len: 0, speed: 1, dir: 1, g: 0, dubG: 0 };
    this.loopGen = 0;      // zählt hoch, sobald sich der Loop-Inhalt grundlegend ändert
    this.xfer = null;      // laufender Export (getLoop) in Stücken
    this.loading = null;   // laufender Import (setLoop) in Stücken
    this.dubSweep = null;  // Overdub-Ebene wird in Stücken geleert
    // Stimmen & Taps
    this.voices = []; for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.taps = []; for (let i = 0; i < NUM_TAPS; i++) this.taps.push(new Tap());
    this.fbTap = -1; this.fbGain = 0; this.fbGs = 0; this.fbDampL = 0; this.fbDampR = 0; this.hazeFb = 0;
    // Block-Arbeitspuffer
    const B = 2048;
    this.wetL = new Float32Array(B); this.wetR = new Float32Array(B);
    this.dryL = new Float32Array(B); this.dryR = new Float32Array(B);
    this.rawL = new Float32Array(B); this.rawR = new Float32Array(B);
    this.lpL = new Float32Array(B); this.lpR = new Float32Array(B);
    this.lpPos = new Int32Array(B);
    this.fbNL = new Float32Array(B); this.fbNR = new Float32Array(B);
    this.holdXB = new Float32Array(B);
    this.duckT = new Float32Array(B);
    this.lastRecover = -1e12;
    // Modulation & Filter
    this.modL = new Float32Array(MOD_SIZE); this.modR = new Float32Array(MOD_SIZE); this.modW = 0; this.modPh = 0;
    this.fs1L = 0; this.fs2L = 0; this.fs1R = 0; this.fs2R = 0;
    this.space = new Space();
    // Onsets
    this.onsets = []; for (let i = 0; i < 16; i++) this.onsets.push({ time: -1e12, level: 0, freq: 0, pitchAt: 0 });
    this.onsetW = 0; this.onsetCount = 0; this.lastOnsetTime = -1e12; this.onsetFlag = 0;
    this.envF = 0; this.envS = 0; this.envSlow = 0;
    this.cEnvAF = 1 - Math.exp(-1 / (0.0008 * SR)); this.cEnvRF = 1 - Math.exp(-1 / (0.03 * SR));
    this.cEnvAS = 1 - Math.exp(-1 / (0.04 * SR)); this.cEnvRS = 1 - Math.exp(-1 / (0.3 * SR));
    this.decBuf = new Float32Array(512);
    // Parameter (normiert 0..1)
    this.p = {
      activity: 0.5, repeats: 0.5, shape: 0.45, time: 0.42, filter: 1, mix: 0.5, space: 0.3, loopLevel: 0.82,
      revTime: 0.5, modDepth: 0, modRate: 0.35, loopSpeed: 0.5, resonance: 0.15, effVol: 0.5, reverbMode: 0.3, fadeTime: 0.1,
      timeMode: 0, effect: 0, variation: 0, effRev: 0, mono: 1, inputLine: 0,
      bypassStyle: 0, // 0 gepuffert ohne Trails, 1 gepuffert mit Trails, 2 True Bypass
    };
    this.bpm = 100; this.extClock = false;
    this.bypass = false; this.byN = 0; this.byT = 0; // Crossfade-Werte
    this.shapeEnv = { att: 0.45, rel: 0.45, perc: 0, rev: false };
    // Glättungs-Zustände
    this.sm = {};
    this.resetSmoothing();
    this.cSm = 1 - Math.exp(-1 / (0.02 * SR));
    this.cDuck = 1 - Math.exp(-1 / (0.003 * SR));
    this.cByp = 1 - Math.exp(-1 / (0.008 * SR));
    this.cTapFade = 1 - Math.exp(-1 / (0.015 * SR));
    this.cTapDel = 1 - Math.exp(-1 / (0.08 * SR));
    // Takt / Scheduler
    this.beatPos = 0; this.beatCount = 0;
    this.stepPos = 1e9; this.stepIdx = -1; this.stepsPerUnit = 1;
    this.algo = {};
    this.derive();
    this.resetAlgo();
    this.postCounter = 0; this.postEvery = Math.max(1, Math.round(SR / 128 / 30));
    this.waveCounter = 0;
    this.peakIn = 0; this.peakL = 0; this.peakR = 0;
    this.visBuf = new Float32Array(MAX_VOICES * 4 + NUM_TAPS * 4);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  /* ---------------- Nachrichten ---------------- */
  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'params': {
        const prevFx = this.p.effect, prevVar = this.p.variation;
        applyParams(this.p, m.values);
        if (m.values && 'time' in m.values && this.p.timeMode === 1 && !this.extClock) this.bpm = 40 + this.p.time * 200;
        this.derive();
        if (this.p.effect !== prevFx || this.p.variation !== prevVar) this.resetAlgo();
        break;
      }
      case 'bpm':
        if (isNum(m.bpm)) this.bpm = clamp(m.bpm, 20, 300);
        if (m.resync) { this.stepPos = 1e9; this.beatPos = 0; }
        this.derive();
        break;
      case 'extClock': this.extClock = !!m.on; break;
      case 'hold': this.setHold(!!m.on); break;
      case 'bypass': this.bypass = !!m.on; if (!this.bypass && this.p.bypassStyle !== 1) this.killVoices(); break;
      case 'looper': if (typeof m.cmd === 'string') this.looperCmd(m.cmd); break;
      case 'looperOpts': applyLooperOpts(this.lp, m.values); break;
      case 'setLoop': this.startLoopLoad(m.L, m.R); break;
      case 'getLoop': this.startLoopExport(m.id); break;
      case 'panic': this.resetDsp(true); break;
    }
  }

  resetSmoothing() {
    Object.assign(this.sm, { mixD: 1, mixW: 1, spD: 1, spW: 0.6, effVol: 1, kill: 1, fc: 20000, q: 0.7, modD: 0, loopG: 1, duck: 1 });
  }
  /** Alle Effekt-Zustände auf null (Panik oder nach einem abgefangenen NaN). Der Loop bleibt erhalten. */
  resetDsp(clearHistory) {
    this.killVoices();
    for (const tp of this.taps) {
      tp.s1L = tp.s2L = tp.s1R = tp.s2R = 0; tp.env = 0; tp.ph = 0; tp.xfPh = 0; tp.level = 0;
      if (!isNum(tp.d)) tp.d = tp.dT;
    }
    this.space.clear();
    this.fs1L = this.fs2L = this.fs1R = this.fs2R = 0;
    this.fbDampL = this.fbDampR = 0; this.fbGs = 0; this.hazeFb = 0;
    this.fbNL.fill(0); this.fbNR.fill(0);
    this.modL.fill(0); this.modR.fill(0);
    this.envF = this.envS = this.envSlow = 0;
    this.resetSmoothing();
    const trails = this.p.bypassStyle === 1;
    this.byN = this.bypass && !trails ? 1 : 0; this.byT = this.bypass && trails ? 1 : 0;
    if (!isNum(this.lp.speed)) this.lp.speed = 1;
    if (clearHistory) { this.hL.fill(0); this.hR.fill(0); this.holdOn = false; this.holdX = 0; }
  }
  /** Notbremse: ungültige Werte im Ausgang → Block stumm, Zustände zurücksetzen. */
  recover(oL, oR, n) {
    oL.fill(0, 0, n); if (oR !== oL) oR.fill(0, 0, n);
    const again = this.clock - this.lastRecover < SR;
    this.lastRecover = this.clock;
    this.resetDsp(true);
    if (again) { // kommt sofort wieder → steckt vermutlich im Loop: Loop verwerfen
      const lp = this.lp;
      lp.st = L_EMPTY; lp.len = 0; lp.rec = 0; lp.hasDub = false; lp.dubOn = true; lp.stopping = false; lp.pos = 0;
      this.tail.n = 0; this.loading = null; this.dubSweep = null; this.loopGen++;
    }
    this.port.postMessage({ type: 'recovered', loopCleared: again });
  }

  derive() {
    const p = this.p;
    this.A = p.activity; this.R = p.repeats; this.S = p.shape;
    shapeParams(this.S, this.shapeEnv);
    this.subdivIdx = p.timeMode === 1 ? 2 : Math.min(5, Math.floor(p.time * 6));
    this.spb = 60 / this.bpm * SR;
    this.U = this.spb * SUBDIV[this.subdivIdx];
    this.effect = p.effect | 0; this.variation = p.variation | 0;
    this.revFx = !!p.effRev;
    // Sekundärparameter
    this.revScale = Math.pow(2, (p.revTime - 0.5) * 2.4);
    this.space.setMode(Math.min(3, Math.floor(p.reverbMode * 4)), this.revScale);
    this.space.setDelayTime(this.spb * 0.75);
    this.lp.speedT = Math.abs(p.loopSpeed - 0.5) < 0.025 ? 1 : Math.pow(2, (p.loopSpeed - 0.5) * 4);
    this.lp.fadeSec = Math.max(0.005, p.fadeTime * p.fadeTime * 8);
    this.inGain = p.inputLine ? 1 : 1.6;
    if (this.effect === FX.MOSAIC) this.stepsPerUnit = 1 + Math.floor(this.A * 5.99);
    this.updateTaps();
  }

  /* ---------------- Hold-Sampler ---------------- */
  setHold(on) {
    if (on === this.holdOn) return;
    if (!on) { this.holdOn = false; return; } // holdX blendet in process() zurück auf den Eingang
    if (this.lp.st !== L_EMPTY || this.loading) return; // nicht verfügbar, solange der Looper aktiv ist
    const L = Math.floor(clamp(this.U, 0.06 * SR, HOLD_MAX));
    const F = Math.floor(Math.min(0.02 * SR, L / 4));
    const end = this.w; // nächster Schreibindex; letztes Sample = end-1
    const start = (end - L + BUF) & MASK;
    // als Blockkopie (memcpy) statt Einzelschleife – läuft im Audio-Thread
    const first = Math.min(L, BUF - start);
    this.holdL.set(this.hL.subarray(start, start + first)); this.holdR.set(this.hR.subarray(start, start + first));
    if (first < L) { this.holdL.set(this.hL.subarray(0, L - first), first); this.holdR.set(this.hR.subarray(0, L - first), first); }
    // Übergang Ende→Anfang überblenden
    for (let j = 0; j < F; j++) {
      const t = (j + 1) / F;
      const src = (start - F + j + BUF) & MASK;
      const k = L - F + j;
      this.holdL[k] = this.holdL[k] * (1 - t) + this.hL[src] * t;
      this.holdR[k] = this.holdR[k] * (1 - t) + this.hR[src] * t;
    }
    this.holdLen = L; this.holdPos = 0; this.holdOn = true;
  }

  /* ---------------- Looper ---------------- */
  looperCmd(cmd) {
    const lp = this.lp;
    if (this.loading) { if (cmd === 'erase') this.loopErase(); return; } // Loop wird gerade geladen
    const hasLoop = lp.len > 0;
    // Weiterspielen/Overdub während des Ausblendens nach Stopp: Ausblenden abbrechen statt trotzdem zu stoppen
    if (lp.stopping && (cmd === 'main' || cmd === 'play' || cmd === 'dub')) {
      lp.stopping = false; lp.fadeT = 1;
      if (cmd === 'dub') this.loopStartDub();
      return;
    }
    switch (cmd) {
      case 'main':
        if (lp.st === L_EMPTY || (lp.st === L_STOP && !hasLoop)) this.loopStartRec();
        else if (lp.st === L_REC) this.loopCloseRec(lp.order === 1 ? L_DUB : L_PLAY);
        else if (lp.st === L_PLAY) this.loopStartDub();
        else if (lp.st === L_DUB) lp.st = L_PLAY;
        else if (lp.st === L_STOP) this.loopPlay();
        break;
      case 'rec':
        if (lp.st === L_REC) this.loopCloseRec(L_PLAY); else this.loopStartRec();
        break;
      case 'play':
        if (lp.st === L_REC) this.loopCloseRec(L_PLAY);
        else if (lp.st === L_DUB) lp.st = L_PLAY;
        else if (lp.st === L_STOP && hasLoop) this.loopPlay();
        break;
      case 'dub':
        if (lp.st === L_REC) this.loopCloseRec(L_DUB);
        else if (lp.st === L_PLAY) this.loopStartDub();
        else if (lp.st === L_STOP && hasLoop) { this.loopPlay(); this.loopStartDub(); }
        break;
      case 'stop':
        // während der Aufnahme: Loop sichern und gestoppt lassen (nicht erst kurz anspielen und ausblenden)
        if (lp.st === L_REC) this.loopCloseRec(L_STOP);
        else if (lp.st === L_PLAY || lp.st === L_DUB) this.loopStop();
        break;
      case 'erase':
        this.loopErase();
        break;
      case 'undo':
        if (hasLoop && lp.hasDub) { if (lp.st === L_DUB) lp.st = L_PLAY; lp.dubOn = !lp.dubOn; }
        break;
      case 'burstStart':
        this.loopStartRec();
        break;
      case 'burstEnd':
        if (lp.st === L_REC) this.loopCloseRec(L_PLAY);
        break;
      case 'reverse':
        lp.rev = !lp.rev;
        break;
    }
  }
  loopStartRec() {
    const lp = this.lp;
    this.loopCut();
    this.holdOn = false;
    this.dubSweep = null; this.loopGen++;
    lp.st = L_REC; lp.rec = 0; lp.len = 0; lp.hasDub = false; lp.dubOn = true; lp.pos = 0; lp.stopping = false;
    lp.fade = 1; lp.fadeT = 1; lp.fadeFast = false; lp.dubG = 1;
  }
  loopCloseRec(next) {
    const lp = this.lp;
    let len = lp.rec;
    if (len < 0.05 * SR) { lp.st = L_EMPTY; lp.len = 0; lp.rec = 0; return; }
    if (lp.quant) {
      const beats = Math.max(1, Math.round(len / this.spb));
      const q = Math.min(LOOP_MAX, Math.round(beats * this.spb));
      if (q > len) { // höchstens ein halber Schlag
        this.lbL.fill(0, len, q); this.lbR.fill(0, len, q);
        this.ldL.fill(0, len, q); this.ldR.fill(0, len, q);
      }
      len = q;
    }
    // Die Overdub-Ebene wurde schon während der Aufnahme mitgeleert (loopWrite) – hier kein großes fill()
    // im Audio-Takt (bei 60 s wären das 23 MB auf einmal).
    this.seamFade(len);
    lp.len = len; lp.pos = lp.rev ? len - 1 : 0;
    lp.fade = 1; lp.fadeT = 1; lp.fadeFast = false; lp.stopping = false; lp.dubG = 1;
    this.loopGen++;
    if (next === L_DUB) { lp.hasDub = true; lp.st = L_DUB; }
    else if (next === L_STOP) { lp.st = L_STOP; lp.fade = 0; }
    else lp.st = L_PLAY;
  }
  // kurze Blenden gegen Klicks an der Schleifennaht
  seamFade(len) {
    const F = Math.min(96, len >> 3);
    for (let j = 0; j < F; j++) {
      const g = j / F;
      this.lbL[j] *= g; this.lbR[j] *= g;
      this.lbL[len - 1 - j] *= g; this.lbR[len - 1 - j] *= g;
    }
  }
  loopStartDub() {
    const lp = this.lp;
    // Nach einem Undo die alte Ebene verwerfen – stückweise in den nächsten Blöcken statt mit einem großen fill()
    if (!lp.dubOn) { this.startDubSweep(); lp.dubOn = true; }
    lp.hasDub = true; lp.st = L_DUB;
  }
  loopPlay() {
    const lp = this.lp;
    lp.st = L_PLAY; lp.pos = lp.rev ? lp.len - 1 : 0; lp.stopping = false;
    const fadeIn = lp.fadeShape === 0 || lp.fadeShape === 1;
    // ohne Fade trotzdem minimal einblenden (die Overdub-Ebene hat an der Naht keine Blende)
    lp.fade = 0; lp.fadeT = 1; lp.fadeFast = !fadeIn;
  }
  loopStop() {
    const lp = this.lp;
    const fadeOut = lp.fadeShape === 0 || lp.fadeShape === 2;
    if (lp.st === L_DUB) lp.st = L_PLAY;
    if (fadeOut) { lp.stopping = true; lp.fadeT = 0; lp.fadeFast = false; }
    else { this.loopCut(); lp.st = L_STOP; lp.stopping = false; lp.fade = 0; }
  }
  loopErase() {
    const lp = this.lp;
    this.loopCut();
    lp.st = L_EMPTY; lp.len = 0; lp.rec = 0; lp.hasDub = false; lp.dubOn = true; lp.stopping = false; lp.pos = 0;
    this.loading = null; this.dubSweep = null; this.loopGen++;
  }
  /** Hört die Wiedergabe abrupt auf, klingt sie über DECLICK Samples aus (statt eines Knacks). */
  loopCut() {
    const lp = this.lp, t = this.tail;
    if (!((lp.st === L_PLAY || lp.st === L_DUB) && lp.len > 0 && lp.fade > 0)) return;
    t.n = DECLICK; t.pos = lp.pos; t.len = lp.len; t.speed = lp.speed; t.dir = lp.rev ? -1 : 1;
    t.g = lp.fade; t.dubG = lp.dubG;
  }
  renderTail(n) {
    const t = this.tail, oL = this.lpL, oR = this.lpR;
    const bL = this.lbL, bR = this.lbR, dL = this.ldL, dR = this.ldR, len = t.len;
    for (let i = 0; i < n && t.n > 0; i++) {
      const p = t.pos, i0 = p | 0, f = p - i0, i1 = i0 + 1 >= len ? 0 : i0 + 1;
      let sL = bL[i0] + (bL[i1] - bL[i0]) * f;
      let sR = bR[i0] + (bR[i1] - bR[i0]) * f;
      if (t.dubG > 0) { sL += (dL[i0] + (dL[i1] - dL[i0]) * f) * t.dubG; sR += (dR[i0] + (dR[i1] - dR[i0]) * f) * t.dubG; }
      const g = t.g * t.n / DECLICK;
      oL[i] += sL * g; oR[i] += sR * g;
      let q = p + t.speed * t.dir;
      if (q >= len) q -= len; else if (q < 0) q += len;
      t.pos = q; t.n--;
    }
  }
  startDubSweep() {
    const lp = this.lp;
    if (lp.len <= 0) return;
    // in Abspielrichtung ab der aktuellen Position: der Schreibkopf des Overdubs läuft hinter dem Löschen her
    this.dubSweep = { pos: clamp(Math.floor(lp.pos), 0, lp.len - 1), left: lp.len, dir: lp.rev ? -1 : 1 };
  }
  pumpDubSweep() {
    const s = this.dubSweep, len = this.lp.len;
    if (!s) return;
    if (len <= 0) { this.dubSweep = null; return; }
    let k = Math.min(SWEEP_CHUNK, s.left);
    s.left -= k;
    while (k > 0) {
      let a, b;
      if (s.dir > 0) { a = Math.min(s.pos, len - 1); b = Math.min(len, a + k); s.pos = b >= len ? 0 : b; }
      else { b = Math.min(s.pos, len - 1) + 1; a = Math.max(0, b - k); s.pos = a > 0 ? a - 1 : len - 1; }
      this.ldL.fill(0, a, b); this.ldR.fill(0, a, b);
      k -= b - a;
    }
    if (s.left <= 0) this.dubSweep = null;
  }
  /** Loop aus einer Datei/einem Preset übernehmen – in Stücken pro Block kopiert. */
  startLoopLoad(L, R) {
    if (!(L instanceof Float32Array)) return;
    if (!(R instanceof Float32Array) || R.length < L.length) R = L;
    const len = Math.min(L.length, LOOP_MAX);
    if (len < 16) return;
    this.loopCut();
    const lp = this.lp;
    lp.st = L_EMPTY; lp.len = 0; lp.rec = 0; lp.hasDub = false; lp.dubOn = true; lp.pos = 0; lp.stopping = false;
    this.dubSweep = null; this.loopGen++;
    this.holdOn = false;
    this.loading = { L, R, len, pos: 0 };
  }
  pumpLoopLoad() {
    const ld = this.loading;
    if (!ld) return;
    const a = ld.pos, b = Math.min(ld.len, a + XFER_CHUNK);
    this.lbL.set(ld.L.subarray(a, b), a); this.lbR.set(ld.R.subarray(a, b), a);
    this.ldL.fill(0, a, b); this.ldR.fill(0, a, b);
    ld.pos = b;
    if (b < ld.len) return;
    this.loading = null;
    this.seamFade(ld.len); // geladene Loops haben sonst an der Naht einen Sprung
    const lp = this.lp;
    lp.len = ld.len; lp.rec = ld.len; lp.st = L_STOP; lp.pos = lp.rev ? ld.len - 1 : 0;
    lp.fade = 0; lp.fadeT = 1; lp.dubG = 1;
    this.loopGen++;
  }
  /** Loop zum Hauptthread schicken – in Stücken, damit der Audio-Thread nie 20+ MB auf einmal kopiert. */
  startLoopExport(id) {
    if (this.xfer) this.port.postMessage({ type: 'loopData', id: this.xfer.id, len: 0, sr: SR });
    this.xfer = null;
    const lp = this.lp;
    if (lp.len <= 0 || lp.st === L_REC || this.loading) { this.port.postMessage({ type: 'loopData', id, len: 0, sr: SR }); return; }
    this.xfer = { id, len: lp.len, pos: 0, gen: this.loopGen };
  }
  pumpLoopExport() {
    const x = this.xfer, lp = this.lp;
    if (!x) return;
    if (x.gen !== this.loopGen || lp.len !== x.len) { // Loop hat sich währenddessen geändert
      this.port.postMessage({ type: 'loopData', id: x.id, len: 0, sr: SR });
      this.xfer = null;
      return;
    }
    if (this.dubSweep) return; // erst die verworfene Overdub-Ebene fertig leeren
    const a = x.pos, b = Math.min(x.len, a + XFER_CHUNK), n = b - a;
    const L = new Float32Array(n), R = new Float32Array(n);
    const bL = this.lbL, bR = this.lbR;
    if (lp.hasDub && lp.dubOn) {
      const dL = this.ldL, dR = this.ldR;
      for (let j = 0; j < n; j++) { L[j] = bL[a + j] + dL[a + j]; R[j] = bR[a + j] + dR[a + j]; }
    } else { L.set(bL.subarray(a, b)); R.set(bR.subarray(a, b)); }
    this.port.postMessage({ type: 'loopChunk', id: x.id, off: a, L, R }, [L.buffer, R.buffer]);
    x.pos = b;
    if (b >= x.len) { this.port.postMessage({ type: 'loopData', id: x.id, len: x.len, sr: SR }); this.xfer = null; }
  }
  renderLoop(n) {
    const lp = this.lp, oL = this.lpL, oR = this.lpR, pos = this.lpPos;
    const playing = (lp.st === L_PLAY || lp.st === L_DUB) && lp.len > 0;
    if (!playing) { oL.fill(0, 0, n); oR.fill(0, 0, n); pos.fill(-1, 0, n); }
    else {
      const len = lp.len, bL = this.lbL, bR = this.lbR, dL = this.ldL, dR = this.ldR;
      // Overdub-Ebene weich zu-/abschalten (Undo/Redo), solange sie geleert wird stumm
      const dubT = lp.hasDub && lp.dubOn && !this.dubSweep ? 1 : 0;
      const dInc = 1 / DECLICK;
      let dg = lp.dubG;
      const fadeInc = lp.fadeFast ? 1 / DECLICK : 1 / (lp.fadeSec * SR);
      const dir = lp.rev ? -1 : 1;
      for (let i = 0; i < n; i++) {
        lp.speed += (lp.speedT - lp.speed) * 0.0006;
        let p = lp.pos;
        const i0 = p | 0, f = p - i0, i1 = i0 + 1 >= len ? 0 : i0 + 1;
        let sL = bL[i0] + (bL[i1] - bL[i0]) * f;
        let sR = bR[i0] + (bR[i1] - bR[i0]) * f;
        if (dg !== dubT) dg = dubT > dg ? Math.min(1, dg + dInc) : Math.max(0, dg - dInc);
        if (dg > 0) { sL += (dL[i0] + (dL[i1] - dL[i0]) * f) * dg; sR += (dR[i0] + (dR[i1] - dR[i0]) * f) * dg; }
        pos[i] = i0;
        p += lp.speed * dir;
        if (p >= len) p -= len; else if (p < 0) p += len;
        lp.pos = p;
        if (lp.fade !== lp.fadeT) {
          if (lp.fade < lp.fadeT) lp.fade = Math.min(lp.fadeT, lp.fade + fadeInc);
          else lp.fade = Math.max(lp.fadeT, lp.fade - fadeInc);
        }
        oL[i] = sL * lp.fade; oR[i] = sR * lp.fade;
        if (lp.stopping && lp.fade <= 0) {
          lp.stopping = false; lp.st = L_STOP;
          for (let k = i + 1; k < n; k++) { oL[k] = 0; oR[k] = 0; pos[k] = -1; }
          break;
        }
      }
      lp.dubG = dg;
    }
    if (this.tail.n > 0) this.renderTail(n);
  }
  loopWrite(i, sL, sR) {
    const lp = this.lp;
    if (lp.st === L_REC) {
      const r = lp.rec;
      this.lbL[r] = sL; this.lbR[r] = sR;
      this.ldL[r] = 0; this.ldR[r] = 0; // Overdub-Ebene gleich mitleeren
      lp.rec = r + 1;
      if (lp.rec >= LOOP_MAX) this.loopCloseRec(L_PLAY);
    } else if (lp.st === L_DUB) {
      const j = this.lpPos[i];
      if (j >= 0) {
        const s = Math.min(1, Math.abs(lp.speed));
        this.ldL[j] += sL * s; this.ldR[j] += sR * s;
      }
    }
  }

  /* ---------------- Stimmen ---------------- */
  allocVoice() {
    let free = null, active = 0, best = null, bestScore = 1e9, fading = null;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active) { if (!free) free = v; continue; }
      active++;
      if (v.kill > 0) { if (!fading || v.kill < fading.kill) fading = v; continue; }
      const score = v.amp * v.gain * (v.delay > 0 ? 4 : 1);
      if (score < bestScore) { bestScore = score; best = v; }
    }
    // Wird es eng, die leiseste Stimme über DECLICK Samples ausblenden statt sie später hart zu übernehmen
    if (active >= MAX_VOICES - VOICE_RESERVE && best) {
      if (best.delay > 0) { best.active = false; if (!free) free = best; } // noch nicht hörbar
      else best.kill = DECLICK;
    }
    if (free) return free;
    // Notfall: alle Stimmen belegt → übernehmen (am liebsten eine, die schon fast ausgeblendet ist)
    return fading || best || this.voices[0];
  }
  killVoices() { for (const v of this.voices) v.active = false; }
  countVoices() { let c = 0; for (const v of this.voices) if (v.active) c++; return c; }

  /**
   * Startet eine Stimme, die einen Abschnitt des Verlaufspuffers abspielt (ggf. als Schleife).
   * off: Sample-Offset im aktuellen Block, now: zuletzt geschriebener Index,
   * back: Abstand Abschnittsende → jetzt, seg: Abschnittslänge, rate: Geschwindigkeit (negativ = rückwärts),
   * dur: Ausgabedauer in Samples.
   */
  spawn(off, now, back, seg, rate, dur, gain, pan, o) {
    seg = Math.floor(clamp(seg, 16, 6 * SR));
    back = Math.max(0, Math.floor(back));
    if (back + seg > BUF - SR) return null;
    const v = this.allocVoice();
    v.reset(); v.active = true;
    v.delay = off | 0;
    v.start = ((now - back - seg + 1) % BUF + BUF) % BUF;
    v.seg = v.segCur = seg;
    v.rate = rate; v.dir = rate < 0 ? -1 : 1;
    v.phase = rate < 0 ? seg - 1e-6 : 0;
    // nicht länger spielen, als der Abschnitt im Verlaufspuffer überlebt (sonst überschreibt ihn der Schreibkopf)
    v.dur = Math.max(32, Math.floor(Math.min(dur, 40 * SR, BUF - SR - back - seg - v.delay)));
    v.gain = gain;
    const pa = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
    v.pl = Math.cos(pa); v.pr = Math.sin(pa);
    const env = (o && o.env) || this.shapeEnv;
    let maxRate = Math.abs(rate);
    if (o && o.glide) maxRate = Math.max(o.glide.r0, o.glide.r1);
    const minFrac = Math.min(0.5, (0.002 * SR * maxRate) / seg);
    v.att = Math.max(env.att, minFrac); v.rel = Math.max(env.rel, minFrac); v.perc = env.perc;
    if (v.att + v.rel > 1) { const s = 1 / (v.att + v.rel); v.att *= s; v.rel *= s; }
    v.fadeIn = (o && o.fadeIn) || 48;
    v.fadeOut = (o && o.fadeOut) || Math.max(48, Math.min(v.dur * 0.25, 0.03 * SR));
    v.decay = (o && o.tau) ? Math.exp(-1 / Math.max(1, o.tau)) : 1;
    if (o) {
      if (o.glide) {
        const gl = o.glide;
        v.glide = true; v.lr0 = Math.log2(gl.r0); v.lr1 = Math.log2(gl.r1);
        v.glideLen = Math.max(1, gl.len); v.glideP = gl.p || 1; v.glideStep = !!gl.step; v.glidePing = !!gl.ping;
      }
      if (o.filter) {
        const f = o.filter;
        v.ftype = f.type; v.f0 = f.f0; v.f1 = f.f1 || f.f0; v.fq = f.q || 0.707;
        v.flfoRate = f.lfoRate || 0; v.flfoDepth = f.lfoDepth || 0; v.flfoPh = this.rng.next();
      }
      if (o.crush) { v.crushQ = Math.pow(2, o.crush.bits - 1); v.crushHold = Math.max(1, o.crush.hold | 0); }
      if (o.segMod) { v.smDepth = o.segMod.depth || 0; v.smRate = o.segMod.rate || 0; v.smEnv = o.segMod.env || 0; v.smPh = this.rng.next(); }
    }
    this.voiceControl(v);
    return v;
  }

  voiceControl(v) {
    const t = v.t;
    if (v.glide) {
      let x = t / v.glideLen;
      if (v.glidePing) { x = x % 2; if (x > 1) x = 2 - x; } else if (x > 1) x = 1;
      const c = v.glideP === 1 ? x : Math.pow(x, v.glideP);
      let lr = v.lr0 + (v.lr1 - v.lr0) * c;
      if (v.glideStep) lr = Math.round(lr * 12) / 12;
      v.rate = v.dir * Math.pow(2, lr);
    }
    if (v.smDepth > 0 || v.smEnv > 0) {
      v.smPh += v.smRate * 32 / SR; if (v.smPh > 1) v.smPh -= 1;
      let m = 1 - v.smDepth * (0.5 + 0.5 * Math.sin(TWO_PI * v.smPh));
      if (v.smEnv > 0) m *= 1 - v.smEnv * Math.min(0.85, this.envS * 8);
      v.segCur = Math.max(32, v.seg * m);
    }
    if (v.ftype) {
      let fc = v.f0;
      if (v.f1 !== v.f0) fc = v.f0 * Math.pow(v.f1 / v.f0, Math.min(1, t / v.dur));
      if (v.flfoDepth > 0) { v.flfoPh += v.flfoRate * 32 / SR; if (v.flfoPh > 1) v.flfoPh -= 1; fc *= Math.pow(2, v.flfoDepth * Math.sin(TWO_PI * v.flfoPh)); }
      fc = clamp(fc, 20, SR * 0.45);
      const g = Math.tan(Math.PI * fc / SR), k = 1 / v.fq;
      v.a1 = 1 / (1 + g * (g + k)); v.a2 = g * v.a1; v.a3 = g * v.a2; v.fk = k;
    }
  }

  renderVoices(n, wL, wR) {
    const hL = this.hL, hR = this.hR;
    for (let vi = 0; vi < MAX_VOICES; vi++) {
      const v = this.voices[vi];
      if (!v.active) continue;
      let i = 0;
      if (v.delay > 0) {
        if (v.delay >= n) { v.delay -= n; continue; }
        i = v.delay; v.delay = 0;
      }
      let phase = v.phase, t = v.t, amp = v.amp, rate = v.rate, segCur = v.segCur;
      let s1L = v.s1L, s2L = v.s2L, s1R = v.s1R, s2R = v.s2R;
      let a1 = v.a1, a2 = v.a2, a3 = v.a3;
      let cc = v.crushCnt, chL = v.chL, chR = v.chR, kill = v.kill;
      const att = v.att, rel = v.rel, perc = v.perc, fin = v.fadeIn, fout = v.fadeOut, dur = v.dur, dec = v.decay;
      const ft = v.ftype, fk = v.fk, cq = v.crushQ, ch = v.crushHold, start = v.start;
      const gL = v.gain * v.pl, gR = v.gain * v.pr;
      const invAtt = 1 / att, invRel = 1 / rel, invKill = 1 / DECLICK;
      let e = 0, done = false;
      for (; i < n; i++) {
        if ((t & 31) === 0) {
          v.t = t; this.voiceControl(v);
          rate = v.rate; segCur = v.segCur; a1 = v.a1; a2 = v.a2; a3 = v.a3;
        }
        phase += rate;
        if (phase >= segCur) { phase -= segCur; if (phase >= segCur) phase %= segCur; }
        else if (phase < 0) { phase += segCur; if (phase < 0) phase = ((phase % segCur) + segCur) % segCur; }
        let p = start + phase; if (p >= BUF) p -= BUF;
        const i0 = p | 0, fr = p - i0, i1 = (i0 + 1) & MASK;
        let sL = hL[i0] + (hL[i1] - hL[i0]) * fr;
        let sR = hR[i0] + (hR[i1] - hR[i0]) * fr;
        let xe = phase / segCur; if (rate < 0) xe = 1 - xe;
        e = 1;
        if (xe < att) e = xe * invAtt; else if (xe > 1 - rel) e = (1 - xe) * invRel;
        if (perc > 0) e *= fexp(perc * xe);
        amp *= dec;
        let f = amp;
        if (t < fin) f *= t / fin;
        const rem = dur - t; if (rem < fout) f *= rem / fout;
        if (kill > 0) f *= kill * invKill;
        e *= f;
        if (ft) {
          let v3 = sL - s2L, v1 = a1 * s1L + a2 * v3, v2 = s2L + a2 * s1L + a3 * v3;
          s1L = 2 * v1 - s1L; s2L = 2 * v2 - s2L;
          let w3 = sR - s2R, w1 = a1 * s1R + a2 * w3, w2 = s2R + a2 * s1R + a3 * w3;
          s1R = 2 * w1 - s1R; s2R = 2 * w2 - s2R;
          if (ft === 1) { sL = v2; sR = w2; } else { sL = v1 * fk * 1.4; sR = w1 * fk * 1.4; }
        }
        if (cq > 0) {
          if (cc <= 0) { chL = Math.round(sL * cq) / cq; chR = Math.round(sR * cq) / cq; cc = ch; }
          cc--; sL = chL; sR = chR;
        }
        wL[i] += sL * gL * e; wR[i] += sR * gR * e;
        t++;
        if (kill > 0 && --kill === 0) { done = true; break; }
        if (t >= dur || amp < 1e-4) { done = true; break; }
      }
      v.phase = phase; v.t = t; v.amp = amp; v.kill = kill;
      v.s1L = s1L; v.s2L = s2L; v.s1R = s1R; v.s2R = s2R;
      v.crushCnt = cc; v.chL = chL; v.chR = chR;
      v.level = e * v.gain;
      if (done) v.active = false;
    }
  }

  /* ---------------- Multidelay-Taps ---------------- */
  updateTaps() {
    const fx = this.effect;
    if (fx !== FX.PATTERN && fx !== FX.WARP) {
      for (const tp of this.taps) { tp.on = false; tp.fbT = 0; }
      this.fbTap = -1; this.fbGain = 0;
      return;
    }
    const A = this.A, U = this.U, va = this.variation, S = this.S;
    const N = 1 + Math.floor(A * 7.99);
    const PAT = [
      [1, 2, 3, 4, 5, 6, 7, 8],
      [0.75, 1.5, 2, 2.75, 3.5, 4, 4.75, 5.5],
      [1 / 3, 2 / 3, 1, 5 / 3, 2, 7 / 3, 3, 11 / 3],
      [0.25, 0.5, 1.25, 1.5, 2.5, 2.75, 3, 3.75],
    ];
    const pat = fx === FX.PATTERN ? PAT[va] : [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const norm = 0.85 / Math.sqrt(N);
    for (let k = 0; k < NUM_TAPS; k++) {
      const tp = this.taps[k];
      const on = k < N;
      tp.on = on;
      tp.fbT = k === N - 1 ? 1 : 0; // Rückkopplung kommt vom letzten aktiven Tap (Wechsel wird überblendet)
      if (!on) continue;
      tp.dT = clamp(pat[k] * U, TAP_MIN, BUF - SR * 2);
      const x = N > 1 ? k / (N - 1) : 0;
      let c;
      if (S < 0.5) c = lerp(0.2 + 0.8 * x, 1, S / 0.5);
      else c = lerp(1, Math.exp(-x * 3.5), (S - 0.5) / 0.5);
      tp.gain = norm * c;
      const pan = N > 1 ? (k % 2 === 0 ? -1 : 1) * (0.35 + 0.5 * x) : 0;
      const pa = (pan + 1) * Math.PI / 4; tp.pl = Math.cos(pa); tp.pr = Math.sin(pa);
      tp.mode = 0; tp.rate = 1; tp.ftype = 0;
      tp.W = clamp(U * 0.5, 0.05 * SR, 0.8 * SR);
      if (fx === FX.WARP) {
        if (va === 0) { tp.ftype = 1; tp.fc = 180 + k * 40; tp.q = 2.2; }
        else if (va === 1) { tp.ftype = 2; tp.fc = [520, 830, 1250, 1900, 2800, 660, 1050, 1600][k]; tp.q = 7; }
        else if (va === 2) { tp.mode = 1; tp.rate = [2, 0.5, 1.4983, 2, 0.7491, 1.3348, 4, 0.5][k]; tp.W = 0.07 * SR; }
        else { tp.mode = 2; tp.rate = 2; tp.W = 0.06 * SR; tp.xfRate = 1 / (2 * U * (1 + k * 0.25)); }
      }
      if (this.revFx) { tp.mode = 1; tp.rate = -1; tp.W = clamp(U * 0.5, 0.06 * SR, 0.8 * SR); }
    }
    this.fbTap = N - 1;
    this.fbGain = fx === FX.PATTERN ? this.R * 0.93 : this.R * 0.86;
  }

  renderTaps(n, base0, wL, wR) {
    const hL = this.hL, hR = this.hR, fbL = this.fbNL, fbR = this.fbNR;
    const cF = this.cTapFade, cD = this.cTapDel;
    for (let k = 0; k < NUM_TAPS; k++) {
      const tp = this.taps[k];
      if (!tp.on && tp.fade < 1e-4) { tp.fade = 0; tp.level = 0; tp.fbW = tp.fbT; continue; }
      const onT = tp.on ? 1 : 0;
      let lev = 0;
      for (let i = 0; i < n; i++) {
        tp.fade += (onT - tp.fade) * cF;
        tp.gS += (tp.gain - tp.gS) * cF;
        tp.plS += (tp.pl - tp.plS) * cF; tp.prS += (tp.pr - tp.prS) * cF;
        tp.fbW += (tp.fbT - tp.fbW) * cF;
        tp.d += (tp.dT - tp.d) * cD;
        const base = (base0 + i) & MASK;
        let sL, sR;
        if (tp.mode === 0) {
          const p = base - tp.d; sL = rd(hL, p); sR = rd(hR, p);
        } else {
          tp.ph += (1 - tp.rate) / tp.W; tp.ph -= Math.floor(tp.ph);
          let ph2 = tp.ph + 0.5; if (ph2 >= 1) ph2 -= 1;
          const p1 = base - tp.d - tp.ph * tp.W, p2 = base - tp.d - ph2 * tp.W;
          const w1 = 0.5 - 0.5 * Math.cos(TWO_PI * tp.ph), w2 = 1 - w1;
          const pL = rd(hL, p1) * w1 + rd(hL, p2) * w2;
          const pR = rd(hR, p1) * w1 + rd(hR, p2) * w2;
          if (tp.mode === 2) {
            tp.xfPh += tp.xfRate; if (tp.xfPh >= 1) tp.xfPh -= 1;
            const x = 0.5 - 0.5 * Math.cos(TWO_PI * tp.xfPh);
            const p0 = base - tp.d;
            sL = rd(hL, p0) * (1 - x) + pL * x; sR = rd(hR, p0) * (1 - x) + pR * x;
          } else { sL = pL; sR = pR; }
        }
        if (tp.ftype) {
          if ((i & 15) === 0) {
            let fc = tp.fc;
            if (tp.ftype === 1) fc = tp.fc * (1 + Math.min(60, tp.env * 90));
            fc = clamp(fc, 20, SR * 0.45);
            const g = Math.tan(Math.PI * fc / SR), kk = 1 / tp.q;
            tp.a1 = 1 / (1 + g * (g + kk)); tp.a2 = g * tp.a1; tp.a3 = g * tp.a2; tp.k = kk;
          }
          if (tp.ftype === 1) {
            const ea = Math.abs(sL + sR) * 0.5;
            tp.env += (ea > tp.env ? 0.02 : 0.0004) * (ea - tp.env);
          }
          const a1 = tp.a1, a2 = tp.a2, a3 = tp.a3;
          let v3 = sL - tp.s2L, v1 = a1 * tp.s1L + a2 * v3, v2 = tp.s2L + a2 * tp.s1L + a3 * v3;
          tp.s1L = 2 * v1 - tp.s1L; tp.s2L = 2 * v2 - tp.s2L;
          let w3 = sR - tp.s2R, w1 = a1 * tp.s1R + a2 * w3, w2 = tp.s2R + a2 * tp.s1R + a3 * w3;
          tp.s1R = 2 * w1 - tp.s1R; tp.s2R = 2 * w2 - tp.s2R;
          if (tp.ftype === 1) { sL = v2 * 0.8; sR = w2 * 0.8; } else { sL = v1 * tp.k * 3.4; sR = w1 * tp.k * 3.4; }
        }
        const g = tp.gS * tp.fade;
        wL[i] += sL * g * tp.plS; wR[i] += sR * g * tp.prS;
        const fw = tp.fade * tp.fbW;
        if (fw > 1e-6) { fbL[i] += sL * fw; fbR[i] += sR * fw; }
        const a = Math.abs(sL) * g; if (a > lev) lev = a;
      }
      tp.level = lev;
    }
  }

  /* ---------------- Onsets & Tonhöhe ---------------- */
  registerOnset(level) {
    const o = this.onsets[this.onsetW];
    o.time = this.clock; o.level = level; o.freq = 0; o.pitchAt = this.clock + Math.floor(0.06 * SR);
    this.onsetW = (this.onsetW + 1) & 15;
    this.onsetCount++;
    this.lastOnsetTime = this.clock;
    this.onsetFlag = 1;
    this.algoOnset(o);
  }
  recentOnsets(maxN, maxAgeSec) { // neueste zuerst
    const out = [];
    for (let k = 1; k <= 16 && out.length < maxN; k++) {
      const o = this.onsets[(this.onsetW - k + 16) & 15];
      const age = this.clock - o.time;
      if (age < 0 || age > maxAgeSec * SR) break;
      out.push(o);
    }
    return out;
  }
  estimatePitch(o) {
    // grobe Autokorrelation (dezimiert um 4) über ~32 ms ab Onset+20 ms
    const D = 4, N = 384;
    const startIdx = (this.w - (this.clock - o.time) + Math.floor(0.02 * SR) + BUF) & MASK;
    const dec = this.decBuf;
    let energy = 0;
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let q = 0; q < D; q++) { const idx = (startIdx + j * D + q) & MASK; s += this.hL[idx] + this.hR[idx]; }
      dec[j] = s; energy += s * s;
    }
    if (energy < 1e-6) return 0;
    const dsr = SR / D;
    const minLag = Math.max(2, Math.floor(dsr / 1200)), maxLag = Math.min(N - 64, Math.floor(dsr / 55));
    let best = 0, bestLag = 0, firstGood = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0, den = 0;
      for (let j = 0; j + lag < N; j++) { num += dec[j] * dec[j + lag]; den += dec[j] * dec[j] + dec[j + lag] * dec[j + lag]; }
      const r = den > 0 ? 2 * num / den : 0;
      if (r > best) { best = r; bestLag = lag; }
      if (!firstGood && r > 0.85) firstGood = lag;
    }
    const lag = firstGood || bestLag;
    if (best < 0.5 || !lag) return 0;
    return dsr / lag;
  }

  /* ---------------- Effekt-Algorithmen ---------------- */
  resetAlgo() {
    const fx = this.effect;
    const a = this.algo = { lanes: [], pat: [], hazeCount: 0, hazeLag: 0, arpPos: 0, glitchLeft: 0, cascadeAt: 0 };
    const spu = [1, 4, 2, 1, 1, 4, 4, 4, 2, 1, 1][fx];
    this.stepsPerUnit = fx === FX.MOSAIC ? 1 + Math.floor(this.A * 5.99) : spu;
    this.stepPos = 1e9;
    this.duckOn = false;
    this.hazeFb = 0;
    for (let l = 0; l < 4; l++) a.pat.push(this.makeSeqPattern(l));
    this.updateTaps();
  }
  makeSeqPattern(layer) {
    const A = this.A, va = this.variation, r = this.rng;
    const steps = [];
    let euclid = null;
    if (va === 3) {
      const pulses = [3, 5, 2][layer % 3];
      euclid = []; for (let j = 0; j < 8; j++) euclid.push(Math.floor((j * pulses) / 8) !== Math.floor(((j - 1 + 8) * pulses) / 8) || j === 0);
      const rot = layer * 2; euclid = euclid.slice(rot).concat(euclid.slice(0, rot));
    }
    for (let j = 0; j < 8; j++) {
      steps.push({
        on: euclid ? euclid[j] : r.next() < 0.55 + 0.35 * A,
        back: 1 + r.int(8),
        fc: 250 * Math.pow(2, r.next() * 5),
        filt: r.next() < A,
        up: r.next() < 0.5,
      });
    }
    return steps;
  }

  stepLength() { return this.U / this.stepsPerUnit; }

  algoStep(step, off, now) {
    const fx = this.effect, va = this.variation, A = this.A, R = this.R, U = this.U, r = this.rng;
    const stepLen = this.stepLength();
    const dir = (this.revFx !== this.shapeEnv.rev) ? -1 : 1;
    const a = this.algo;
    switch (fx) {
      case FX.MOSAIC: {
        const N = this.stepsPerUnit;
        const k = step % N;
        const rates = [[1, 2], [1, 0.5], [2], [0.5, 1, 2, 4]][va];
        const rate = rates[(N === 1 ? step : k) % rates.length];
        const seg = clamp(U, 0.03 * SR, 3 * SR);
        const dur = U * (1 + R * 7);
        const gain = (rate >= 4 ? 0.5 : 0.75) / Math.sqrt(N * (1 + R * 2));
        const pan = N > 1 ? ((k / (N - 1)) * 2 - 1) * 0.75 : 0;
        this.spawn(off, now, 0, seg, rate * dir, dur, gain, pan, { tau: dur * 0.4 });
        break;
      }
      case FX.SEQ: {
        const layers = va === 2 ? 1 + Math.floor(A * 3.99) : va === 3 ? 1 + Math.floor(A * 2.99) : 1;
        const idx = step % 8;
        if (idx === 0) {
          for (let l = 0; l < 4; l++) if (r.next() < (1 - R) * 0.6 + 0.05) a.pat[l] = this.makeSeqPattern(l);
        }
        const seg = clamp(stepLen, 0.02 * SR, SR);
        const evLen = stepLen * (0.6 + R * 2.4);
        for (let l = 0; l < layers; l++) {
          const st = a.pat[l][idx];
          if (!st.on) continue;
          let rate = 1; const o = { tau: evLen * 0.6 };
          if (va === 0) {
            if (st.filt) o.filter = { type: r.next() < 0.5 ? 1 : 2, f0: st.fc, q: 1 + A * 4 };
          } else if (va === 1) {
            const bounce = A < 0.33 ? 4 : A < 0.66 ? 2 : 1;
            rate = Math.floor(step / bounce) % 2 ? 0.5 : 1;
          } else if (va === 2) {
            o.filter = st.up ? { type: 1, f0: 250, f1: 7000, q: 2.5 } : { type: 1, f0: 7000, f1: 250, q: 2.5 };
          } else {
            o.crush = { bits: 7 - l, hold: 2 + l };
          }
          const pan = layers > 1 ? (l / (layers - 1) * 2 - 1) * 0.7 : (r.next() - 0.5) * 0.6;
          this.spawn(off, now, st.back * stepLen, seg, rate * dir, evLen, 0.7 / Math.sqrt(layers), pan, o);
        }
        if (va === 1 && A > 0.95 && idx === 0) {
          this.spawn(off, now, 0, clamp(U, 0.05 * SR, 3 * SR), 0.5 * dir, U * 4, 0.35, 0,
            { env: { att: 0.5, rel: 0.4, perc: 0 }, tau: U * 3, fadeIn: Math.floor(U * 0.5) });
        }
        if (va === 3 && A > 0.95 && idx % 4 === 0) {
          this.spawn(off, now, 0, seg, 0.5 * dir, stepLen * 2, 0.45, 0, { crush: { bits: 4, hold: 6 }, tau: stepLen });
        }
        break;
      }
      case FX.GLIDE: {
        const seg = clamp(U * 0.5, 0.04 * SR, 1.5 * SR);
        const gl = U * lerp(4, 0.25, A);
        const dur = Math.max(gl, U) * (1 + R * 2.5);
        const gs = glideShape(this.S);
        const pairs = [[[0.5, 1]], [[2, 0.5]], [[1, 2]], [[1, 2], [1, 0.5]]][va];
        const env = { att: 0.12, rel: 0.12, perc: 0 };
        const d = this.revFx ? -1 : 1;
        for (let j = 0; j < pairs.length; j++) {
          const pr = pairs[j];
          const pan = pairs.length > 1 ? (j ? 0.55 : -0.55) : (step % 2 ? 0.35 : -0.35);
          this.spawn(off, now, 0, seg, pr[0] * d, dur, 0.6 / Math.sqrt(pairs.length), pan,
            { env, tau: dur * 0.45, glide: { r0: pr[0], r1: pr[1], len: gl, p: gs.p, step: gs.step, ping: gs.ping } });
        }
        break;
      }
      case FX.TUNNEL: {
        const every = Math.max(2, Math.ceil(0.5 * SR / U));
        if (step % every !== 0) break;
        if (this.envSlow < 0.002 && !this.holdOn) break;
        const seg = clamp(U * 0.25, 0.02 * SR, 0.35 * SR);
        const tau = lerp(0.4, 25, R * R) * SR;
        const dur = Math.min(tau * 4, 38 * SR);
        const fadeIn = Math.floor(lerp(1.5 * SR, 0.005 * SR, this.S));
        const env = { att: 0.08, rel: 0.08, perc: 0 };
        const base = { env, tau, fadeIn, fadeOut: Math.floor(0.3 * SR) };
        const pan = (r.next() - 0.5) * 1.2;
        const d = this.revFx ? -1 : 1;
        if (va === 0) {
          this.spawn(off, now, 0, seg, d, dur, 0.42, pan, { ...base, segMod: { depth: A * 0.6, rate: 0.07 + r.next() * 0.25 } });
        } else if (va === 1) {
          const filt = { type: 1, f0: 900, q: 1.6, lfoRate: 0.06 + r.next() * 0.12, lfoDepth: A * 2.5 };
          this.spawn(off, now, 0, seg, d, dur, 0.32, pan, { ...base, filter: filt });
          this.spawn(off, now, 0, seg, 0.5 * d, dur, 0.38, -pan, { ...base, filter: { ...filt, f0: 500 } });
        } else if (va === 2) {
          const fc = 260 * Math.pow(2, r.next() * 3.2);
          this.spawn(off, now, 0, seg, d, dur, 1.15, pan, { ...base, filter: { type: 2, f0: fc, q: 3 + A * 25 } });
        } else {
          this.spawn(off, now, 0, seg, d, dur, 0.42, pan, { ...base, segMod: { env: A * 0.9 } });
        }
        break;
      }
      case FX.STRUM: {
        const since = this.clock - this.lastOnsetTime;
        const maxSteps = 4 + R * 60;
        const stepsSince = since / stepLen;
        if (stepsSince > maxSteps) break;
        const fadeG = Math.exp(-stepsSince / (6 + R * 40));
        if (va === 0) {
          const mod = A < 0.33 ? 4 : A < 0.66 ? 2 : 1;
          if (step % mod !== 0) break;
          const o = this.recentOnsets(1, 30)[0];
          if (o) this.playOnset(off, now, o, Math.min(stepLen * 1.5, 0.5 * SR), dir, 0.75 * fadeG, (r.next() - 0.5) * 0.5, null);
        } else if (va >= 2) {
          if (step % 4 !== 0) break;
          const K = 2 + Math.floor(A * 6);
          const list = this.recentOnsets(K, 30).reverse();
          const spacing = stepLen * 0.5;
          for (let j = 0; j < list.length; j++) {
            const rate = va === 3 && j % 2 === 1 ? 2 : 1;
            const pan = list.length > 1 ? (j / (list.length - 1) * 2 - 1) * 0.7 : 0;
            this.playOnset(off + Math.floor(j * spacing), now, list[j], Math.min(stepLen * 1.5, 0.45 * SR), dir * rate,
              0.6 * fadeG / Math.sqrt(1 + list.length * 0.3), pan, null);
          }
        }
        break;
      }
      case FX.BLOCKS: {
        if (r.next() < 0.1 + R * 0.55) this.blocksGlitch(off, now, stepLen, dir);
        break;
      }
      case FX.INTERRUPT: {
        if (a.glitchLeft > 0) {
          a.glitchLeft--;
          if (a.glitchLeft === 0) this.duckOn = false;
          break;
        }
        if (r.next() < 0.05 + R * 0.55) {
          const steps = 1 + r.int(1 + Math.floor(A * 4));
          a.glitchLeft = steps;
          this.duckOn = true;
          const dur = steps * stepLen;
          if (va === 0) {
            const seg = stepLen / r.pick([2, 4, 8]);
            const back = r.next() < 0.5 ? 0 : r.int(4) * stepLen;
            const rate = A > 0.5 && r.next() < 0.3 ? -1 : 1;
            this.spawn(off, now, back, seg, rate * dir, dur, 0.85, 0, { env: { att: 0.02, rel: 0.02, perc: 0 } });
          } else if (va === 1) {
            const rate = r.pick([0.5, 2, 1.5, 0.75, -1]);
            this.spawn(off, now, r.int(3) * stepLen, stepLen, rate * dir, dur, 0.8, (r.next() - 0.5) * 0.6, { env: { att: 0.05, rel: 0.05, perc: 0 } });
          } else if (va === 2) {
            const sweep = r.next() < 0.5 ? { type: 2, f0: 300, f1: 5000, q: 4 } : { type: 2, f0: 5000, f1: 300, q: 4 };
            for (let j = 0; j < 4; j++) {
              this.spawn(off + Math.floor(j * stepLen * 0.5), now, 0, stepLen, dir, dur, 0.85 * Math.pow(0.6, j), j % 2 ? 0.5 : -0.5,
                { filter: sweep, env: { att: 0.03, rel: 0.2, perc: 0 } });
            }
          } else {
            const seg = stepLen / r.pick([1, 2, 4, 8]);
            const rate = r.pick([1, -1, 2, 0.5, -2]);
            this.spawn(off, now, r.int(4) * stepLen, seg, rate * dir, dur, 0.7, (r.next() - 0.5) * 0.8,
              { crush: { bits: 4 + r.int(4), hold: 2 + r.int(7) }, env: { att: 0.02, rel: 0.02, perc: 0 } });
          }
        }
        break;
      }
      case FX.ARP: {
        const since = this.clock - this.lastOnsetTime;
        if (since / stepLen > 4 + R * 60) break;
        const N = 2 + Math.floor(A * 6.99);
        let notes = this.recentOnsets(N, 20);
        if (!notes.length) break;
        const pitched = notes.every(o => o.freq > 0);
        notes = notes.slice().sort(pitched ? (x, y) => x.freq - y.freq : (x, y) => x.time - y.time);
        const seq = notes.slice();
        for (let j = notes.length - 2; j >= 1; j--) seq.push(notes[j]);
        const idx = a.arpPos++ % seq.length;
        const o = seq[idx];
        let rate = 1; const opt = {};
        if (va === 1) rate = [1, 1.5, 2, 1.5, 1, 0.75, 1.3348, 2][idx % 8];
        else if (va === 2) opt.filter = { type: 1, f0: 300 * Math.pow(2, r.next() * 4.5), q: 1 + r.next() * 5 };
        else if (va === 3) { opt.crush = { bits: 5, hold: 3 }; rate = idx % 2 ? 1 : 0.5; }
        const fadeG = Math.exp(-(since / stepLen) / (8 + R * 40));
        this.playOnset(off, now, o, Math.min(stepLen * (0.7 + 0.6 * R), 0.6 * SR), rate * dir, 0.8 * fadeG,
          ((idx % 4) / 3 - 0.5) * 0.9, opt);
        break;
      }
    }
  }

  playOnset(off, now, o, wantLen, rate, gain, pan, opt) {
    const pre = Math.floor(0.004 * SR);
    const avail = this.clock - o.time + pre;
    if (avail > BUF - 2 * SR) return;
    const ar = Math.abs(rate);
    let seg = Math.min(wantLen * ar, avail, 0.6 * SR * Math.max(1, ar));
    if (seg < 0.015 * SR) return;
    const back = avail - seg;
    const dur = Math.max(wantLen, seg / ar);
    this.spawn(off, now, back, seg, rate, dur, gain, pan, opt || null);
  }

  blocksGlitch(off, now, stepLen, dir) {
    const va = this.variation, A = this.A, r = this.rng;
    if (va === 0) {
      if (r.next() < A * 0.5) {
        const n = 4 + r.int(5), spacing = stepLen / 4;
        const ons = this.recentOnsets(6, 20);
        for (let j = 0; j < n; j++) {
          if (ons.length) this.playOnset(off + Math.floor(j * spacing), now, ons[r.int(ons.length)], spacing, dir, 0.55, (r.next() - 0.5) * 1.2, null);
          else this.spawn(off + Math.floor(j * spacing), now, r.int(8) * spacing, spacing, dir, spacing, 0.55, (r.next() - 0.5) * 1.2, null);
        }
      } else {
        const seg = stepLen * (r.next() < 0.5 ? 1 : 2);
        const rate = r.next() < A * 0.4 ? -1 : 1;
        this.spawn(off, now, (1 + r.int(8)) * stepLen, seg, rate * dir, seg, 0.75, (r.next() - 0.5) * 0.8, null);
      }
    } else if (va === 1) {
      const rate = r.next() < 0.3 + 0.7 * A ? r.pick([0.5, 0.75, 1.5, 2, -1]) : 1;
      const seg = stepLen * (r.next() < 0.6 ? 1 : 2);
      this.spawn(off, now, (1 + r.int(8)) * stepLen, seg * Math.abs(rate), rate * dir, seg, 0.75, (r.next() - 0.5) * 0.9, null);
    } else if (va === 2) {
      const seg = stepLen * 2;
      const tau = stepLen * (1 + 3 * A);
      this.spawn(off, now, r.int(6) * stepLen, seg, dir, stepLen * 4, 0.6, (r.next() - 0.5) * 1.4,
        { filter: { type: 1, f0: 600 + r.next() * 2400, q: 1.2 }, tau, env: { att: 0.1, rel: 0.3, perc: 0 } });
    } else {
      const rate = r.pick([0.5, 0.75, 1.5, 2, -1, 1]);
      const seg = stepLen * (r.next() < 0.5 ? 0.5 : 1);
      this.spawn(off, now, (1 + r.int(8)) * stepLen, seg * Math.abs(rate), rate * dir, seg * 1.5, 0.7, (r.next() - 0.5) * 0.9,
        { crush: { bits: Math.max(3, Math.round(8 - A * 5)), hold: 1 + Math.floor(A * 6) } });
    }
  }

  algoOnset(o) {
    if (this.effect === FX.BLOCKS && this.rng.next() < this.R) {
      // Glitch direkt am Anschlag (nach kurzer Wartezeit, damit Material vorhanden ist)
      this.algo.pendingGlitch = this.clock + Math.floor(0.06 * SR);
    }
  }

  algoSample(i, now) {
    const fx = this.effect;
    const a = this.algo;
    if (fx === FX.HAZE) {
      if (--a.hazeCount > 0) return;
      const A = this.A, va = this.variation, r = this.rng, U = this.U;
      const density = lerp(5, 60, A) * (va === 1 ? 1.6 : 1);
      a.hazeCount = Math.max(1, Math.floor(-Math.log(1 - r.next() * 0.999) * SR / density));
      const glen = clamp(U * 0.25, 0.025 * SR, 0.4 * SR) * (0.6 + r.next() * 0.8);
      const spread = lerp(0.03, 2.0, A) * SR;
      let rate = 1, back;
      if (va === 0) {
        rate = Math.pow(2, (r.next() - 0.5) * 0.02);
        a.hazeLag += 0.75 * (SR / density);
        if (a.hazeLag > spread + glen) a.hazeLag = 0;
        back = a.hazeLag + r.next() * 0.1 * spread;
      } else if (va === 1) {
        rate = Math.pow(2, (r.next() - 0.5) * 0.25 * A);
        if (r.next() < 0.35) rate = -rate;
        back = r.next() * spread;
      } else if (va === 2) {
        rate = r.next() < 0.5 ? 2 : 1; back = r.next() * spread;
      } else {
        rate = r.next() < 0.5 ? 0.5 : 1; back = r.next() * spread;
      }
      if (this.revFx !== this.shapeEnv.rev) rate = -rate;
      const overlap = density * glen / SR;
      const gain = 0.8 / Math.sqrt(1 + overlap);
      this.spawn(i, now, back, glen * Math.abs(rate), rate, glen, gain, (r.next() - 0.5) * 2 * (0.3 + 0.7 * A), null);
    } else if (fx === FX.STRUM && this.variation === 1) {
      const since = this.clock - this.lastOnsetTime;
      const stepLen = this.stepLength();
      const R = this.R;
      if (since / stepLen > 4 + R * 60) return;
      const N = 2 + Math.floor(this.A * 6);
      while (a.lanes.length < 8) a.lanes.push({ t: 0 });
      for (let k = 0; k < N; k++) {
        const lane = a.lanes[k];
        if (--lane.t > 0) continue;
        lane.t = Math.floor(stepLen * (1 + 0.017 * k));
        const o = this.recentOnsets(1, 30)[0];
        if (!o) continue;
        const fadeG = Math.exp(-(since / stepLen) / (6 + R * 40));
        const dir = (this.revFx !== this.shapeEnv.rev) ? -1 : 1;
        this.playOnset(i, now, o, Math.min(stepLen * 1.2, 0.45 * SR), dir, 0.5 * fadeG / Math.sqrt(N), (k / Math.max(1, N - 1) * 2 - 1) * 0.8, null);
      }
    } else if (fx === FX.BLOCKS && a.pendingGlitch && this.clock >= a.pendingGlitch) {
      a.pendingGlitch = 0;
      this.blocksGlitch(i, now, this.stepLength(), (this.revFx !== this.shapeEnv.rev) ? -1 : 1);
    }
  }

  /* ---------------- Hauptverarbeitung ---------------- */
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : null;
    const iR = inp && inp[1] ? inp[1] : iL;
    const p = this.p, lp = this.lp, sm = this.sm;
    const mono = p.mono === 1;
    const inG = this.inGain;

    // Große Speicheroperationen des Loopers stückweise erledigen (nie alles in einem Block)
    if (this.dubSweep) this.pumpDubSweep();
    if (this.loading) this.pumpLoopLoad();
    if (this.xfer) this.pumpLoopExport();
    // Looper-Wiedergabe für diesen Block vorab berechnen
    this.renderLoop(n);
    const loopGT = 1.5 * p.loopLevel * p.loopLevel;
    const bypassed = this.bypass;
    const trails = p.bypassStyle === 1;

    /* ---- Pass 1: Eingang, Verlaufspuffer, Onsets, Scheduler ---- */
    const hL = this.hL, hR = this.hR;
    const rawL = this.rawL, rawR = this.rawR, dryL = this.dryL, dryR = this.dryR;
    const lpL = this.lpL, lpR = this.lpR, duckT = this.duckT;
    const blockW = this.w;
    let w = this.w;
    const muteFx = bypassed || lp.only;
    // PRE-Looper speist den Effekt; bei „Nur Looper“ läuft der Loop schon über den Effektweg (sonst doppelt)
    const preLoop = lp.pre && !lp.only;
    const perSample = this.effect === FX.HAZE || (this.effect === FX.STRUM && this.variation === 1) || this.effect === FX.BLOCKS;
    const holdT = this.holdOn ? 1 : 0, hInc = 1 / DECLICK, hxB = this.holdXB;
    let hx = this.holdX;
    let peakIn = this.peakIn;
    for (let i = 0; i < n; i++) {
      let xL = iL ? iL[i] * inG : 0, xR = iR ? iR[i] * inG : 0;
      if (mono) { const m = (xL + xR) * 0.5; xL = m; xR = m; }
      rawL[i] = xL; rawR[i] = xR;
      const ai = Math.abs(xL) > Math.abs(xR) ? Math.abs(xL) : Math.abs(xR); if (ai > peakIn) peakIn = ai;
      if (preLoop) { xL += lpL[i] * loopGT; xR += lpR[i] * loopGT; }
      dryL[i] = xL; dryR[i] = xR;
      // Verlaufspuffer: Eingang bzw. Hold-Material, beim Umschalten kurz überblendet.
      // Das Feedback der Delays kommt erst in Pass 2 hinzu (an derselben Stelle, ohne Blockverzögerung).
      let hl = muteFx ? 0 : xL, hr = muteFx ? 0 : xR;
      if (hx !== holdT) hx = holdT > hx ? Math.min(1, hx + hInc) : Math.max(0, hx - hInc);
      if (hx > 0) {
        hl += (this.holdL[this.holdPos] - hl) * hx; hr += (this.holdR[this.holdPos] - hr) * hx;
        if (++this.holdPos >= this.holdLen) this.holdPos = 0;
      }
      hxB[i] = hx;
      hL[w] = hl; hR[w] = hr;
      // Onset-Erkennung auf dem Effekt-Eingang
      const m = Math.abs(hl + hr) * 0.5;
      this.envF += (m > this.envF ? this.cEnvAF : this.cEnvRF) * (m - this.envF);
      this.envS += (m > this.envS ? this.cEnvAS : this.cEnvRS) * (m - this.envS);
      this.envSlow += (m - this.envSlow) * 0.00005;
      if (this.envF > this.envS * 1.7 + 0.006 && this.envF > 0.012 && this.clock - this.lastOnsetTime > 0.08 * SR) this.registerOnset(this.envF);
      this.clock++;
      // Tempo-Raster
      this.beatPos++;
      if (this.beatPos >= this.spb) { this.beatPos -= this.spb; this.beatCount++; }
      this.stepPos++;
      const sl = this.stepLength();
      if (this.stepPos >= sl) {
        this.stepPos = this.stepPos >= sl * 2 ? 0 : this.stepPos - sl;
        this.stepIdx++;
        if (!muteFx || this.holdOn) this.algoStep(this.stepIdx, i, w);
      }
      if (perSample && (!muteFx || this.holdOn)) this.algoSample(i, w);
      duckT[i] = this.duckOn && !bypassed ? 0 : 1;
      w = (w + 1) & MASK;
    }
    this.w = w;
    this.holdX = hx;
    this.peakIn = peakIn;
    // ausstehende Tonhöhen-Schätzungen
    for (const o of this.onsets) if (o.pitchAt && this.clock >= o.pitchAt) { o.pitchAt = 0; o.freq = this.estimatePitch(o); }

    /* ---- Pass 2: Effekt rendern ---- */
    const wetL = this.wetL, wetR = this.wetR;
    wetL.fill(0, 0, n); wetR.fill(0, 0, n);
    this.fbNL.fill(0, 0, n); this.fbNR.fill(0, 0, n);
    this.renderVoices(n, wetL, wetR);
    if (this.effect === FX.PATTERN || this.effect === FX.WARP || this.taps.some(t => t.fade > 1e-4)) this.renderTaps(n, blockW, wetL, wetR);

    // Feedback (Delay-Wiederholungen / Haze-Wolke) direkt an die Stelle dieses Blocks im Verlaufspuffer
    // schreiben. Früher landete es erst im nächsten Block – jede Wiederholung kam dadurch 128 Samples zu
    // spät und lief bei hohem Feedback hörbar aus dem Takt. Taps lesen mindestens TAP_MIN > Blockgröße zurück.
    const fbG = this.fbTap >= 0 ? this.fbGain : 0;
    const hazeFbT = this.effect === FX.HAZE ? this.R * 0.62 : 0;
    this.hazeFb += (hazeFbT - this.hazeFb) * 0.05;
    const nfL = this.fbNL, nfR = this.fbNR, cF = this.cTapFade, hazeFb = this.hazeFb;
    let fbGs = this.fbGs;
    for (let i = 0; i < n; i++) {
      fbGs += (fbG - fbGs) * cF;
      const fl = nfL[i] * fbGs + wetL[i] * hazeFb;
      const fr = nfR[i] * fbGs + wetR[i] * hazeFb;
      this.fbDampL += (fl - this.fbDampL) * 0.5; this.fbDampR += (fr - this.fbDampR) * 0.5;
      const g = 1 - hxB[i]; // Hold ersetzt den Pufferinhalt komplett
      if (g > 0) {
        const k = (blockW + i) & MASK;
        hL[k] += softClip(this.fbDampL) * g; hR[k] += softClip(this.fbDampR) * g;
      }
    }
    this.fbGs = fbGs;

    /* ---- Pass 3: Modulation, Filter, Mix, Looper, Raum, Bypass ---- */
    const cS = this.cSm * 1;
    const mixT = p.mix;
    const mixDT = Math.min(1, 2 * (1 - mixT)), mixWT = Math.min(1, 2 * mixT);
    const spT = p.space;
    const spDT = Math.min(1, 2 * (1 - spT)), spWT = Math.min(1, 2 * spT) * 0.9;
    const effVolT = 4 * p.effVol * p.effVol * WET_NORM[this.effect];
    const killT = clamp(p.filter / 0.05, 0, 1);
    const fcT = p.filter > 0.985 ? SR * 0.45 : Math.min(SR * 0.45, 30 * Math.pow(2, p.filter * 9.5));
    const qT = 0.6 * Math.pow(2, p.resonance * 4.3);
    const modDT = p.modDepth * p.modDepth * 0.006 * SR;
    const modInc = 0.05 * Math.pow(2, p.modRate * 7.5) / SR;
    // Filterkoeffizienten einmal pro Block (geglättet)
    sm.fc *= Math.pow(fcT / sm.fc, Math.min(1, n / (0.03 * SR)));
    sm.q += (qT - sm.q) * Math.min(1, n / (0.03 * SR));
    const fg = Math.tan(Math.PI * clamp(sm.fc, 20, SR * 0.45) / SR), fk = 1 / sm.q;
    const fa1 = 1 / (1 + fg * (fg + fk)), fa2 = fg * fa1, fa3 = fg * fa2;
    const filterOn = sm.fc < SR * 0.44 || p.resonance > 0.2;
    const byNT = bypassed && !trails ? 1 : 0;
    const byTT = bypassed && trails ? 1 : 0;
    const space = this.space, modL = this.modL, modR = this.modR;
    let peakL = this.peakL, peakR = this.peakR;
    let duck = sm.duck;
    for (let i = 0; i < n; i++) {
      sm.mixD += (mixDT - sm.mixD) * cS; sm.mixW += (mixWT - sm.mixW) * cS;
      sm.spD += (spDT - sm.spD) * cS; sm.spW += (spWT - sm.spW) * cS;
      sm.effVol += (effVolT - sm.effVol) * cS; sm.kill += (killT - sm.kill) * cS;
      sm.modD += (modDT - sm.modD) * cS; sm.loopG += (loopGT - sm.loopG) * cS;
      this.byN += (byNT - this.byN) * this.cByp; this.byT += (byTT - this.byT) * this.cByp;
      let wl = wetL[i], wr = wetR[i];
      const lpl = lpL[i] * sm.loopG, lpr = lpR[i] * sm.loopG;
      if (lp.only) { wl = lpl; wr = lpr; }
      // Pitch-Modulation (Vibrato über modulierte Verzögerung)
      modL[this.modW] = wl; modR[this.modW] = wr;
      this.modPh += modInc; if (this.modPh >= 1) this.modPh -= 1;
      if (sm.modD > 0.5) {
        const s = Math.sin(TWO_PI * this.modPh), c = Math.cos(TWO_PI * this.modPh);
        const dl = 1 + sm.modD * (1 + s), dr = 1 + sm.modD * (1 + c);
        let pl = this.modW - dl; if (pl < 0) pl += MOD_SIZE;
        let pr = this.modW - dr; if (pr < 0) pr += MOD_SIZE;
        const l0 = pl | 0, lf = pl - l0, r0 = pr | 0, rf = pr - r0;
        wl = modL[l0 & MOD_MASK] + (modL[(l0 + 1) & MOD_MASK] - modL[l0 & MOD_MASK]) * lf;
        wr = modR[r0 & MOD_MASK] + (modR[(r0 + 1) & MOD_MASK] - modR[r0 & MOD_MASK]) * rf;
      }
      this.modW = (this.modW + 1) & MOD_MASK;
      // Resonanz-Tiefpass am Ende der Effektkette
      if (filterOn) {
        let v3 = wl - this.fs2L, v1 = fa1 * this.fs1L + fa2 * v3, v2 = this.fs2L + fa2 * this.fs1L + fa3 * v3;
        this.fs1L = 2 * v1 - this.fs1L; this.fs2L = 2 * v2 - this.fs2L; wl = v2;
        let w3 = wr - this.fs2R, w1 = fa1 * this.fs1R + fa2 * w3, w2 = this.fs2R + fa2 * this.fs1R + fa3 * w3;
        this.fs1R = 2 * w1 - this.fs1R; this.fs2R = 2 * w2 - this.fs2R; wr = w2;
      } else { this.fs1L = this.fs2L = this.fs1R = this.fs2R = 0; }
      const wg = sm.kill * sm.effVol * sm.mixW;
      wl *= wg; wr *= wg;
      duck += (duckT[i] - duck) * this.cDuck;
      const dg = sm.mixD * (this.byT > 0 ? lerp(duck, 1, this.byT) : duck) * (1 - this.byT);
      let dl_ = dryL[i] * dg, dr_ = dryR[i] * dg;
      // POST-Looper: nimmt die Effekt-Summe auf und spielt danach ein
      let mL = dl_ + wl, mR = dr_ + wr;
      if (lp.pre) this.loopWrite(i, rawL[i], rawR[i]);
      else {
        this.loopWrite(i, mL, mR);
        if (!lp.only) { mL += lpl; mR += lpr; }
      }
      // Raum
      space.process(mL, mR);
      let outL = mL * sm.spD + space.oL * sm.spW + rawL[i] * this.byT;
      let outR = mR * sm.spD + space.oR * sm.spW + rawR[i] * this.byT;
      if (this.byN > 1e-4) { outL = outL * (1 - this.byN) + rawL[i] * this.byN; outR = outR * (1 - this.byN) + rawR[i] * this.byN; }
      outL = softClip(outL); outR = softClip(outR);
      oL[i] = outL; if (oR !== oL) oR[i] = outR;
      const al = outL < 0 ? -outL : outL, ar = outR < 0 ? -outR : outR;
      if (al > peakL) peakL = al; if (ar > peakR) peakR = ar;
    }
    sm.duck = duck;
    this.peakL = peakL; this.peakR = peakR;
    // NaN/Inf im Ausgang (z. B. durch ungültige Werte) würde Filter und Hall dauerhaft lahmlegen → abfangen
    if (!(Number.isFinite(oL[n - 1]) && Number.isFinite(oR[n - 1]))) this.recover(oL, oR, n);

    if (++this.postCounter >= this.postEvery) { this.postCounter = 0; this.postState(); }
    return true;
  }

  postState() {
    const vb = this.visBuf; let nv = 0;
    for (const v of this.voices) {
      if (!v.active || v.delay > 0) continue;
      let p = v.start + v.phase; if (p >= BUF) p -= BUF;
      const age = ((this.w - p) & MASK) / SR;
      vb[nv * 4] = age; vb[nv * 4 + 1] = v.rate; vb[nv * 4 + 2] = Math.min(1.5, Math.abs(v.level) * 2); vb[nv * 4 + 3] = v.pr - v.pl;
      nv++;
    }
    let nt = 0;
    const tb = new Float32Array(NUM_TAPS * 3);
    for (const tp of this.taps) {
      if (tp.fade < 0.01) continue;
      tb[nt * 3] = tp.d / SR; tb[nt * 3 + 1] = tp.level * 3; tb[nt * 3 + 2] = tp.pr - tp.pl; nt++;
    }
    const msg = {
      type: 'state',
      voices: vb.slice(0, nv * 4), taps: tb.slice(0, nt * 3),
      peakIn: this.peakIn, peakL: this.peakL, peakR: this.peakR,
      bpm: this.bpm, beat: this.beatCount, beatPhase: this.beatPos / this.spb, unitSec: this.U / SR,
      hold: this.holdOn, holdLen: this.holdLen / SR, holdPos: this.holdLen ? this.holdPos / this.holdLen : 0,
      loop: { st: this.lp.st, len: this.lp.len / SR, pos: this.lp.len ? this.lp.pos / this.lp.len : 0, rec: this.lp.rec / SR, dubOn: this.lp.dubOn, hasDub: this.lp.hasDub, rev: this.lp.rev, speed: this.lp.speed },
      onset: this.onsetFlag, duck: this.sm.duck,
    };
    this.onsetFlag = 0;
    this.peakIn *= 0.5; this.peakL *= 0.5; this.peakR *= 0.5;
    if (++this.waveCounter >= 3) {
      this.waveCounter = 0;
      const bins = 360, span = Math.floor(6 * SR), per = Math.floor(span / bins), stride = Math.max(1, per >> 4);
      const wv = new Float32Array(bins);
      for (let b = 0; b < bins; b++) {
        let mx = 0;
        const s0 = this.w - span + b * per;
        for (let j = 0; j < per; j += stride) {
          const idx = (s0 + j + BUF) & MASK;
          const a = Math.abs(this.hL[idx]) + Math.abs(this.hR[idx]);
          if (a > mx) mx = a;
        }
        wv[b] = mx * 0.5;
      }
      msg.wave = wv;
    }
    this.port.postMessage(msg);
  }
}

registerProcessor('orbit-processor', OrbitProcessor);
