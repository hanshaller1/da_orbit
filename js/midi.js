// Web-MIDI: Controller, Programmwechsel, MIDI-Clock
export class Midi {
  constructor(handlers) {
    this.h = handlers; this.access = null; this.channel = 0;
    this.clockTimes = []; this.clockRunning = false; this.lastClock = 0;
  }
  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }
  async enable() {
    if (!this.supported) throw new Error('Web MIDI wird von diesem Browser nicht unterstützt.');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    const attach = () => {
      for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this.onMessage(e.data);
      this.h.devices && this.h.devices([...this.access.inputs.values()].map((i) => i.name));
    };
    this.access.onstatechange = attach;
    attach();
  }
  onMessage(d) {
    const st = d[0];
    if (st === 0xf8) return this.onClock();
    if (st === 0xfa || st === 0xfb) { this.clockRunning = true; this.clockTimes = []; this.h.clockStart && this.h.clockStart(); return; }
    if (st === 0xfc) { this.clockRunning = false; this.h.clockStop && this.h.clockStop(); return; }
    const type = st & 0xf0, ch = (st & 0x0f) + 1;
    if (this.channel && ch !== this.channel) return;
    if (type === 0xb0) this.h.cc && this.h.cc(d[1], d[2]);
    else if (type === 0xc0) this.h.pc && this.h.pc(d[1]);
    this.h.activity && this.h.activity();
  }
  onClock() {
    if (!this.clockRunning) return;
    const t = performance.now();
    this.clockTimes.push(t);
    if (this.clockTimes.length > 49) this.clockTimes.shift();
    if (this.clockTimes.length >= 25 && this.clockTimes.length % 6 === 1) {
      const n = this.clockTimes.length - 1;
      const per = (this.clockTimes[n] - this.clockTimes[0]) / n; // ms pro Tick
      const bpm = 60000 / (per * 24);
      if (bpm > 20 && bpm < 320) this.h.clockBpm && this.h.clockBpm(bpm);
    }
  }
}
