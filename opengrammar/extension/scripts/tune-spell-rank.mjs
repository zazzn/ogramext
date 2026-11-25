// Offline tuner for the spell-candidate ranker (rankSpellCandidates).
// Builds N real-typo-in-real-sentence cases (same corpus recipe as
// parity-harness.mjs), lints each once with Harper, builds a wide candidate pool
// (ED1 ∪ ED2, top K by ED-then-frequency, + Harper's own), precomputes the
// n-gram context score per candidate, then grid-searches channel-cost variants.
//   N=1500 node scripts/tune-spell-rank.mjs
// The linted cases are cached in the OS temp dir (delete it after changing the
// corpus or pool); override the grid with GRID='{"w":[5],"tr":[0.5]}' etc.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const N = Number(process.env.N || 1500);
const K = Number(process.env.K || 40);
function loadTs(p) {
  const js = ts.transpileModule(readFileSync(join(root, p), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { parseModel } = await loadTs('src/background/contextRankerCore.ts');
const raw = readFileSync(join(root, 'public/ngram/model.bin'));
const M = parseModel(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

const typoMap = new Map();
for (const line of readFileSync(join(root, 'test-data/norvig-spell-errors.txt'), 'utf8').split('\n')) {
  const i = line.indexOf(':');
  if (i < 0) continue;
  const c = line.slice(0, i).trim().toLowerCase();
  if (!/^[a-z]{4,}$/.test(c)) continue;
  const list = [];
  for (let t of line.slice(i + 1).split(',')) {
    t = t.trim().replace(/\*\d+$/, '').trim().toLowerCase();
    if (t && /^[a-z]+$/.test(t) && t !== c) list.push(t);
  }
  if (list.length) typoMap.set(c, list);
}
const FREQ = new Map();
for (const line of readFileSync(join(root, 'public/dict/frequency_dictionary_en_82_765.txt'), 'utf8').split('\n')) {
  const p = line.replace(/^﻿/, '').trim().split(/\s+/);
  if (p[0]) FREQ.set(p[0].toLowerCase(), Number(p[1]));
}
const cases = [];
for (const line of readFileSync(join(root, 'test-data/leipzig-eng-sentences.txt'), 'utf8').split('\n')) {
  const tab = line.indexOf('\t');
  const s = (tab >= 0 ? line.slice(tab + 1) : line).trim();
  if (s.length < 25 || s.length > 180 || !/^[\x20-\x7E]+$/.test(s)) continue;
  const words = [...s.matchAll(/[A-Za-z]+/g)];
  let picked = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i][0];
    if (w.length >= 4 && /^[a-z]+$/.test(w) && typoMap.has(w)) {
      const typo = typoMap.get(w).find((t) => !FREQ.has(t));
      if (typo) { picked = { w, idx: words[i].index, typo }; break; }
    }
  }
  if (!picked) continue;
  cases.push({ sentence: s.slice(0, picked.idx) + picked.typo + s.slice(picked.idx + picked.w.length), typo: picked.typo, correct: picked.w });
  if (cases.length >= N) break;
}

const L = "abcdefghijklmnopqrstuvwxyz'".split('');
function e1(w) {
  const o = new Set();
  for (let i = 0; i <= w.length; i++) {
    if (i < w.length) o.add(w.slice(0, i) + w.slice(i + 1));
    if (i < w.length - 1) o.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    if (i < w.length) for (const c of L) o.add(w.slice(0, i) + c + w.slice(i + 1));
    for (const c of L) o.add(w.slice(0, i) + c + w.slice(i));
  }
  return o;
}
function pool(w) {
  const s1 = [...e1(w)].filter((x) => FREQ.has(x) && x !== w);
  const set1 = new Set(s1);
  const s2 = new Set();
  for (const a of e1(w)) for (const b of e1(a)) if (FREQ.has(b) && b !== w && !set1.has(b)) s2.add(b);
  const by = (x, y) => FREQ.get(y) - FREQ.get(x) || (x < y ? -1 : 1);
  return [...s1.sort(by), ...[...s2].sort(by)].slice(0, K);
}

const uniLn = (w) => { const i = M.idOf.get(w); return i === undefined ? M.floor : M.uni[i]; };
const cond = (a, b) => {
  const x = M.idOf.get(a), y = M.idOf.get(b);
  if (x !== undefined && y !== undefined) { const v = M.bi.get(x * M.V + y); if (v !== undefined) return v; }
  return Math.log(0.4) + uniLn(b);
};
const WORD = /[a-zA-Z][a-zA-Z'-]*/g;
function neighbours(text, idx, end) {
  const bm = text.slice(Math.max(0, idx - 64), idx).match(WORD);
  const am = text.slice(end, end + 64).match(WORD);
  return [bm ? bm[bm.length - 1].toLowerCase() : '', am ? am[0].toLowerCase() : ''];
}

// ── weighted OSA (restricted Damerau) distance ──
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const POS = {};
ROWS.forEach((r, ri) => [...r].forEach((ch, ci) => (POS[ch] = [ri, ci + ri * 0.5])));
const adjacent = (a, b) => {
  const p = POS[a], q = POS[b];
  if (!p || !q) return false;
  return Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1.0 && a !== b;
};
const VOW = new Set('aeiouy');
function wdist(a, b, P) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  // delete a[i-1] (typo has extra letter): cheap if it doubles a neighbour
  const delCost = (i) => (P.dbl < 1 && ((i > 1 && a[i - 1] === a[i - 2]) || (i < m && a[i - 1] === a[i])) ? P.dbl : 1);
  // insert b[j-1] (typo dropped a letter): cheap if it is a doubled letter in the word
  const insCost = (j) => (P.dbl < 1 && ((j > 1 && b[j - 1] === b[j - 2]) || (j < n && b[j - 1] === b[j])) ? P.dbl : 1);
  const subCost = (x, y) => {
    if (x === y) return 0;
    if (VOW.has(x) && VOW.has(y)) return P.vow;
    if (adjacent(x, y)) return P.kb;
    return 1;
  };
  for (let i = 1; i <= m; i++) d[i][0] = d[i - 1][0] + delCost(i);
  for (let j = 1; j <= n; j++) d[0][j] = d[0][j - 1] + insCost(j);
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      let v = Math.min(d[i - 1][j] + delCost(i), d[i][j - 1] + insCost(j), d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== a[i - 2]) v = Math.min(v, d[i - 2][j - 2] + P.tr);
      d[i][j] = v;
    }
  return d[m][n] + (P.first && a[0] !== b[0] ? P.first : 0);
}

// ── build cases once ──
const CACHE = join(tmpdir(), `ogr-tune-spell-${N}-${K}.json`);
let items = [];
let det = 0;
if (existsSync(CACHE)) ({ items, det } = JSON.parse(readFileSync(CACHE, 'utf8')));
else {
const linter = new LocalLinter({ binary: binaryInlined });
await linter.setup();
for (const c of cases) {
  const lints = await linter.lint(c.sentence, { language: 'plaintext' });
  const lint = lints.find((l) => eq(l.get_problem_text(), c.typo));
  if (!lint) continue;
  det++;
  const sp = lint.span();
  const harper = lint.suggestions().map((s) => s.get_replacement_text()).filter((x) => x && !eq(x, c.typo));
  const p = pool(c.typo);
  for (const h of harper) if (!p.some((y) => eq(h, y))) p.push(h);
  const [lw, rw] = neighbours(c.sentence, sp.start, sp.end);
  const cands = p.map((cand) => {
    const w = cand.toLowerCase();
    let ctx = 0, parts = 0;
    if (lw) { ctx += cond(lw, w); parts++; }
    if (rw) { ctx += cond(w, rw); parts++; }
    if (!parts) ctx = uniLn(w);
    return { w, ctx };
  });
  items.push({ typo: c.typo.toLowerCase(), correct: c.correct, cands, inPool: cands.some((x) => eq(x.w, c.correct)) });
}
writeFileSync(CACHE, JSON.stringify({ items, det }));
}
console.log(`cases ${cases.length}, detected ${det}, correct-in-pool ${items.filter((x) => x.inPool).length}`);

function evalP(P, subset) {
  let ok = 0;
  for (const it of subset) {
    let best = null, bs = -Infinity;
    for (const c of it.cands) {
      const s = c.ctx - P.w * wdist(it.typo, c.w, P);
      if (s > bs) { bs = s; best = c.w; }
    }
    if (eq(best, it.correct)) ok++;
  }
  return ok;
}
const half = Math.floor(items.length / 2);
const A = items.slice(0, half), B = items.slice(half);
const G = Object.assign(
  { w: [4, 5, 6, 7, 8], tr: [1, 0.75, 0.5], kb: [1, 0.75, 0.5], vow: [1, 0.75, 0.5], dbl: [1, 0.75, 0.5, 0.25], first: [0] },
  process.env.GRID ? JSON.parse(process.env.GRID) : {},
);
const res = [];
for (const w of G.w) for (const tr of G.tr) for (const kb of G.kb) for (const vow of G.vow) for (const dbl of G.dbl) for (const first of G.first) {
  const P = { w, tr, kb, vow, dbl, first };
  res.push({ P, a: evalP(P, A), b: evalP(P, B) });
}
res.sort((x, y) => y.a + y.b - (x.a + x.b));
const fmt = (r) => `${JSON.stringify(r.P)} all ${(100 * (r.a + r.b) / items.length).toFixed(1)}% (A ${(100 * r.a / A.length).toFixed(1)} B ${(100 * r.b / B.length).toFixed(1)})`;
const plain = { w: 6, tr: 1, kb: 1, vow: 1, dbl: 1, first: 0 };
console.log('plain OSA w=6:', fmt({ P: plain, a: evalP(plain, A), b: evalP(plain, B) }));
console.log('top 15:');
for (const r of res.slice(0, 15)) console.log('  ' + fmt(r));
// best-on-A evaluated on B (honest held-out)
const bestA = [...res].sort((x, y) => y.a - x.a)[0];
console.log('best on A → B:', fmt(bestA));
