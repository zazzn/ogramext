/**
 * Comprehensive proofreading benchmark — local Ollama (clean, contention-free)
 * + remote OpenAI-compatible providers (Abacus RouteLLM, DeepSeek).
 *
 * Why a separate script from benchmark-ollama-writing-models.mjs:
 *  - It uses Ollama's NATIVE /api/chat (not the OpenAI-compat /v1), so we can
 *    pin `num_ctx` (the 256K-context KV cache was ballooning system RAM and
 *    spilling models to CPU, which contaminated the latency numbers) and read
 *    GPU placement from /api/ps.
 *  - It enforces single-model residency (explicit unload + /api/ps verify
 *    between models) so latency is trustworthy.
 *  - It can score remote API models (cloud quality ceiling) via env/keyfile.
 *
 * Scoring (CASES, SYSTEM_PROMPT, pass criteria) mirrors
 * benchmark-ollama-writing-models.mjs EXACTLY so results are comparable.
 *
 * Usage:
 *   node scripts/benchmark-models.mjs --local=qwen3:4b-instruct,llama3.2:3b,...
 *   node scripts/benchmark-models.mjs --remote                 # include cloud providers w/ keys
 *   node scripts/benchmark-models.mjs --repeats=2              # average local latency
 *   node scripts/benchmark-models.mjs --no-mask                # disable protected-placeholder masking
 * Keys (remote): env DEEPSEEK_API_KEY / ABACUS_API_KEY, else
 *   /home/zazzn/.ogrammar-bench/{deepseek,abacus}.key
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const NUM_CTX = Number(process.env.NUM_CTX || 4096);
const REPEATS = Number((process.argv.find((a) => a.startsWith('--repeats=')) || '').split('=')[1] || 1);
const REMOTE_DELAY_MS = Number(process.env.REMOTE_DELAY_MS || 700); // pace remote calls under rate limits
const LOCAL_ARG = (process.argv.find((a) => a.startsWith('--local=')) || '').split('=')[1];
const INCLUDE_REMOTE = process.argv.includes('--remote');
const USE_MASKING = !process.argv.includes('--no-mask');

function loadTsModule(path) {
  const src = readFileSync(join(root, path), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { findProtectedSpans, maskProtectedText, restoreProtectedText } = await loadTsModule('src/shared/protectedText.ts');

function readKeyFile(p) {
  try { return readFileSync(p, 'utf8').trim(); } catch { return ''; }
}
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || readKeyFile('/home/zazzn/.ogrammar-bench/deepseek.key');
const ABACUS_KEY = process.env.ABACUS_API_KEY || readKeyFile('/home/zazzn/.ogrammar-bench/abacus.key');
const GROQ_KEY = process.env.GROQ_API_KEY || readKeyFile('/home/zazzn/.ogrammar-bench/groq.key');

// ── corpus + scoring (mirrors benchmark-ollama-writing-models.mjs) ───────────
function replaceOnce(text, original, replacement) {
  const i = text.indexOf(original);
  return i < 0 ? text : text.slice(0, i) + replacement + text.slice(i + original.length);
}
function expectedFromCorpus(entry) {
  if (entry.llmCorrection) return entry.llmCorrection;
  if (Array.isArray(entry.localIssues) && entry.localIssues.length) {
    return entry.localIssues.reduce((t, issue) => replaceOnce(t, issue.original, issue.suggestion), entry.text);
  }
  return entry.text;
}
function weightFor(entry) {
  if (entry.bucket === 'protected-span') return 4;
  if (entry.bucket === 'ignore') return 3;
  if (entry.bucket === 'sentence-review') return 2;
  return 1;
}
const corpus = JSON.parse(readFileSync(join(root, 'test-data/suggestion-corpus.json'), 'utf8'));
const CASES = corpus
  .filter((e) => !e.manual && e.status !== 'known-gap')
  .filter((e) => ['quick-fix', 'sentence-review', 'protected-span', 'ignore'].includes(e.bucket))
  .map((e) => ({
    id: e.id,
    bucket: e.bucket,
    text: e.text,
    expected: [expectedFromCorpus(e)],
    protected: e.protected || [],
    mustNotChange: e.bucket === 'ignore' || (e.bucket === 'protected-span' && !e.localIssues?.length),
    weight: weightFor(e),
  }));

const SYSTEM_PROMPT =
  'You are a conservative proofreading engine. Correct only objective ' +
  'errors: spelling, grammar, punctuation, capitalization, and obvious ' +
  'word-form mistakes. Do not improve style, tone, clarity, slang, or ' +
  'wording unless explicitly asked. Preserve meaning and casual voice. ' +
  'Do not normalize phonetic casual speech such as whadda, whaddya, ' +
  'whatcha, gotta, wanna, kinda, yall, or lol in correction mode. ' +
  'Preserve every protected fragment and placeholder EXACTLY. ' +
  'Placeholders look like [[OG_PROTECTED_1]] and must never be changed, removed, or reordered. ' +
  'If the sentence is ' +
  'acceptable as written, or if confidence is low, return shouldShow=false. ' +
  'Return JSON only with this shape: ' +
  '{"originalText":string,"correctedText":string,"shouldShow":boolean,' +
  '"protectedSpansPreserved":boolean,"corrections":[{"original":string,' +
  '"replacement":string,"start":number,"end":number,"type":"spelling|grammar|punctuation|capitalization|word-form","confidence":"high|medium|low","explanation":string}]}.';

const norm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
function protectedFragments(text) {
  return findProtectedSpans(text).map((s) => text.slice(s.start, s.end)).filter((f) => f.trim().length > 1);
}
function prepareLlmInput(test) {
  if (!USE_MASKING) {
    return {
      text: test.text,
      protectedFragments: protectedFragments(test.text),
      restore(parsed) { return parsed; },
    };
  }
  const mask = maskProtectedText(test.text);
  return {
    text: mask.maskedText,
    protectedFragments: mask.fragments.map((f) => f.placeholder),
    restore(parsed) {
      return {
        ...parsed,
        corrected: restoreProtectedText(parsed.corrected, mask),
      };
    },
  };
}
function countOccurrences(text, fragment) {
  if (!fragment) return 0;
  let c = 0, i = 0;
  while ((i = text.indexOf(fragment, i)) !== -1) { c++; i += fragment.length; }
  return c;
}
function hasProtectedDamage(original, corrected, fragments) {
  return fragments.some((f) => {
    const o = countOccurrences(original, f);
    return o > 0 && countOccurrences(corrected, f) !== o;
  });
}
function stripReasoning(s) {
  return String(s || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
    .replace(/\/(?:no_)?think\b/gi, '')
    .trim();
}
function parseCorrection(raw, original) {
  const cleaned = stripReasoning(raw);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { validJson: false, corrected: cleaned || original, shouldShow: true };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const shouldShow = parsed.shouldShow !== false;
    return { validJson: true, corrected: shouldShow ? String(parsed.correctedText || original).trim() : original, shouldShow };
  } catch {
    return { validJson: false, corrected: cleaned || original, shouldShow: true };
  }
}

// ── transport ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Retries 429 (rate limit) and 503 with backoff, honoring Retry-After. Without
// this, Groq's per-minute limits reject most of a 46-case burst as instant 429s.
async function httpJson(url, init, timeoutMs = 120000, retries = 6) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if ((r.status === 429 || r.status === 503) && attempt < retries) {
        const ra = Number(r.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 + 300 : Math.min(20000, 1000 * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function ollamaUnload(model) {
  try {
    await httpJson(`${OLLAMA}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    }, 15000);
  } catch { /* best effort */ }
}
async function ollamaPs() {
  try { return (await httpJson(`${OLLAMA}/api/ps`, {}, 10000)).models || []; } catch { return []; }
}

