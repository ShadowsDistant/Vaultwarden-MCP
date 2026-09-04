// Serves the built card on http://localhost:8766 so the views can be looked at without a
// host. Append ?demo=<view> and optionally &theme=dark:
//   status  locked  unconfigured  item  list  draft  confirm  delete  generator
//
// Run from the build tree, after `node scripts/build-ui.mjs`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'ui');
const port = Number(process.env.PORT ?? 8766);

const VIEWS = ['status', 'locked', 'unconfigured', 'item', 'list', 'draft', 'confirm', 'delete', 'generator'];

const index = `<!doctype html><meta charset="utf-8"><title>Vault card preview</title>
<style>
 body{font:14px system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#faf9f5;color:#141413}
 header{padding:14px 20px;border-bottom:1px solid #e3e1d8;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
 h1{font-size:15px;margin:0;font-weight:600}
 a{color:#2f6fe0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:22px;padding:22px}
 .cell{display:flex;flex-direction:column;gap:8px}
 .cell h2{font-size:12px;margin:0;text-transform:uppercase;letter-spacing:.05em;color:#6b6a66;font-weight:600}
 iframe{width:100%;height:120px;border:0;border-radius:12px;background:transparent}
 body.dark{background:#1f1e1d;color:#f5f4ef}
 body.dark header{border-color:#403f3c}
 body.dark iframe{background:#1f1e1d}
 body.dark .cell h2{color:#b0aea6}
</style>
<header><h1>Vault card</h1><span id="mode"></span>
<a href="?">light</a><a href="?theme=dark">dark</a><a href="?w=380">narrow</a><a href="?theme=dark&w=380">narrow dark</a></header>
<div class="grid" id="grid"></div>
<script>
 const q = new URLSearchParams(location.search);
 const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
 const w = q.get('w');
 if (theme === 'dark') document.body.classList.add('dark');
 document.getElementById('mode').textContent = theme + (w ? ' · ' + w + 'px' : '');
 const views = ${JSON.stringify(VIEWS)};
 const grid = document.getElementById('grid');
 if (w) grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + w + 'px,' + w + 'px))';
 for (const v of views) {
   const cell = document.createElement('div');
   cell.className = 'cell';
   const h = document.createElement('h2');
   h.textContent = v;
   const f = document.createElement('iframe');
   f.src = 'card.html?demo=' + v + '&theme=' + theme;
   f.title = v;
   if (w) f.style.width = w + 'px';
   cell.append(h, f);
   grid.append(cell);
 }
 // Same origin, so the preview can size each frame to its card the way a real host does
 // from the size-changed notification.
 // Only write when the value actually changed: assigning the same height every tick keeps
 // the page in permanent layout churn, and a screenshot never finds a settled frame.
 setInterval(() => {
   for (const f of document.querySelectorAll('iframe')) {
     const card = f.contentDocument && f.contentDocument.getElementById('card');
     if (!card) continue;
     const want = (card.offsetHeight + 12) + 'px';
     if (f.style.height !== want) f.style.height = want;
   }
 }, 500);
</script>`;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index);
      return;
    }
    // The self-test page lives in the source tree next to the card it drives, so it is
    // served from there rather than copied into dist on every build.
    if (url.pathname === '/selftest.html') {
      const page = path.resolve(root, 'ui', 'selftest.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(page));
      return;
    }
    const file = path.join(dist, path.basename(url.pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  })
  .listen(port, () => console.error(`card preview: http://localhost:${port}/`));
