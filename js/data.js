// Effekt-, Regler- und MIDI-Definitionen

export const CATEGORIES = [
  { id: 'micro', name: 'Micro-Loop', color: 'var(--cat-micro)' },
  { id: 'gran', name: 'Granular', color: 'var(--cat-gran)' },
  { id: 'glitch', name: 'Glitch', color: 'var(--cat-glitch)' },
  { id: 'delay', name: 'Multidelay', color: 'var(--cat-delay)' },
];

// Reihenfolge = Index im DSP-Kern
export const EFFECTS = [
  {
    name: 'MOSAIC', cat: 0,
    desc: 'Überlappende Micro-Loops, die gleichzeitig in mehreren Geschwindigkeiten laufen.',
    act: 'Anzahl aktiver Looper (1–6)', rep: 'Wie lange die Loops ausklingen',
    vars: ['Normal + doppelt schnell (Oktave hoch)', 'Normal + halb schnell (Oktave tief)', 'Alle Loops doppelt schnell', '½×, 1×, 2× und 4× (−1 bis +2 Oktaven)'],
    sugg: { activity: 0.45, repeats: 0.55, shape: 0.45, time: 0.42 },
  },
  {
    name: 'SEQ', cat: 0,
    desc: 'Kurze Loop-Schnipsel werden zu neuen Rhythmen umsortiert.',
    act: 'Je nach Variante: Filtervariationen, Bounce-Rate oder Ebenen', rep: 'Länge der Schnipsel und Stabilität des Musters',
    vars: ['Zufallsrhythmen mit wechselnden Filtern', 'Wechsel normal/halb schnell, voll aufgedreht mit Pad-Ebene', 'Überlagerte Ebenen mit Filter-Sweeps', 'Verzahnte Rhythmen mit Bitcrusher, voll aufgedreht mit Sub-Oktave'],
    sugg: { activity: 0.55, repeats: 0.35, shape: 0.62, time: 0.42 },
  },
  {
    name: 'GLIDE', cat: 0,
    desc: 'Kurze überlappende Loops gleiten in der Tonhöhe.',
    act: 'Geschwindigkeit des Glides', rep: 'Ausklingdauer', shapeNote: 'Glide-Kurve (Ease-in, linear, Ease-out, Stufen, Ping-Pong)',
    vars: ['Von halber zu normaler Geschwindigkeit', 'Von doppelter zu halber Geschwindigkeit', 'Von normaler zu doppelter Geschwindigkeit', 'In beide Richtungen gleichzeitig'],
    sugg: { activity: 0.4, repeats: 0.5, shape: 0.42, time: 0.42 },
  },
  {
    name: 'HAZE', cat: 1,
    desc: 'Wolken aus Grains erzeugen eine Klangfläche.',
    act: 'Dichte und Streuung der Grains', rep: 'Rückkopplung der Wolke (Sustain)',
    vars: ['Kurz, diffus, gedehnte Überlappungen', 'Viele zufällige Grains (auch rückwärts)', 'Mischung aus normalen und doppelt schnellen Grains', 'Mischung aus normalen und halb schnellen Grains'],
    sugg: { activity: 0.55, repeats: 0.4, shape: 0.45, time: 0.42 },
  },
  {
    name: 'TUNNEL', cat: 1,
    desc: 'Zyklische Micro-Loops werden zu Drones.',
    act: 'Tiefe des jeweiligen Modulators', rep: 'Wie lange der Drone ausklingt', shapeNote: 'Einschwingen des Drones (links langsam, rechts sofort)',
    vars: ['Drone-Länge staucht und dehnt sich', 'Sub-Oktav-Drone mit Filter-Sweeps', 'Resonante Bandpässe auf dem Drone', 'Hüllkurvengesteuertes Stauchen/Dehnen'],
    sugg: { activity: 0.5, repeats: 0.7, shape: 0.3, time: 0.42 },
  },
  {
    name: 'STRUM', cat: 2,
    desc: 'Rhythmische Ketten aus den zuletzt gespielten Anschlägen.',
    act: 'Dichte des Musters', rep: 'Wie lange nach dem letzten Anschlag weitergespielt wird',
    vars: ['Wiederholt den letzten Ton', 'Viele phasende Kopien des letzten Anschlags', 'Kaskaden der letzten Anschläge', 'Kaskaden mit doppelt schnellen Grains'],
    sugg: { activity: 0.5, repeats: 0.4, shape: 0.8, time: 0.58 },
  },
  {
    name: 'BLOCKS', cat: 2,
    desc: 'Der Eingang löst Glitches oder zufällige Ton-Bursts aus.',
    act: 'Variation und Sample-Manipulation', rep: 'Wie oft Glitches ausgelöst werden',
    vars: ['Umsortieren plus Bursts aus den letzten Tönen', 'Umsortieren mit Tonhöhenverschiebung', 'Gefilterte, ausblendende Überlappungen (sanft)', 'Tonhöhe + Bitcrusher'],
    sugg: { activity: 0.5, repeats: 0.45, shape: 0.62, time: 0.42 },
  },
  {
    name: 'INTERRUPT', cat: 2,
    desc: 'Glitches unterbrechen das trockene Signal. Bei Mix 100 % ist das Direktsignal stumm.',
    act: 'Variation und Manipulation', rep: 'Wie oft Glitches auftreten',
    vars: ['Stotter-Glitches (CD-Sprung), umsortiert', 'Tonhöhenverschobene Samples', 'Filter-Sweeps und Echos', 'Bitcrusher und drastische Manipulation'],
    sugg: { activity: 0.45, repeats: 0.4, shape: 0.62, time: 0.42 },
  },
  {
    name: 'ARP', cat: 2,
    desc: 'Die zuletzt gespielten Töne werden als Arpeggio sequenziert (nach erkannter Tonhöhe sortiert).',
    act: 'Anzahl der Arpeggio-Schritte (2–8)', rep: 'Notenlänge und Nachlaufzeit',
    vars: ['Einfaches Arpeggio', 'Wechselnde Geschwindigkeiten (Tonhöhen-Muster)', 'Zufälliger Filter je Schritt', 'Bitcrusher + Sub-Oktave (Synth-Bass)'],
    sugg: { activity: 0.45, repeats: 0.4, shape: 0.72, time: 0.58 },
  },
  {
    name: 'PATTERN', cat: 3,
    desc: 'Delay-Taps in vier rhythmischen Mustern.',
    act: 'Anzahl aktiver Taps (1–8)', rep: 'Wiederholungen (Feedback)', shapeNote: 'Lautstärkekurve über die Taps (ansteigend ↔ abfallend)',
    vars: ['Klassisches lineares Delay', 'Muster 2: punktiert', 'Muster 3: triolisch', 'Muster 4: geclustert'],
    sugg: { activity: 0.3, repeats: 0.45, shape: 0.6, time: 0.42 },
  },
  {
    name: 'WARP', cat: 3,
    desc: 'Delay-Taps, geformt durch Filter und Tonhöhenverschiebung.',
    act: 'Anzahl aktiver Taps (1–8)', rep: 'Wiederholungen (Feedback)',
    vars: ['Hüllkurvengesteuerter Filter je Tap', 'Resonanter Bandpass je Tap', 'Pitch-Shifting auf den Taps', 'Taps blenden mit doppelt schnellen Grains über'],
    sugg: { activity: 0.4, repeats: 0.45, shape: 0.6, time: 0.42 },
  },
];