// Native /api/chat so we can pin num_ctx (memory) and disable thinking cleanly.
async function ollamaChat(model, test, thinking) {
  const prepared = prepareLlmInput(test);
  const body = {
    model,
    stream: false,
    format: 'json',
    keep_alive: '5m',
    options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 700 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ text: prepared.text, protectedFragments: prepared.protectedFragments }) },
    ],
  };
  if (thinking) body.think = false;
  const started = Date.now();
  const data = await httpJson(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - started;
  const raw = data?.message?.content || '';
  return { elapsedMs, parsed: prepared.restore(parseCorrection(raw, prepared.text)) };
}

// Remote OpenAI-compatible. Retries without response_format if the provider
// rejects it (some routed/reasoning models don't support JSON mode).
async function openaiChat(target, test) {
  const prepared = prepareLlmInput(test);
  const url = `${target.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const base = {
    model: target.model,
    temperature: 0,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ text: prepared.text, protectedFragments: prepared.protectedFragments }) },
    ],
  };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${target.key}` };
  const started = Date.now();
  let data;
  try {
    data = await httpJson(url, { method: 'POST', headers, body: JSON.stringify({ ...base, response_format: { type: 'json_object' } }) });
  } catch (e) {
    if (/\b(400|422)\b/.test(String(e.message))) {
      data = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(base) });
    } else {
      return { elapsedMs: Date.now() - started, parsed: { validJson: false, corrected: test.text, shouldShow: true }, error: String(e.message).slice(0, 120) };
    }
  }
  const elapsedMs = Date.now() - started;
  const msg = data?.choices?.[0]?.message || {};
  const raw = msg.content || msg.reasoning_content || '';
  return { elapsedMs, parsed: prepared.restore(parseCorrection(raw, prepared.text)), usage: data?.usage || {} };
}

