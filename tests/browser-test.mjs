// Browser-Test mit Playwright/Chromium: App laden, Demo starten, alle Effekte durchschalten,
// Hold, Looper und Bypass bedienen, Screenshots erstellen.
// Aufruf: node tests/browser-test.mjs [ausgabe-ordner]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(root, 'tests', 'out');
mkdirSync(outDir, { recursive: true });
const PORT = 8765;

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

let failures = 0;
const fail = (m) => { failures++; console.log('FEHLER: ' + m); };
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.screenshot({ path: path.join(outDir, '01-start.png') });
  await page.click('[data-start="demo:plucks"]');
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ ctx: window.daOrbit.engine.ctx.state, sr: window.daOrbit.engine.ctx.sampleRate }));
  console.log('AudioContext', st);
  if (st.ctx !== 'running') fail('AudioContext läuft nicht');
  // Zustand der Engine abgreifen
  await page.evaluate(() => {
    window.__last = null;
    window.daOrbit.engine.addEventListener('state', (e) => { window.__last = e.detail; window.__maxOut = Math.max(window.__maxOut || 0, e.detail.peakL); });
  });
  await page.waitForTimeout(800);
  const s0 = await page.evaluate(() => window.__last && { peakIn: window.__last.peakIn, peakL: window.__last.peakL, voices: window.__last.voices.length / 4 });
  console.log('Zustand nach Start', s0);
  if (!s0) fail('Keine Zustandsmeldungen vom Worklet');
  await page.screenshot({ path: path.join(outDir, '02-running-dark.png') });

  // Alle Effekte und Varianten
  const names = ['MOSAIC', 'SEQ', 'GLIDE', 'HAZE', 'TUNNEL', 'STRUM', 'BLOCKS', 'INTERRUPT', 'ARP', 'PATTERN', 'WARP'];
  for (let fx = 0; fx < 11; fx++) {
    let maxV = 0, maxT = 0;
    for (let va = 0; va < 4; va++) {
      await page.evaluate(([f, v]) => window.daOrbit.selectEffect(f, v, true), [fx, va]);
      await page.evaluate(() => { window.__maxOut = 0; });
      for (let k = 0; k < 6; k++) {
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => window.__last && [window.__last.voices.length / 4, window.__last.taps.length / 3]);
        if (r) { maxV = Math.max(maxV, r[0]); maxT = Math.max(maxT, r[1]); }
      }
    }
    const out = await page.evaluate(() => window.__maxOut);
    console.log(`${names[fx].padEnd(10)} max. Stimmen ${maxV}, Taps ${maxT}, Ausgangsspitze ${out.toFixed(3)}`);
    if (maxV === 0 && maxT === 0) fail(`${names[fx]}: keine Aktivität`);
    if (fx === 5) await page.screenshot({ path: path.join(outDir, '03-strum.png') });
  }
  // Haze für Screenshot
  await page.evaluate(() => window.daOrbit.selectEffect(3, 1, true));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, '04-haze.png') });

  // Hold per Tastatur
  await page.keyboard.down('e'); await page.keyboard.up('e');
  await page.waitForTimeout(600);
  const hold = await page.evaluate(() => window.__last.hold);
  console.log('Hold aktiv:', hold);
  if (!hold) fail('Hold ließ sich nicht aktivieren');
  await page.keyboard.down('e'); await page.keyboard.up('e');

  // Shift-Ebene
  await page.keyboard.down('Shift');
  await page.waitForTimeout(150);
  const shiftLabel = await page.textContent('.knob[data-id="k7"] .knob-label');
  await page.screenshot({ path: path.join(outDir, '05-shift.png') });
  await page.keyboard.up('Shift');
  console.log('Raum-Regler mit Shift:', shiftLabel);
  if (!/Hall/.test(shiftLabel)) fail('Shift-Ebene zeigt nicht die Zweitfunktion');

  // Regler per Tastatur bedienen
  await page.focus('.knob[data-id="k1"] .knob-dial');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  const act = await page.evaluate(() => window.daOrbit.params.activity);
  console.log('Aktivität nach 5× Pfeil hoch:', act.toFixed(2));

  // Looper: einschalten, 2 s aufnehmen, abspielen, Overdub, Stopp
  await page.evaluate(() => window.daOrbit.selectEffect(9, 0, true));
  await page.keyboard.press('l');
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(2000);
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(700);
  let lp = await page.evaluate(() => window.__last.loop);
  console.log('Looper nach Aufnahme:', lp.st, lp.len.toFixed(2) + ' s');
  if (lp.st !== 2 || lp.len < 1.8) fail('Looper spielt nicht korrekt');
  await page.screenshot({ path: path.join(outDir, '06-looper.png') });
  await page.keyboard.down('q'); await page.keyboard.up('q');
  await page.waitForTimeout(400);
  lp = await page.evaluate(() => window.__last.loop);
  if (lp.st !== 3) fail('Overdub startet nicht');
  await page.keyboard.down('e'); await page.keyboard.up('e');
  await page.waitForTimeout(600);
  lp = await page.evaluate(() => window.__last.loop);
  console.log('Looper nach Stopp:', lp.st);
  if (lp.st !== 4) fail('Looper stoppt nicht');

  // Preset speichern + laden
  await page.click('.slot >> nth=0', { modifiers: ['Shift'] });
  await page.waitForTimeout(500);
  const slotText = await page.textContent('.slot >> nth=0');
  console.log('Preset-Platz 1:', slotText);
  if (!/PATTE/.test(slotText)) fail('Preset wurde nicht gespeichert');

  // Bypass
  await page.keyboard.down('w'); await page.keyboard.up('w');
  await page.waitForTimeout(300);
  const byp = await page.isVisible('#bypChip');
  if (!byp) fail('Bypass-Anzeige fehlt');
  await page.keyboard.down('w'); await page.keyboard.up('w');

  // Hilfe und Einstellungen
  await page.click('#helpBtn'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '07-help.png') });
  await page.keyboard.press('Escape');
  await page.click('#settingsBtn'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '08-settings.png') });
  await page.keyboard.press('Escape');

  // Mikrofon (Fake-Gerät)
  await page.selectOption('#sourceSel', 'mic');
  await page.waitForTimeout(800);
  const kind = await page.evaluate(() => window.daOrbit.engine.sourceKind);
  console.log('Quelle nach Mikrofon-Wahl:', kind);
  if (kind !== 'mic') fail('Mikrofon-Eingang ließ sich nicht aktivieren');

  if (errors.length) { console.log('Konsolenfehler:', errors); fail('Konsolenfehler vorhanden'); }

  // Hell + Mobil
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://localhost:${PORT}/`);
  await p2.click('[data-start="demo:plucks"]');
  await p2.waitForSelector('#startOverlay', { state: 'hidden' });
  await p2.selectOption('#sourceSel', 'demo:keys');
  await p2.waitForTimeout(1500);
  await p2.screenshot({ path: path.join(outDir, '09-mobile-light.png'), fullPage: true });
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('Horizontaler Überlauf mobil:', overflow);
  if (overflow > 1) fail('Horizontaler Überlauf auf dem Handy');
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const p3 = await ctx3.newPage();
  await p3.goto(`http://localhost:${PORT}/`);
  await p3.click('[data-start="demo:plucks"]');
  await p3.waitForSelector('#startOverlay', { state: 'hidden' });
  await p3.selectOption('#sourceSel', 'demo:beat');
  await p3.evaluate(() => window.daOrbit.selectEffect(7, 0, true));
  await p3.waitForTimeout(1800);
  await p3.screenshot({ path: path.join(outDir, '10-desktop-light.png') });
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} Fehler` : 'Browser-Test bestanden');
process.exit(failures ? 1 : 0);
