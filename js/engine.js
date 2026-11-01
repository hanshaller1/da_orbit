// Audio-Engine: AudioContext, Worklet-Knoten, Eingangsquellen, Aufnahme
import { makeDemoBuffer, DEMO_BPM } from './demo.js';

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null; this.node = null;
    this.source = null; this.sourceKind = 'none';
    this.mediaStream = null; this.fileBuffer = null; this.fileName = '';
    this.loopRequests = new Map(); this.reqId = 0;
    this.recorder = null; this.recChunks = [];
  }

  async init() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    if (!ctx.audioWorklet) throw new Error('Dieser Browser unterstützt kein AudioWorklet.');
    await ctx.audioWorklet.addModule(new URL('./orbit-processor.js', import.meta.url));
    this.node = new AudioWorkletNode(ctx, 'orbit-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
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
    if (ctx.state !== 'running') await ctx.resume();
  }

  onWorkletMessage(m) {
    if (m.type === 'state') this.dispatchEvent(new CustomEvent('state', { detail: m }));
    else if (m.type === 'loopData') {
      const res = this.loopRequests.get(m.id);
      if (res) { this.loopRequests.delete(m.id); res(m); }
    }
  }

  post(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); }
  setParams(values) { this.post({ type: 'params', values }); }

  getLoop() {
    return new Promise((resolve) => {
      if (!this.node) return resolve(null);
      const id = ++this.reqId;
      this.loopRequests.set(id, resolve);
      this.post({ type: 'getLoop', id });
      setTimeout(() => { if (this.loopRequests.has(id)) { this.loopRequests.delete(id); resolve(null); } }, 3000);
    });
  }
  setLoop(L, R, sr) {
    if (!this.ctx) return;
    if (sr && sr !== this.ctx.sampleRate) { L = resample(L, sr, this.ctx.sampleRate); R = resample(R, sr, this.ctx.sampleRate); }
    const l = Float32Array.from(L), r = Float32Array.from(R);
    this.post({ type: 'setLoop', L: l, R: r }, [l.buffer, r.buffer]);
  }

  /* ---------- Quellen ---------- */
  stopSource() {
    if (this.source) {
      try { if (this.source.stop) this.source.stop(); } catch (_) { /* schon gestoppt */ }
      try { this.source.disconnect(); } catch (_) { /* nicht verbunden */ }
      this.source = null;
    }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach((t) => t.stop()); this.mediaStream = null; }
    this.sourceKind = 'none';
  }

  async useMic(deviceId) {
    await this.init();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Mikrofon ist hier nicht verfügbar (benötigt HTTPS oder localhost)');
    }
    this.stopSource();
    const constraints = {
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, latency: { ideal: 0 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.mediaStream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.inputGain);
    this.sourceKind = 'mic';
  }

  async listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  }

  async useDemo(id) {
    await this.init();
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
    this.stopSource();
    this.playBuffer(this.fileBuffer);
    this.sourceKind = 'file';
  }

  playBuffer(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(this.inputGain);
    src.start();
    this.source = src;
  }

  useNone() { this.stopSource(); }

  setInputGain(v) { if (this.inputGain) this.inputGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setMaster(v) { if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /* ---------- Aufnahme des Ausgangs ---------- */
  startRecording() {
    if (!this.recDest || this.recorder) return false;
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    this.recorder = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType } : undefined);
    this.recChunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.recorder.start(250);
    return true;
  }
  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null);
      const rec = this.recorder;
      rec.onstop = () => {
        const blob = new Blob(this.recChunks, { type: rec.mimeType || 'audio/webm' });
        this.recorder = null; this.recChunks = [];
        resolve(blob);
      };
      rec.stop();
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