// ── per-case scoring (mirrors codex's pass criteria exactly) ─────────────────
function scoreCase(test, parsed) {
  const fragments = [...new Set([...protectedFragments(test.text), ...test.protected])];
  const protects = !hasProtectedDamage(test.text, parsed.corrected, fragments);
  const expectedOk = test.expected.some((ex) => norm(ex) === norm(parsed.corrected));
  const effectivelyShows = parsed.shouldShow && norm(parsed.corrected) !== norm(test.text);
  const noFalsePositive = !test.mustNotChange || !effectivelyShows;
  const ok = parsed.validJson && protects && expectedOk && noFalsePositive;
  return { ok, protects, noFalsePositive, validJson: parsed.validJson };
}

async function runTarget(target) {
  let passed = 0, validJson = 0, protectedOk = 0, falsePositiveOk = 0;
  let srPass = 0, srTotal = 0, weighted = 0, weightedTotal = 0, hard = 0, totalMs = 0, n = 0;
  let loadMs = 0, gpuPct = null, errors = 0, promptToks = 0, complToks = 0;

  if (target.kind === 'ollama') {
    await ollamaUnload(target.model);
    const t0 = Date.now();
    await httpJson(`${OLLAMA}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.model, prompt: 'ok', stream: false, keep_alive: '5m', options: { num_predict: 1, num_ctx: NUM_CTX } }),
    }, 180000);
    loadMs = Date.now() - t0;
    const ps = (await ollamaPs()).find((m) => m.name === target.model || m.model === target.model);
    if (ps && ps.size) gpuPct = Math.round(100 * (ps.size_vram || 0) / ps.size);
  }

  const reps = target.kind === 'ollama' ? REPEATS : 1;
  for (let r = 0; r < reps; r++) {
    for (const test of CASES) {
      if (target.kind === 'remote' && REMOTE_DELAY_MS) await sleep(REMOTE_DELAY_MS);
      let res;
      try {
        res = target.kind === 'ollama' ? await ollamaChat(target.model, test, target.thinking) : await openaiChat(target, test);
      } catch (e) {
        res = { elapsedMs: 0, parsed: { validJson: false, corrected: test.text, shouldShow: true }, error: String(e.message).slice(0, 120) };
      }
      if (res.error) errors++;
      if (res.usage) { promptToks += res.usage.prompt_tokens || 0; complToks += res.usage.completion_tokens || 0; }
      totalMs += res.elapsedMs; n++;
      if (r > 0) continue; // score only first rep; extra reps just average latency
      const s = scoreCase(test, res.parsed);
      const w = test.weight || 1;
      weightedTotal += w;
      if (s.ok) { passed++; weighted += w; }
      if (s.validJson) validJson++;
      if (s.protects) protectedOk++;
      if (s.noFalsePositive) falsePositiveOk++;
      if (test.bucket === 'sentence-review') { srTotal++; if (s.ok) srPass++; }
      if (!s.protects || !s.noFalsePositive || !s.validJson) {
        hard++;
        if (r === 0) console.log(`  HARD ${target.name}: json=${s.validJson} prot=${s.protects} noFP=${s.noFalsePositive} :: ${JSON.stringify(test.text).slice(0, 90)}`);
      }
    }
  }
  if (target.kind === 'ollama') await ollamaUnload(target.model);

  return {
    name: target.name, kind: target.kind,
    exact: passed, total: CASES.length, weighted, weightedTotal,
    hard, validJson, protectedOk, falsePositiveOk, srPass, srTotal,
    avgMs: Math.round(totalMs / Math.max(1, n)), loadMs, gpuPct, errors,
    avgPrompt: n ? Math.round(promptToks / n) : 0, avgCompletion: n ? Math.round(complToks / n) : 0,
  };
}

// ── targets ──────────────────────────────────────────────────────────────────
const DEFAULT_LOCAL = ['qwen3:4b-instruct', 'llama3.2:3b', 'qwen2.5:3b', 'gemma2:2b', 'qwen2.5:7b', 'qwen2.5:1.5b'];
// LOCAL_ARG undefined (no --local flag) → default set; '' (--local=) → no local models.
const localModels = LOCAL_ARG !== undefined ? LOCAL_ARG.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_LOCAL;
const targets = localModels.map((m) => ({ kind: 'ollama', name: m, model: m, thinking: /\bqwen3\b|gemma3n|gemma4/i.test(m) && !/instruct/i.test(m) }));

if (INCLUDE_REMOTE) {
  if (ABACUS_KEY) targets.push({ kind: 'remote', name: 'abacus/route-llm', baseUrl: 'https://routellm.abacus.ai/v1', key: ABACUS_KEY, model: 'route-llm' });
  else console.log('(skipping Abacus — no key)');
  if (DEEPSEEK_KEY) {
    targets.push({ kind: 'remote', name: 'deepseek/deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', key: DEEPSEEK_KEY, model: 'deepseek-chat' });
    targets.push({ kind: 'remote', name: 'deepseek/deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', key: DEEPSEEK_KEY, model: 'deepseek-reasoner' });
  } else console.log('(skipping DeepSeek — no key)');
}

// Groq: --groq uses a default production shortlist; --groq=m1,m2 picks models.
// Independent of --remote so you can benchmark Groq on its own.
const groqArg = process.argv.find((a) => a === '--groq' || a.startsWith('--groq='));
if (groqArg) {
  if (!GROQ_KEY) {
    console.log('(skipping Groq — no key at ~/.ogrammar-bench/groq.key or $GROQ_API_KEY)');
  } else {
    const GROQ_DEFAULT = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
    const list = groqArg.includes('=') ? groqArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : GROQ_DEFAULT;
    for (const m of list) {
      targets.push({ kind: 'remote', name: `groq/${m}`, baseUrl: 'https://api.groq.com/openai/v1', key: GROQ_KEY, model: m, thinking: /r1|reason|think/i.test(m) });
    }
  }
}

console.log(`Cases: ${CASES.length}  num_ctx: ${NUM_CTX}  local-repeats: ${REPEATS}  masking: ${USE_MASKING ? 'on' : 'off'}`);
console.log(`Targets: ${targets.map((t) => t.name).join(', ')}\n`);

const results = [];
for (const target of targets) {
  process.stdout.write(`running ${target.name} ... `);
  try {
    const r = await runTarget(target);
    results.push(r);
    console.log(`exact ${r.exact}/${r.total} weighted ${r.weighted}/${r.weightedTotal} hard ${r.hard} avg ${r.avgMs}ms${r.kind === 'ollama' ? ` load ${r.loadMs}ms gpu ${r.gpuPct}%` : ''}${r.errors ? ` ERRORS ${r.errors}` : ''}`);
  } catch (e) {
    console.log(`FAILED: ${String(e.message).slice(0, 160)}`);
    results.push({ name: target.name, kind: target.kind, failed: String(e.message).slice(0, 200) });
  }
}

results.sort((a, b) => (b.weighted || -1) - (a.weighted || -1) || (b.exact || -1) - (a.exact || -1) || (a.avgMs || 1e9) - (b.avgMs || 1e9));

console.log('\n=== SUMMARY (sorted by weighted quality) ===');
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log(`${pad('Model', 28)} ${padl('Exact', 7)} ${padl('Weighted', 9)} ${padl('Hard', 5)} ${padl('JSON', 5)} ${padl('Prot', 5)} ${padl('NoFP', 5)} ${padl('SentRev', 8)} ${padl('Avg ms', 8)} ${padl('GPU%', 5)}`);
for (const r of results) {
  if (r.failed) { console.log(`${pad(r.name, 28)} FAILED: ${r.failed.slice(0, 80)}`); continue; }
  console.log(`${pad(r.name, 28)} ${padl(`${r.exact}/${r.total}`, 7)} ${padl(`${r.weighted}/${r.weightedTotal}`, 9)} ${padl(r.hard, 5)} ${padl(`${r.validJson}/${r.total}`, 5)} ${padl(`${r.protectedOk}/${r.total}`, 5)} ${padl(`${r.falsePositiveOk}/${r.total}`, 5)} ${padl(`${r.srPass}/${r.srTotal}`, 8)} ${padl(r.avgMs, 8)} ${padl(r.kind === 'ollama' ? r.gpuPct : 'cloud', 5)}`);
}

const remote = results.filter((r) => r.kind === 'remote' && !r.failed);
if (remote.length) {
  console.log('\n=== remote token usage (avg per call) — for cost estimates ===');
  for (const r of remote) console.log(`${pad(r.name, 28)} prompt ${padl(r.avgPrompt, 5)}  completion ${padl(r.avgCompletion, 5)}`);
}

const outPath = '/tmp/benchmark-models-results.json';
writeFileSync(outPath, JSON.stringify({ cases: CASES.length, numCtx: NUM_CTX, repeats: REPEATS, masking: USE_MASKING, results }, null, 2));
console.log(`\nwrote ${outPath}`);