export const SUBDIV_LABELS = ['¼×', '½×', 'TAP', '2×', '4×', '8×'];
export const SUBDIV_SHORT = ['4 Schläge', '2 Schläge', '1 Schlag', '½ Schlag', '¼ Schlag', '⅛ Schlag'];
export const SUBDIV_LONG = ['Viertel-Tempo (4 Schläge)', 'Halbes Tempo (2 Schläge)', 'Tap-Tempo (1 Schlag)', 'Doppelt (½ Schlag)', 'Vierfach (¼ Schlag)', 'Achtfach (⅛ Schlag)'];
export const REVERB_MODES = ['Heller Raum', 'Dunkel, mittel', 'Große Halle', 'Ambient'];

const pct = (v) => Math.round(v * 100) + ' %';

// Acht Regler, je mit Primär- und Shift-Funktion
export const KNOBS = [
  { id: 'k1', main: { key: 'activity', label: 'Aktivität', def: 0.5, fmt: pct }, alt: { key: 'revTime', label: 'Hallzeit', def: 0.5, fmt: (v) => '×' + Math.pow(2, (v - 0.5) * 2.4).toFixed(2) } },
  { id: 'k2', main: { key: 'repeats', label: 'Wiederholung', def: 0.5, fmt: pct }, alt: { key: 'modDepth', label: 'Mod-Tiefe', def: 0, fmt: pct } },
  { id: 'k3', main: { key: 'shape', label: 'Form', def: 0.45, fmt: shapeLabel }, alt: { key: 'modRate', label: 'Mod-Rate', def: 0.35, fmt: (v) => (0.05 * Math.pow(2, v * 7.5)).toFixed(2) + ' Hz' } },
  { id: 'k4', main: { key: 'time', label: 'Zeit', def: 0.42, fmt: null }, alt: { key: 'loopSpeed', label: 'Loop-Tempo', def: 0.5, fmt: loopSpeedLabel } },
  { id: 'k5', main: { key: 'filter', label: 'Filter', def: 1, fmt: filterLabel }, alt: { key: 'resonance', label: 'Resonanz', def: 0.15, fmt: (v) => 'Q ' + (0.6 * Math.pow(2, v * 4.3)).toFixed(1) } },
  { id: 'k6', main: { key: 'mix', label: 'Mix', def: 0.5, fmt: (v) => Math.round(v * 100) + ' % nass' }, alt: { key: 'effVol', label: 'Effekt-Vol', def: 0.5, fmt: (v) => { const g = 4 * v * v; return g < 0.001 ? '−∞ dB' : (20 * Math.log10(g)).toFixed(1) + ' dB'; } } },
  { id: 'k7', main: { key: 'space', label: 'Raum', def: 0.3, fmt: pct }, alt: { key: 'reverbMode', label: 'Hall-Typ', def: 0.3, fmt: (v) => REVERB_MODES[Math.min(3, Math.floor(v * 4))], steps: 4 } },
  { id: 'k8', main: { key: 'loopLevel', label: 'Loop-Pegel', def: 0.82, fmt: pct }, alt: { key: 'fadeTime', label: 'Fade-Zeit', def: 0.1, fmt: (v) => (v * v * 8).toFixed(2) + ' s' } },
];

