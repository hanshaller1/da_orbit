// Drehregler mit zwei Ebenen (Primär / Shift)
const A0 = -135, A1 = 135;
const NS = 'http://www.w3.org/2000/svg';

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, from, to) {
  const [x0, y0] = polar(cx, cy, r, from), [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function el(name, attrs) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export class Knob {
  constructor(host, def, values, onChange) {
    this.def = def; this.onChange = onChange;
    this.values = values; // gemeinsames Parameterobjekt
    this.shift = false;
    this.fmtOverride = {};
    const root = document.createElement('div');
    root.className = 'knob';
    root.dataset.id = def.id;
    const svg = el('svg', { viewBox: '0 0 100 100', class: 'knob-svg', 'aria-hidden': 'true' });
    this.track = el('path', { d: arcPath(50, 50, 40, A0, A1), class: 'knob-track' });
    this.altArc = el('path', { d: '', class: 'knob-alt-arc' });
    this.arc = el('path', { d: '', class: 'knob-arc' });
    this.body = el('circle', { cx: 50, cy: 50, r: 30, class: 'knob-body' });
    this.pointer = el('line', { x1: 50, y1: 50, x2: 50, y2: 26, class: 'knob-pointer' });
    this.ticks = el('g', { class: 'knob-ticks' });
    svg.append(this.track, this.ticks, this.altArc, this.arc, this.body, this.pointer);
    const dial = document.createElement('div');
    dial.className = 'knob-dial';
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-valuemin', '0');
    dial.setAttribute('aria-valuemax', '100');
    dial.appendChild(svg);
    this.dial = dial;
    this.label = document.createElement('div'); this.label.className = 'knob-label';
    this.altLabel = document.createElement('div'); this.altLabel.className = 'knob-alt-label';
    this.valueEl = document.createElement('div'); this.valueEl.className = 'knob-value';
    root.append(dial, this.label, this.altLabel, this.valueEl);
    host.appendChild(root);
    this.root = root;
    this.bind();
    this.render();
  }

  get active() { return this.shift ? this.def.alt : this.def.main; }

  setShift(on) { this.shift = on; this.root.classList.toggle('is-shift', on); this.render(); }
  setFormatter(key, fn) { this.fmtOverride[key] = fn; this.render(); }
  setSteps(key, steps) { this.stepsOverride = this.stepsOverride || {}; this.stepsOverride[key] = steps; this.render(); }

  stepsFor(p) {
    if (this.stepsOverride && p.key in this.stepsOverride) return this.stepsOverride[p.key];
    return p.steps || 0;
  }

  set(v, fromUser = true) {
    const p = this.active;
    v = Math.max(0, Math.min(1, v));
    if (this.values[p.key] === v) return;
    this.values[p.key] = v;
    this.render();
    if (fromUser) this.onChange(p.key, v);
  }

  bind() {
    let startY = 0, startX = 0, startV = 0, dragging = false, pid = null;
    const d = this.dial;
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      d.focus();
      dragging = true; pid = e.pointerId; d.setPointerCapture(pid);
      startY = e.clientY; startX = e.clientX; startV = this.values[this.active.key];
      this.root.classList.add('is-drag');
    });
    d.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const fine = e.altKey || e.metaKey ? 0.25 : 1;
      const dv = ((startY - e.clientY) + (e.clientX - startX) * 0.5) / 180 * fine;
      this.set(startV + dv);
    });
    const end = (e) => {
      if (!dragging || (e && e.pointerId !== pid)) return;
      dragging = false; this.root.classList.remove('is-drag');
      try { d.releasePointerCapture(pid); } catch (_) { /* bereits freigegeben */ }
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      const steps = this.stepsFor(this.active);
      const delta = steps ? Math.sign(-e.deltaY) / steps : -e.deltaY / 1200;
      this.set(this.values[this.active.key] + delta);
    }, { passive: false });
    d.addEventListener('dblclick', () => this.set(this.active.def));
    d.addEventListener('keydown', (e) => {
      const steps = this.stepsFor(this.active);
      const small = steps ? 1 / steps : 0.01, big = steps ? 1 / steps : 0.1;
      let v = this.values[this.active.key];
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v += e.shiftKey ? big : small;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v -= e.shiftKey ? big : small;
      else if (e.key === 'PageUp') v += big;
      else if (e.key === 'PageDown') v -= big;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 1;
      else return;
      e.preventDefault(); e.stopPropagation();
      this.set(v);
    });
  }

  render() {
    const p = this.active, other = this.shift ? this.def.main : this.def.alt;
    const v = this.values[p.key] ?? p.def;
    const ang = A0 + (A1 - A0) * v;
    this.arc.setAttribute('d', v > 0.002 ? arcPath(50, 50, 40, A0, ang) : '');
    const ov = this.values[other.key] ?? other.def;
    this.altArc.setAttribute('d', ov > 0.002 ? arcPath(50, 50, 45.5, A0, A0 + (A1 - A0) * ov) : '');
    const [x2, y2] = polar(50, 50, 24, ang);
    this.pointer.setAttribute('x2', x2.toFixed(2)); this.pointer.setAttribute('y2', y2.toFixed(2));
    const steps = this.stepsFor(p);
    if (steps !== this._lastSteps) {
      this._lastSteps = steps;
      this.ticks.textContent = '';
      if (steps > 1) {
        for (let s = 0; s < steps; s++) {
          const a = A0 + (A1 - A0) * ((s + 0.5) / steps);
          const [tx0, ty0] = polar(50, 50, 33.5, a), [tx1, ty1] = polar(50, 50, 36, a);
          this.ticks.appendChild(el('line', { x1: tx0, y1: ty0, x2: tx1, y2: ty1 }));
        }
      }
    }
    this.label.textContent = p.label;
    this.altLabel.textContent = other.label;
    const fmt = this.fmtOverride[p.key] || p.fmt || ((x) => Math.round(x * 100) + ' %');
    const text = fmt(v);
    this.valueEl.textContent = text;
    this.dial.setAttribute('aria-label', p.label);
    this.dial.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    this.dial.setAttribute('aria-valuetext', text);
  }
}
