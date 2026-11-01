// Minimaler statischer Server ohne Abhängigkeiten: node server.mjs [port]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
// Standard: nur dieser Rechner. Fürs Heimnetz: HOST=0.0.0.0 node server.mjs
// (Audio-Eingänge funktionieren im Browser ohnehin nur über localhost oder HTTPS.)
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(root, p));
    const rel = path.relative(root, file);
    // außerhalb des Ordners (auch Nachbarordner wie „da_orbit_alt“, die startsWith(root) durchließ)
    // sowie versteckte Dateien und Ordner (.git, .env …) nicht ausliefern
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((seg) => seg.startsWith('.'))) {
      res.writeHead(403); return res.end();
    }
    const s = await stat(file);
    if (!s.isFile()) throw new Error('kein File');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden');
  }
}).listen(port, host, () => console.log(`da_orbit läuft auf http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`));
