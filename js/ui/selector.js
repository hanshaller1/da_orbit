// Effektwähler: Ring mit 11 Effekten × 4 Varianten
import { EFFECTS, CATEGORIES } from '../data.js';

const NS = 'http://www.w3.org/2000/svg';
const C = 150;
function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function pt(r, deg) { const a = (deg - 90) * Math.PI / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; }
function sector(r0, r1, a0, a1) {
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}
function arc(r, a0, a1) {
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

export class Selector {
  constructor(host, onSelect, onRev) {
    this.onSelect = onSelect; this.onRev = onRev;
    this.effect = 0; this.variation = 0; this.rev = false;
    const wrap = document.createElement('div');
    wrap.className = 'selector';
    const svg = el('svg', { viewBox: '0 0 300 300', class: 'selector-svg', role: 'listbox', 'aria-label': 'Effektauswahl' });
    wrap.appendChild(svg);
    this.svg = svg;
    const span = 360 / EFFECTS.length;
    this.sectors = []; this.dots = [];
    EFFECTS.forEach((fx, i) => {
      const a0 = i * span + 1.2, a1 = (i + 1) * span - 1.2;
      const g = el('g', { class: 'sel-fx', 'data-fx': i }, svg);
      g.style.setProperty('--c', CATEGORIES[fx.cat].color);
      const sec = el('path', { d: sector(86, 140, a0, a1), class: 'sel-sector' }, g);
      el('path', { d: arc(144, a0, a1), class: 'sel-band' }, g);
      const mid = (a0 + a1) / 2;
      const [tx, ty] = pt(122, mid);
      let rot = mid; if (mid > 90 && mid < 270) rot += 180;
      const t = el('text', { x: tx, y: ty, class: 'sel-name', transform: `rotate(${rot} ${tx} ${ty})`, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      t.textContent = fx.name;
      sec.addEventListener('click', () => this.select(i, this.variation, true));
      t.addEventListener('click', () => this.select(i, this.variation, true));
      const row = [];
      for (let v = 0; v < 4; v++) {
        const a = a0 + (a1 - a0) * ((v + 0.5) / 4);
        const [dx, dy] = pt(99, a);
        const dg = el('g', { class: 'sel-dot', role: 'option', 'aria-label': `${fx.name} ${'ABCD'[v]}` }, g);
        el('circle', { cx: dx, cy: dy, r: 7.5, class: 'sel-dot-hit' }, dg);
        el('circle', { cx: dx, cy: dy, r: 4.2, class: 'sel-dot-led' }, dg);
        const lt = el('text', { x: dx, y: dy, class: 'sel-dot-letter', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, dg);
        lt.textContent = 'ABCD'[v];
        dg.addEventListener('click', (e) => { e.stopPropagation(); this.select(i, v, true); });
        row.push(dg);
      }
      this.sectors.push(g); this.dots.push(row);
    });
    // Mitte: Anzeige + Reverse-Taste
    const center = document.createElement('button');
    center.type = 'button';
    center.className = 'selector-center';
    center.title = 'Effekt rückwärts (V)';
    center.innerHTML = '<span class="sc-cat"></span><span class="sc-name"></span><span class="sc-var"></span><span class="sc-rev">REV</span>';
    center.addEventListener('click', () => { this.setRev(!this.rev); this.onRev(this.rev); });
    wrap.appendChild(center);
    this.center = center;
    // Mausrad blättert; Trackpads liefern viele kleine Ereignisse → aufsummieren (sonst rast ein Wisch durch alle 44)
    this.wheelAcc = 0;
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (Math.abs(this.wheelAcc) < 60) return;
      this.step(this.wheelAcc > 0 ? 1 : -1);
      this.wheelAcc = 0;
    }, { passive: false });
    host.appendChild(wrap);
    this.render();
  }

  step(d) {
    let idx = this.effect * 4 + this.variation + d;
    idx = (idx + 44) % 44;
    this.select(Math.floor(idx / 4), idx % 4, true);
  }
  stepEffect(d) { this.select((this.effect + d + 11) % 11, this.variation, true); }

  select(fx, va, fromUser) {
    this.effect = fx; this.variation = va;
    this.render();
    if (fromUser) this.onSelect(fx, va);
  }
  setRev(on) { this.rev = on; this.render(); }

  render() {
    this.sectors.forEach((g, i) => g.classList.toggle('is-active', i === this.effect));
    this.dots.forEach((row, i) => row.forEach((d, v) => {
      const on = i === this.effect && v === this.variation;
      d.classList.toggle('is-active', on);
      d.setAttribute('aria-selected', on ? 'true' : 'false');
    }));
    const fx = EFFECTS[this.effect];
    this.center.style.setProperty('--c', CATEGORIES[fx.cat].color);
    this.center.querySelector('.sc-cat').textContent = CATEGORIES[fx.cat].name;
    this.center.querySelector('.sc-name').textContent = fx.name;
    this.center.querySelector('.sc-var').textContent = 'ABCD'[this.variation];
    this.center.classList.toggle('is-rev', this.rev);
    this.center.setAttribute('aria-pressed', this.rev ? 'true' : 'false');
  }
}
