// Right-first accuracy of the extension spell pipeline (Harper detect -> spellSuggestions
// -> rankSpellCandidates) on the parity-harness corpus recipe.
//   node scripts/spell-accuracy.mjs [nCases=1500]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const N = Number(process.argv[2] || 1500);
const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.chrome = { runtime: { getURL: (rel) => join(root, 'public', rel) } };
globalThis.fetch = async (res, init) =>
  typeof res === 'string' && res.includes('frequency_dictionary')
    ? { ok: true, text: async () => readFileSync(res, 'utf8') }
    : realFetch(res, init);
function loadTs(p) {
  const js = ts.transpileModule(readFileSync(join(root, p), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { parseModel, rankCandidates, rankSpellCandidates } = await loadTs('src/background/contextRankerCore.ts');
const { spellSuggestions, warmSpell } = await loadTs('src/background/spellSuggest.ts');
const raw = readFileSync(join(root, 'public/ngram/model.bin'));
const M = parseModel(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
await warmSpell();
const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

// ── corpus: inject a real non-word typo into a content word of real sentences ──
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
const freqWords = new Set();
for (const line of readFileSync(join(root, 'public/dict/frequency_dictionary_en_82_765.txt'), 'utf8').split('\n')) {
  const w = line.replace(/^﻿/, '').trim().split(/\s+/)[0];
  if (w) freqWords.add(w.toLowerCase());
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
      const typo = typoMap.get(w).find((t) => !freqWords.has(t));
      if (typo) { picked = { w, idx: words[i].index, typo }; break; }
    }
  }
  if (!picked) continue;
  const sentence = s.slice(0, picked.idx) + picked.typo + s.slice(picked.idx + picked.w.length);
  cases.push({ sentence, typo: picked.typo, correct: picked.w });
  if (cases.length >= N) break;
}

// ── EXTENSION pipeline (in-process) ──
const linter = new LocalLinter({ binary: binaryInlined });
await linter.setup();
async function extTop1(sentence, typo) {
  const lints = await linter.lint(sentence, { language: 'plaintext' });
  const lint = lints.find((l) => eq(l.get_problem_text(), typo));
  if (!lint) { return { detected: false }; }
  const sp = lint.span();
  const off = sp.start, len = sp.end - sp.start;
  const harper = lint.suggestions().map((s) => s.get_replacement_text()).filter((x) => x && !eq(x, typo));
  const sym = await spellSuggestions(typo);
  let C;
  if (sym.length > 0) {
    const pool = sym.slice();
    for (const c of harper) if (!pool.some((x) => eq(x, c))) pool.push(c);
    C = rankSpellCandidates(M, sentence, off, len, typo, pool);
  } else {
    C = rankCandidates(M, sentence, off, len, typo, harper.slice());
  }
  return { detected: true, top1: C[0] };
}


let det = 0, ok = 0;
for (const c of cases) {
  const r = await extTop1(c.sentence, c.typo);
  if (!r.detected) continue;
  det++;
  if (eq(r.top1, c.correct)) ok++;
}
console.log('spell right-first: ' + ok + '/' + det + ' detected (' + (100 * ok / det).toFixed(1) + '%), ' + cases.length + ' cases');
