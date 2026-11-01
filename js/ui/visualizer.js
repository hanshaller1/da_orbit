// Orbit-Ansicht: Verlaufspuffer als Ring, Stimmen als Partikel, Taps, Hold und Looper
const SPAN = 6; // Sekunden im Ring

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = null; this.wave = null;
    this.color = '#f5a524';
    this.beatFlash = 0; this.onsetFlash = 0; this.lastBeat = -1;
    this.trails = [];
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    this.readTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => this.readTheme());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    this.bg = cs.getPropertyValue('--viz-bg').trim() || '#0b0d14';
    this.fg = cs.getPropertyValue('--text-dim').trim() || '#8a90a6';
    this.ring = cs.getPropertyValue('--viz-ring').trim() || '#2a2f40';
    this.rec = cs.getPropertyValue('--led-red').trim() || '#ff4d5e';
    this.play = cs.getPropertyValue('--led-green').trim() || '#3ddc84';
    this.dub = cs.getPropertyValue('--led-yellow').trim() || '#ffd23f';
    this.holdC = cs.getPropertyValue('--led-blue').trim() || '#5aa9ff';
  }
  setColor(c) { this.color = c; }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  update(s) {
    this.state = s;
    if (s.wave) this.wave = s.wave;
    if (s.beat !== this.lastBeat) { this.lastBeat = s.beat; this.beatFlash = 1; }
    if (s.onset) this.onsetFlash = 1;
  }
  ang(age) { return -Math.PI / 2 - (age / SPAN) * Math.PI * 2; }

  loop() {
    requestAnimationFrame(this.loop);
    if (document.hidden) return;
    this.readThemeLazy();
    const c = this.ctx, w = this.w, h = this.h;
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;
    c.clearRect(0, 0, w, h);
    c.fillStyle = this.bg; c.fillRect(0, 0, w, h);
    const s = this.state;
    // Ringe
    c.strokeStyle = this.ring; c.lineWidth = 1;
    for (const k of [0.45, 0.62, 0.79]) { c.beginPath(); c.arc(cx, cy, R * k, 0, Math.PI * 2); c.stroke(); }
    // Zeitmarken (Sekunden)
    c.fillStyle = this.fg; c.font = '10px ui-monospace, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let sec = 0; sec < SPAN; sec++) {
      const a = this.ang(sec);
      const x0 = cx + Math.cos(a) * R * 0.97, y0 = cy + Math.sin(a) * R * 0.97;
      const x1 = cx + Math.cos(a) * R * 1.02, y1 = cy + Math.sin(a) * R * 1.02;
      c.strokeStyle = this.ring; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      if (sec) c.fillText('−' + sec + 's', cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
    }
    // Wellenform des Verlaufspuffers
    if (this.wave) {
      const n = this.wave.length;
      c.strokeStyle = this.color; c.globalAlpha = 0.55; c.lineWidth = Math.max(1, (Math.PI * 2 * R) / n * 0.6);
      c.beginPath();
      for (let b = 0; b < n; b++) {
        const age = SPAN * (1 - (b + 0.5) / n);
        const a = this.ang(age);
        const amp = Math.min(1, Math.sqrt(this.wave[b]) * 1.1) * R * 0.16;
        const cos = Math.cos(a), sin = Math.sin(a);
        c.moveTo(cx + cos * (R - amp), cy + sin * (R - amp));
        c.lineTo(cx + cos * (R + amp + 0.5), cy + sin * (R + amp + 0.5));
      }
      c.stroke(); c.globalAlpha = 1;
    }
    if (s) {
      // Hold-Bereich
      if (s.hold && s.holdLen > 0) {
        const a0 = this.ang(Math.min(SPAN, s.holdLen)), a1 = this.ang(0);
        c.strokeStyle = this.holdC; c.lineWidth = 5; c.globalAlpha = 0.8;
        c.beginPath(); c.arc(cx, cy, R * 1.2, a0, a1); c.stroke();
        const ap = this.ang(Math.min(SPAN, s.holdLen) * (1 - s.holdPos));
        c.fillStyle = this.holdC; c.beginPath(); c.arc(cx + Math.cos(ap) * R * 1.2, cy + Math.sin(ap) * R * 1.2, 5, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
      // Delay-Taps
      const tp = s.taps;
      if (tp) {
        for (let k = 0; k < tp.length; k += 3) {
          const age = Math.min(SPAN * 0.995, tp[k]);
          const a = this.ang(age), lev = Math.min(1, tp[k + 1]);
          const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
          c.strokeStyle = this.color; c.lineWidth = 2; c.globalAlpha = 0.5 + lev * 0.5;
          c.beginPath(); c.moveTo(cx + Math.cos(a) * R * 0.55, cy + Math.sin(a) * R * 0.55); c.lineTo(x, y); c.stroke();
          c.fillStyle = this.color; c.beginPath(); c.arc(x, y, 4 + lev * 10, 0, Math.PI * 2); c.fill();
          c.globalAlpha = 1;
        }
      }
      // Stimmen
      const v = s.voices;
      if (v) {
        c.save();
        c.globalCompositeOperation = document.documentElement.dataset.scheme === 'light' ? 'multiply' : 'lighter';
        for (let k = 0; k < v.length; k += 4) {
          const age = Math.min(SPAN * 0.995, v[k]);
          const rate = v[k + 1], lev = v[k + 2];
          const oct = Math.log2(Math.max(0.1, Math.abs(rate)));
          const rr = R * (0.62 + 0.17 * Math.max(-1, Math.min(2, oct)));
          const a = this.ang(age);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          const size = 3.5 + Math.min(1, lev) * 10;
          const g = c.createRadialGradient(x, y, 0, x, y, size * 1.8);
          g.addColorStop(0, this.color); g.addColorStop(1, 'transparent');
          c.globalAlpha = 0.55 + Math.min(0.45, lev);
          c.fillStyle = g; c.beginPath(); c.arc(x, y, size * 1.8, 0, Math.PI * 2); c.fill();
          if (rate < 0) { c.globalAlpha = 0.9; c.strokeStyle = this.color; c.lineWidth = 1.2; c.beginPath(); c.arc(x, y, size + 2, 0, Math.PI * 2); c.stroke(); }
        }
        c.restore();
      }
      // Looper-Ring
      const lp = s.loop;
      if (lp && lp.st !== 0) {
        const col = lp.st === 1 ? this.rec : lp.st === 2 ? this.play : lp.st === 3 ? this.dub : this.fg;
        const RR = R * 1.32;
        c.strokeStyle = this.ring; c.lineWidth = 6; c.beginPath(); c.arc(cx, cy, RR, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = col; c.lineWidth = 6;
        if (lp.st === 1) {
          const frac = Math.min(1, lp.rec / 60);
          c.beginPath(); c.arc(cx, cy, RR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); c.stroke();
        } else {
          const a = -Math.PI / 2 + lp.pos * Math.PI * 2;
          c.globalAlpha = lp.st === 4 ? 0.4 : 1;
          c.beginPath(); c.arc(cx, cy, RR, -Math.PI / 2, a); c.stroke();
          c.fillStyle = col; c.beginPath(); c.arc(cx + Math.cos(a) * RR, cy + Math.sin(a) * RR, 6, 0, Math.PI * 2); c.fill();
          c.globalAlpha = 1;
        }
      }
    }
    // Mitte: Takt-Puls und Anschlag
    this.beatFlash *= 0.86; this.onsetFlash *= 0.8;
    c.fillStyle = this.color; c.globalAlpha = 0.18 + this.beatFlash * 0.6;
    c.beginPath(); c.arc(cx, cy, R * (0.12 + this.beatFlash * 0.05), 0, Math.PI * 2); c.fill();
    c.globalAlpha = this.onsetFlash;
    c.strokeStyle = this.color; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, R * (0.2 + (1 - this.onsetFlash) * 0.15), 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 1;
    // Jetzt-Marke
    c.strokeStyle = this.fg; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, cy - R * 1.22); c.lineTo(cx, cy - R * 0.4); c.stroke();
    c.fillStyle = this.fg; c.fillText('jetzt', cx, cy - R * 1.24 - 8);
  }
  readThemeLazy() {
    const scheme = document.documentElement.dataset.scheme || '';
    if (scheme !== this._scheme) { this._scheme = scheme; this.readTheme(); }
  }
}
