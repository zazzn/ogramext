/**
 * Browser regression harness for the apply path (src/content/editorAdapter.ts).
 *
 * jsdom has no real editing pipeline, selection model, or rich editors, so this
 * bundles the shipped applyFix and serves a page that runs it against real fields
 * (input, textarea, contenteditable, real Lexical) plus simulated difficult editors.
 *
 * Usage:  npm run harness:apply   → open the printed URL in Chrome; results render
 *         on the page (and in window.__RESULTS__). Needs network for Lexical (esm.sh).
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'apply-harness');
await build({
  entryPoints: [join(dir, 'entry.ts')],
  bundle: true,
  format: 'esm',
  outfile: join(dir, 'bundle.js'),
  logLevel: 'warning',
});

const port = Number(process.env.PORT || 8733);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const path = normalize(join(dir, url === '/' ? 'index.html' : url));
  if (!path.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/plain' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Apply harness: http://127.0.0.1:${port}/  (open in Chrome; Ctrl+C to stop)`);
});