export function shapeLabel(v) {
  if (v < 0.2) return 'Rückwärts';
  if (v < 0.4) return 'Schwellen';
  if (v < 0.56) return 'Weich';
  if (v < 0.72) return 'Gate';
  return 'Perkussiv';
}
export function glideShapeLabel(v) {
  if (v < 0.3) return 'Ease-in';
  if (v < 0.55) return 'Linear';
  if (v < 0.75) return 'Ease-out';
  if (v < 0.9) return 'Stufen';
  return 'Ping-Pong';
}
export function filterLabel(v) {
  if (v > 0.985) return 'offen';
  if (v < 0.02) return 'Effekt aus';
  const f = 30 * Math.pow(2, v * 9.5);
  return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz';
}
export function loopSpeedLabel(v) {
  const s = Math.abs(v - 0.5) < 0.025 ? 1 : Math.pow(2, (v - 0.5) * 4);
  return s.toFixed(2) + '×';
}
export function timeLabel(v, timeMode) {
  if (timeMode === 1) return Math.round(40 + v * 200) + ' BPM';
  return SUBDIV_LABELS[Math.min(5, Math.floor(v * 6))];
}

export const DEFAULT_PARAMS = {
  activity: 0.5, repeats: 0.5, shape: 0.45, time: 0.42, filter: 1, mix: 0.5, space: 0.3, loopLevel: 0.82,
  revTime: 0.5, modDepth: 0, modRate: 0.35, loopSpeed: 0.5, resonance: 0.15, effVol: 0.5, reverbMode: 0.3, fadeTime: 0.1,
  timeMode: 0, effect: 0, variation: 0, effRev: 0,
};

export const DEFAULT_GLOBAL = {
  mono: 1,            // Eingangsmodus: 1 Mono, 0 Stereo
  fadeShape: 0,       // Looper-Fade: 0 Ein/Aus, 1 nur Ein, 2 nur Aus, 3 keiner
  midiChannel: 0,     // 0 = Omni, sonst 1–16
  midiClock: 1,       // externer MIDI-Clock wird übernommen
  inputLine: 0,       // 0 Instrument, 1 Line
  holdMode: 0,        // 0 Umschalten, 1 Momentan
  bypassStyle: 0,     // 0 ohne Trails, 1 mit Trails, 2 True Bypass
  looperOrder: 0,     // 0 Rec>Play>Dub, 1 Rec>Dub>Play
  suggest: 1,         // Vorschlagswerte bei Effektwechsel laden
  expCC: 4,           // Expression-Pedal per MIDI-CC
  expTarget: 'activity',
};

