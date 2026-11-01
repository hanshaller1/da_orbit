// Audio-Engine: AudioContext, Worklet-Knoten, Eingangsquellen, Aufnahme
import { makeDemoBuffer, DEMO_BPM } from './demo.js';

const SRC_FADE = 0.004;   // Zeitkonstante der Quellen-Überblendung (s)
const LOOP_MAX_SEC = 60;  // so lang darf ein Loop im Prozessor sein

// Wird geworfen, wenn eine Quellenanfrage von einer neueren überholt wurde (z. B. Freigabedialog noch offen,
// inzwischen aber schon die Demo gewählt). Das ist kein Fehler, der angezeigt werden muss.
export function supersededError() {
  const e = new Error('Quelle wurde inzwischen gewechselt');
  e.name = 'SupersededError';
  return e;
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null; this.node = null; this.initPromise = null;
    this.source = null; this.srcGain = null; this.sourceKind = 'none';
    this.mediaStream = null; this.fileBuffer = null; this.fileName = '';
    this.loopRequests = new Map(); this.reqId = 0; this.srcReq = 0;
    this.recorder = null; this.recChunks = [];
  }

  // Mehrfache gleichzeitige Aufrufe (Doppelklick, Datei fallen lassen + Klick) teilen sich eine Initialisierung.
  // Früher kehrte der zweite Aufruf zurück, bevor der Worklet-Knoten existierte → Parameter gingen verloren.
  async init() {
    if (!this.initPromise) this.initPromise = this.createGraph().catch((err) => { this.initPromise = null; throw err; });
    await this.initPromise;
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async createGraph() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Dieser Browser unterstützt die Web Audio API nicht.');
    const ctx = new AC({ latencyHint: 'interactive' });
    try {
      if (!ctx.audioWorklet) throw new Error('Dieser Browser unterstützt kein AudioWorklet.');
      await ctx.audioWorklet.addModule(new URL('./orbit-processor.js', import.meta.url));
      this.node = new AudioWorkletNode(ctx, 'orbit-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
    } catch (err) {
      try { ctx.close(); } catch (_) { /* egal */ }
      this.node = null;
      throw err;
    }
    this.ctx = ctx;
    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = 1;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.inputGain.connect(this.node);
    this.node.connect(this.master);
    this.master.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.master.connect(this.recDest);
    this.node.port.onmessage = (e) => this.onWorkletMessage(e.data);
    this.node.onprocessorerror = () => this.dispatchEvent(new CustomEvent('processorerror'));
  }

  onWorkletMessage(m) {
    if (!m) return;
    if (m.type === 'state') this.dispatchEvent(new CustomEvent('state', { detail: m }));
    else if (m.type === 'loopChunk') {
      const r = this.loopRequests.get(m.id);
      if (r) r.chunks.push(m);
    } else if (m.type === 'loopData') {
      const r = this.loopRequests.get(m.id);
      if (!r) return;
      if (!m.len) { r.finish(null); return; }
      const L = new Float32Array(m.len), R = new Float32Array(m.len);
      for (const c of r.chunks) { L.set(c.L, c.off); R.set(c.R, c.off); }
      r.finish({ L, R, sr: m.sr });
    } else if (m.type === 'recovered') this.dispatchEvent(new CustomEvent('recovered', { detail: m }));
  }

  post(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); }
  setParams(values) { this.post({ type: 'params', values }); }

  /** Aktuellen Loop holen. Der Prozessor schickt ihn in Stücken (echtzeitsicher), hier wird er zusammengesetzt. */
  getLoop() {
    return new Promise((resolve) => {
      if (!this.node) return resolve(null);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const id = ++this.reqId;
      const req = { chunks: [], timer: 0, finish: null };
      req.finish = (val) => { clearTimeout(req.timer); this.loopRequests.delete(id); resolve(val); };
      req.timer = setTimeout(() => req.finish(null), 15000);
      this.loopRequests.set(id, req);
      this.post({ type: 'getLoop', id });
    });
  }
  setLoop(L, R, sr) {
    if (!this.ctx || !L || !L.length) return false;
    const rate = this.ctx.sampleRate, from = sr || rate;
    const mono = !R || R === L || !R.length;
    // vor dem Umrechnen auf 60 s kürzen (lange Dateien nicht komplett resamplen und verschicken)
    const maxIn = Math.ceil(LOOP_MAX_SEC * from) + 2;
    if (L.length > maxIn) L = L.subarray(0, maxIn);
    if (!mono && R.length > maxIn) R = R.subarray(0, maxIn);
    if (from !== rate) { L = resample(L, from, rate); R = mono ? L : resample(R, from, rate); }
    else if (mono) R = L;
    const n = Math.min(L.length, R.length, Math.floor(LOOP_MAX_SEC * rate));
    if (n < 16) return false;
    // zwei getrennte Puffer: dasselbe ArrayBuffer zweimal zu übertragen wirft einen Fehler
    const l = new Float32Array(n), r = new Float32Array(n);
    l.set(L.subarray ? L.subarray(0, n) : Array.prototype.slice.call(L, 0, n));
    r.set(R.subarray ? R.subarray(0, n) : Array.prototype.slice.call(R, 0, n));
    this.post({ type: 'setLoop', L: l, R: r }, [l.buffer, r.buffer]);
    return true;
  }

  /* ---------- Quellen ---------- */
  // Jede Quelle hängt an einem eigenen Gain, der ein- und ausblendet. Ein harter Wechsel landet sonst als
  // Knacks im Verlaufspuffer und wird von den Loop-/Granular-Effekten immer wieder abgespielt.
  attachSource(node) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    node.connect(g); g.connect(this.inputGain);
    g.gain.setTargetAtTime(1, this.ctx.currentTime, SRC_FADE);
    this.srcGain = g;
  }

  stopSource() {
    const ctx = this.ctx, src = this.source, nodes = this.inNodes, ms = this.mediaStream, g = this.srcGain;
    this.source = null; this.inNodes = null; this.mediaStream = null; this.srcGain = null;
    this.inputInfo = null;
    this.sourceKind = 'none';
    const dispose = () => {
      if (src) {
        try { if (src.stop) src.stop(); } catch (_) { /* schon gestoppt */ }
        try { src.disconnect(); } catch (_) { /* nicht verbunden */ }
      }
      if (nodes) {
        try { nodes.splitter.disconnect(); } catch (_) { /* nicht verbunden */ }
        try { nodes.merger.disconnect(); } catch (_) { /* nicht verbunden */ }
      }
      if (ms) ms.getTracks().forEach((t) => t.stop());
      if (g) { try { g.disconnect(); } catch (_) { /* nicht verbunden */ } }
    };
    if (g && ctx && ctx.state === 'running') {
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, SRC_FADE);
      setTimeout(dispose, 60);
    } else dispose();
  }

  /**
   * Audio-Eingang (Interface, USB-Gerät, Mikrofon). Fordert so viele Kanäle an, wie das Gerät
   * und der Browser hergeben, und routet ein wählbares Stereo-Paar oder einen Mono-Kanal.
   */
  async useInput(deviceId, route) {
    await this.init();
    const req = ++this.srcReq;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Audio-Eingänge sind hier nicht verfügbar (benötigt HTTPS oder localhost)');
    }
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0 } };
    const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...dev, channelCount: { ideal: 32 } } });
    } catch (err) {
      if (req !== this.srcReq) throw supersededError();
      if (err && (err.name === 'OverconstrainedError' || err.name === 'TypeError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...dev } });
      } else throw err;
    }
    // Während der Freigabe wurde schon eine andere Quelle gewählt → diesen Stream sofort wieder schließen
    if (req !== this.srcReq) { stream.getTracks().forEach((t) => t.stop()); throw supersededError(); }
    const track = stream.getAudioTracks()[0];
    const st = track && track.getSettings ? track.getSettings() : {};
    const nch = Math.max(1, Math.min(32, st.channelCount || 2));
    let src, splitter, merger;
    try {
      src = this.ctx.createMediaStreamSource(stream); // Firefox: wirft bei abweichender Abtastrate
      splitter = this.ctx.createChannelSplitter(nch);
      merger = this.ctx.createChannelMerger(2);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop()); // Gerät nicht offen lassen (Mikrofon-Anzeige)
      throw err;
    }
    this.stopSource();
    this.mediaStream = stream;
    src.connect(splitter);
    this.attachSource(merger);
    this.inNodes = { splitter, merger };
    this.source = src;
    this.inputInfo = {
      label: (track && track.label) || 'Audio-Eingang',
      deviceId: st.deviceId || deviceId || '',
      channels: nch,
      sampleRate: st.sampleRate || this.ctx.sampleRate,
      latency: (st.latency || 0) + (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0),
    };
    this.setInputRoute(route);
    this.sourceKind = 'input';
    if (track) track.addEventListener('ended', () => { if (this.mediaStream === stream) this.dispatchEvent(new CustomEvent('inputended')); });
    return this.inputInfo;
  }

  /** route: { a, b } mit 0-basierten Kanälen; a === b bedeutet Mono auf beide Seiten. */
  setInputRoute(route) {
    const n = this.inNodes, info = this.inputInfo;
    if (!n || !info) return null;
    const nch = info.channels;
    let a = 0, b = nch > 1 ? 1 : 0;
    if (route && Number.isInteger(route.a)) { a = route.a; b = Number.isInteger(route.b) ? route.b : route.a; }
    if (a < 0 || b < 0 || a >= nch || b >= nch) { a = 0; b = nch > 1 ? 1 : 0; }
    try { n.splitter.disconnect(); } catch (_) { /* nicht verbunden */ }
    n.splitter.connect(n.merger, a, 0);
    n.splitter.connect(n.merger, b, 1);
    this.inputRoute = { a, b };
    return this.inputRoute;
  }

  async listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  }

  async useDemo(id) {
    await this.init();
    this.srcReq++;
    this.stopSource();
    const buf = makeDemoBuffer(this.ctx, id);
    this.playBuffer(buf);
    this.sourceKind = 'demo';
    return DEMO_BPM;
  }

  async loadFile(file) {
    await this.init();
    const data = await file.arrayBuffer();
    this.fileBuffer = await this.ctx.decodeAudioData(data);
    this.fileName = file.name;
  }
  async useFile() {
    await this.init();
    if (!this.fileBuffer) throw new Error('Keine Datei geladen');
    this.srcReq++;
    this.stopSource();
    this.playBuffer(this.fileBuffer);
    this.sourceKind = 'file';
  }

  playBuffer(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.attachSource(src);
    src.start();
    this.source = src;
  }

  useNone() { this.srcReq++; this.stopSource(); }

  setInputGain(v) { if (this.inputGain) this.inputGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setMaster(v) { if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /* ---------- Aufnahme des Ausgangs ---------- */
  startRecording() {
    if (!this.recDest || this.recorder) return false;
    if (!window.MediaRecorder) throw new Error('Aufnahme wird von diesem Browser nicht unterstützt');
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType } : undefined);
    this.recChunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) this.recChunks.push(e.data); };
    rec.onerror = () => this.dispatchEvent(new CustomEvent('recordererror'));
    rec.start(250);
    this.recorder = rec;
    return true;
  }
  stopRecording() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) return resolve(null);
      const finish = () => {
        const blob = this.recChunks.length ? new Blob(this.recChunks, { type: rec.mimeType || 'audio/webm' }) : null;
        this.recorder = null; this.recChunks = [];
        resolve(blob);
      };
      // nach einem Fehler ist der Recorder schon inaktiv; stop() würde dann werfen und die Taste hinge fest
      if (rec.state === 'inactive') return finish();
      rec.onstop = finish;
      try { rec.stop(); } catch (_) { finish(); }
    });
  }
}

export function resample(data, from, to) {
  const ratio = from / to, n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), f = p - i0;
    const a = data[i0] || 0, b = data[Math.min(data.length - 1, i0 + 1)] || 0;
    out[i] = a + (b - a) * f;
  }
  return out;
}

export function encodeWav(L, R, sr) {
  const n = L.length, ch = 2, bytes = 2;
  const buf = new ArrayBuffer(44 + n * ch * bytes);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * bytes, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * ch * bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
    v.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true); o += 2;
    v.setInt16(o, r < 0 ? r * 0x8000 : r * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
