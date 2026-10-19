/**
 * SENTENCE-level spell-correction benchmark — the realistic regime (the engine /
 * LLM always sees a full sentence, never a bare word). We inject a REAL human
 * typo (from norvig-spell-errors) into one content word of a real news sentence
 * (Leipzig eng_news_2020_10K), then score whether the target word is recovered
 * IN CONTEXT.
 *
 *   local A  = Harper's top suggestion for the flagged typo
 *   local C  = SymSpell pool + n-gram re-rank, WITH the sentence as context
 *   LLM      = correct the whole sentence; scored as "target typo fixed"
 *              (corrected sentence contains the right word, not the typo)
 *
 * Usage:
 *   node scripts/bench-spell-sentences.mjs [nCases=2000]
 *   LLM_TARGETS="ollama:qwen3.5:4b,ollama:qwen3:4b,ollama:qwen2.5:7b,deepseek:deepseek-chat,abacus:route-llm" \
 *     LLM_SAMPLE=80 node scripts/bench-spell-sentences.mjs 2000
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const N_CASES = Number(process.argv[2] || 2000);
const LLM_SAMPLE = Number(process.env.LLM_SAMPLE || 80);
const LLM_TARGETS = (process.env.LLM_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const REMOTE_DELAY_MS = Number(process.env.REMOTE_DELAY_MS || 0); // pace remote calls (free-tier rate limits)

const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.chrome = { runtime: { getURL: (rel) => join(root, 'public', rel) } };
globalThis.fetch = async (resource, init) => {
  if (typeof resource === 'string' && resource.includes('frequency_dictionary')) {
    return { ok: true, text: async () => readFileSync(resource, 'utf8') };
  }
  if (realFetch) return realFetch(resource, init);
  throw new Error('no fetch for ' + resource);
};
function loadTs(path) {
  const js = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { parseModel, rankCandidates, rankSpellCandidates } = await loadTs('src/background/contextRankerCore.ts');
const { spellSuggestions, warmSpell } = await loadTs('src/background/spellSuggest.ts');
const M = parseModel((() => { const r = readFileSync(join(root, 'public/ngram/model.bin')); return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength); })());
await warmSpell();

const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

// correct -> [real human typos]
const typoMap = new Map();
for (const line of readFileSync(join(root, 'test-data/norvig-spell-errors.txt'), 'utf8').split('\n')) {
  const i = line.indexOf(':');
  if (i < 0) continue;
  const correct = line.slice(0, i).trim().toLowerCase();
  if (!/^[a-z]{4,}$/.test(correct)) continue;
  const typos = [];
  for (let t of line.slice(i + 1).split(',')) {
    t = t.trim().replace(/\*\d+$/, '').trim().toLowerCase();
    if (t && /^[a-z]+$/.test(t) && t !== correct) typos.push(t);
  }
  if (typos.length) typoMap.set(correct, typos);
}

// Dictionary word-set, so we inject only NON-WORD typos (genuine misspellings,
// not real-word errors like class→glass which are a separate LLM-only category).
const freqWords = new Set();
for (const line of readFileSync(join(root, 'public/dict/frequency_dictionary_en_82_765.txt'), 'utf8').split('\n')) {
  const w = line.replace(/^﻿/, '').trim().split(/\s+/)[0];
  if (w) freqWords.add(w.toLowerCase());
}

function buildCpToUtf16(text) {
  const map = [];
  let u16 = 0;
  for (const ch of text) { map.push(u16); u16 += ch.length; }
  map.push(u16);
  return (cp) => (cp <= 0 ? 0 : cp >= map.length ? u16 : map[cp]);
}

// Build cases: inject a real typo into a mappable content word of a real sentence.
const cases = [];
for (const line of readFileSync(join(root, 'test-data/leipzig-eng-sentences.txt'), 'utf8').split('\n')) {
  const tab = line.indexOf('\t');
  const s = (tab >= 0 ? line.slice(tab + 1) : line).trim();
  if (s.length < 25 || s.length > 180) continue;
  if (!/^[\x20-\x7E]+$/.test(s)) continue; // ASCII-only → clean offsets
  const words = [...s.matchAll(/[A-Za-z]+/g)];
  let picked = null;
  for (let i = 1; i < words.length; i++) { // skip sentence-initial word (capitalized)
    const w = words[i][0];
    if (w.length >= 4 && /^[a-z]+$/.test(w) && typoMap.has(w)) {
      const typo = typoMap.get(w).find((t) => !freqWords.has(t)); // genuine misspelling only
      if (typo) { picked = { w, idx: words[i].index, typo }; break; }
    }
  }
  if (!picked) continue;
  const sentence = s.slice(0, picked.idx) + picked.typo + s.slice(picked.idx + picked.w.length);
  cases.push({ sentence, correct: picked.w, typo: picked.typo });
  if (cases.length >= N_CASES) break;
}

const linter = new LocalLinter({ binary: binaryInlined });
await linter.setup();

async function localEval(c) {
  const lints = await linter.lint(c.sentence, { language: 'plaintext' });
  const cp = buildCpToUtf16(c.sentence);
  let lint = null;
  for (const l of lints) { if (!lint && l.lint_kind() === 'Spelling' && eq(l.get_problem_text(), c.typo)) lint = l; }
  if (!lint) { for (const l of lints) l.free(); return { detected: false }; }
  const sp = lint.span();
  const off = cp(sp.start);
  const len = cp(sp.end) - off;
  sp.free();
  const sgs = lint.suggestions();
  const harper = sgs.map((s) => s.get_replacement_text()).filter((x) => x && !eq(x, c.typo));
  for (const s of sgs) s.free();
  for (const l of lints) l.free();
  const A = harper[0];
  const sym = await spellSuggestions(c.typo);
  let C;
  if (sym.length > 0) {
    const pool = sym.slice();
    for (const x of harper) if (!pool.some((y) => eq(x, y))) pool.push(x);
    C = rankSpellCandidates(M, c.sentence, off, len, c.typo, pool)[0];
  } else {
    C = rankCandidates(M, c.sentence, off, len, c.typo, harper.slice())[0];
  }
  return { detected: true, A: eq(A, c.correct), C: eq(C, c.correct) };
}

const agg = { n: cases.length, detected: 0, A: 0, C: 0 };
const evaluated = [];
const t0 = Date.now();
for (const c of cases) {
  const r = await localEval(c);
  if (!r.detected) continue;
  agg.detected++;
  if (r.A) agg.A++;
  if (r.C) agg.C++;
  evaluated.push({ ...c, C: r.C });
}
const localMs = Date.now() - t0;
const pl = (x) => ((100 * x) / agg.detected).toFixed(1).padStart(5);
console.log(`\nSENTENCE-level spell benchmark — ${agg.n} sentences, Harper flagged the typo in ${agg.detected} (${(localMs / 1000).toFixed(0)}s)`);
console.log('  target typo fixed (top-1), over detected:');
console.log(`    A harper        ${pl(agg.A)}%`);
console.log(`    C symspell+ctx  ${pl(agg.C)}%   <- now WITH sentence context`);
console.log(`  local latency: ${(localMs / agg.n).toFixed(1)} ms/sentence (Harper + SymSpell + n-gram, fully on-device)`);

// ── LLM track ───────────────────────────────────────────────────────────────
const readKey = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const KEY = {
  deepseek: process.env.DEEPSEEK_API_KEY || readKey('/home/zazzn/.ogrammar-bench/deepseek.key'),
  abacus: process.env.ABACUS_API_KEY || readKey('/home/zazzn/.ogrammar-bench/abacus.key'),
  gemini: process.env.GEMINI_API_KEY || readKey('/home/zazzn/.ogrammar-bench/gemini.key'),
};
const BASE = {
  deepseek: 'https://api.deepseek.com/v1',
  abacus: 'https://routellm.abacus.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};
const SYS = 'You are a spelling corrector. Fix ONLY misspelled words in the sentence; do not rephrase, translate, or change anything else. Output ONLY the corrected sentence.';
const strip = (s) => (s || '').replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenAI-compatible call with 429 backoff (Gemini free tier rate-limits bursts).
async function openaiCall(base, key, model, messages) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await realFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 200 }),
    });
    if (res.status === 429) {
      const body = await res.text().catch(() => '');
      const m = body.match(/retry in ([\d.]+)s/i) || body.match(/"retryDelay":\s*"(\d+)/);
      await sleep(Math.min(60000, ((m ? Number(m[1]) : 20) + 1) * 1000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    return j.choices?.[0]?.message?.content || '';
  }
  return '';
}

async function llmFix(spec, sentence) {
  const ci = spec.indexOf(':');
  const provider = spec.slice(0, ci);
  const model = spec.slice(ci + 1);
  const messages = [{ role: 'system', content: SYS }, { role: 'user', content: sentence }];
  try {
    if (provider === 'ollama') {
      const thinking = /\bqwen3\b|gemma3n|gemma4/i.test(model) && !/instruct/i.test(model);
      const body = { model, messages, stream: false, options: { temperature: 0, num_ctx: 4096, num_predict: 200 } };
      if (thinking) body.think = false;
      const res = await realFetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return strip((await res.json()).message?.content);
    }
    const base = BASE[provider];
    const key = KEY[provider];
    if (!base || !key) return '';
    if (REMOTE_DELAY_MS) await sleep(REMOTE_DELAY_MS);
    return strip(await openaiCall(base, key, model, messages));
  } catch {
    return '';
  }
}
const fixed = (out, correct, typo) => {
  const ws = new Set(out.toLowerCase().match(/[a-z']+/g) || []);
  return ws.has(correct.toLowerCase()) && !ws.has(typo.toLowerCase());
};

if (LLM_TARGETS.length) {
  const step = Math.max(1, Math.floor(evaluated.length / LLM_SAMPLE));
  const sample = [];
  for (let i = 0; i < evaluated.length && sample.length < LLM_SAMPLE; i += step) sample.push(evaluated[i]);
  const cHit = sample.filter((c) => c.C).length;
  console.log(`\nLLM track — ${sample.length} sampled sentences (WITH context)`);
  console.log(`  C symspell+ctx on this sample: ${((100 * cHit) / sample.length).toFixed(1)}%`);
  console.log('  target                          top-1    rescue of C-failures    latency');
  const rows = [];
  for (const spec of LLM_TARGETS) {
    const provider = spec.slice(0, spec.indexOf(':'));
    if (provider !== 'ollama' && !KEY[provider]) { console.log(`  ${spec.padEnd(30)} (no key — skipped)`); continue; }
    let ok = 0, cWrong = 0, rescued = 0;
    const lt0 = Date.now();
    for (const c of sample) {
      const good = fixed(await llmFix(spec, c.sentence), c.correct, c.typo);
      if (good) ok++;
      if (!c.C) { cWrong++; if (good) rescued++; }
    }
    const elapsed = Date.now() - lt0;
    const r = { spec, top1: (100 * ok) / sample.length, rescued, cWrong, rescuePct: cWrong ? (100 * rescued) / cWrong : 0, secs: (elapsed / 1000).toFixed(0), msPerCorr: Math.round(elapsed / sample.length) };
    rows.push(r);
    console.log(`  ${spec.padEnd(30)} ${r.top1.toFixed(1).padStart(5)}%   ${`${rescued}/${cWrong} (${r.rescuePct.toFixed(0)}%)`.padEnd(20)} ${String(r.msPerCorr).padStart(6)} ms/corr`);
  }
  writeFileSync('/tmp/bench-sentences-llm.json', JSON.stringify({ sampleN: sample.length, cTop1: (100 * cHit) / sample.length, rows }, null, 2));
}
console.log(`\nexample case: "${cases[0]?.sentence}"  (typo "${cases[0]?.typo}" -> "${cases[0]?.correct}")`);