// MIDI-CC-Belegung (orientiert an der Implementierungstabelle des Originals)
export const MIDI_CC = {
  5: { kind: 'subdiv' }, 6: { kind: 'param', key: 'activity' }, 7: { kind: 'param', key: 'shape' },
  8: { kind: 'param', key: 'filter' }, 9: { kind: 'param', key: 'mix' }, 10: { kind: 'param', key: 'time' },
  11: { kind: 'param', key: 'repeats' }, 12: { kind: 'param', key: 'space' }, 13: { kind: 'param', key: 'loopLevel' },
  14: { kind: 'param', key: 'modRate' }, 15: { kind: 'param', key: 'resonance' }, 16: { kind: 'param', key: 'effVol' },
  17: { kind: 'param', key: 'loopSpeed' }, 18: { kind: 'loopSpeedStep' }, 19: { kind: 'param', key: 'modDepth' },
  20: { kind: 'param', key: 'revTime' }, 21: { kind: 'param', key: 'fadeTime' },
  22: { kind: 'toggle', key: 'looperMode' }, 23: { kind: 'toggle', key: 'loopRev' }, 24: { kind: 'toggle', key: 'pre' },
  25: { kind: 'toggle', key: 'only' }, 26: { kind: 'toggle', key: 'burst' }, 27: { kind: 'toggle', key: 'quant' },
  28: { kind: 'looper', cmd: 'rec' }, 29: { kind: 'looper', cmd: 'play' }, 30: { kind: 'looper', cmd: 'dub' },
  31: { kind: 'looper', cmd: 'stop' }, 34: { kind: 'looper', cmd: 'erase' }, 35: { kind: 'looper', cmd: 'undo' },
  46: { kind: 'savePreset' }, 47: { kind: 'toggle', key: 'effRev' }, 48: { kind: 'toggle', key: 'hold' },
  93: { kind: 'tap' }, 102: { kind: 'bypassCC' },
};
// Programmwechsel 1–44 (Reihenfolge des Originals), 45–60 = User-Presets
export const PC_ORDER = ['ARP', 'INTERRUPT', 'BLOCKS', 'GLIDE', 'SEQ', 'MOSAIC', 'HAZE', 'TUNNEL', 'STRUM', 'PATTERN', 'WARP'];

export const BANKS = [
  { name: 'Rot', color: 'var(--bank-red)' },
  { name: 'Gelb', color: 'var(--bank-yellow)' },
  { name: 'Grün', color: 'var(--bank-green)' },
  { name: 'Blau', color: 'var(--bank-blue)' },
];

/* ---------- Prüfung von gespeicherten oder importierten Werten ----------
 * Presets, Exportdateien und localStorage können alte, kaputte oder fremde Werte enthalten.
 * Ein effect außerhalb 0–10 ließ früher die Oberfläche und den Audio-Prozessor abstürzen. */
const PARAM_INT = { timeMode: [0, 1], effect: [0, EFFECTS.length - 1], variation: [0, 3], effRev: [0, 1] };
const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));

export function sanitizeParams(src) {
  const out = { ...DEFAULT_PARAMS };
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(DEFAULT_PARAMS)) {
    let v = src[k];
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = PARAM_INT[k];
    out[k] = r ? clampNum(Math.round(v), r[0], r[1]) : clampNum(v, 0, 1);
  }
  return out;
}

export function sanitizeLooperOpts(src) {
  const out = { pre: false, quant: false, only: false, burst: false };
  if (src && typeof src === 'object') for (const k of Object.keys(out)) if (k in src) out[k] = !!src[k];
  return out;
}

export function sanitizePreset(p) {
  if (!p || typeof p !== 'object') return null;
  const params = sanitizeParams(p.params);
  const name = typeof p.name === 'string' && p.name.trim()
    ? p.name.trim().slice(0, 24)
    : `${EFFECTS[params.effect].name.slice(0, 5)} ${'ABCD'[params.variation]}`;
  return {
    name, params, looperOpts: sanitizeLooperOpts(p.looperOpts),
    hasLoop: !!p.hasLoop, savedAt: Number.isFinite(p.savedAt) ? p.savedAt : 0,
  };
}

export const EXP_TARGETS = ['activity', 'repeats', 'shape', 'filter', 'mix', 'space', 'loopLevel'];
const GLOBAL_RANGE = {
  mono: [0, 1], fadeShape: [0, 3], midiChannel: [0, 16], midiClock: [0, 1], inputLine: [0, 1],
  holdMode: [0, 1], bypassStyle: [0, 2], looperOrder: [0, 1], suggest: [0, 1], expCC: [1, 127],
};
/** Ungültige Einträge fallen auf base zurück (beim Laden die Standardwerte, beim Ändern der bisherige Wert). */
export function sanitizeGlobal(src, base = DEFAULT_GLOBAL) {
  const out = { ...DEFAULT_GLOBAL, ...base };
  if (!src || typeof src !== 'object') return out;
  for (const [k, [a, b]] of Object.entries(GLOBAL_RANGE)) {
    const raw = src[k];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out[k] = clampNum(Math.round(v), a, b);
  }
  if (EXP_TARGETS.includes(src.expTarget)) out.expTarget = src.expTarget;
  return out;
}
