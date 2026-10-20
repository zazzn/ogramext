import type {
  AnalysisContext,
  AnalyticsEventType,
  AnalyticsSummary,
  AnalyzeResponse,
  EditorContext,
  LLMProvider,
  RewriteResponse,
  Issue,
} from '../types';
import { harperLint, invalidateHarperLinter, warmHarper } from './harperEngine';
import { getApiKey } from '../shared/apiKeyStore';
import {
  filterIssuesInProtectedSpans,
  findProtectedSpans,
  maskProtectedText,
  preservesProtectedPlaceholders,
  restoreProtectedText,
  type ProtectedTextMask,
} from '../shared/protectedText';
import { applyIssuePolicy } from './issuePolicy';
import { DEFAULT_WRITING_MODEL } from '../shared/ollamaModels';
// The AI instructions, shared verbatim with the desktop + mobile apps (see _about).
import prompts from '../shared/prompts.json';
import { PROVIDERS } from '../types';
import {
  chatCompletion,
  listModels,
  ollamaKeepAliveParam,
  ollamaPull as ollamaPullDirect,
  ollamaStatus,
  ollamaTags,
  ollamaUnload as ollamaUnloadDirect,
  resolveBaseUrl,
} from './llmClient';
import { clearLog, formatCompact, logEvent } from './debugLog';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_ANALYTICS: AnalyticsSummary = {
  totals: {
    analysis_runs: 0,
    issues_found: 0,
    suggestions_applied: 0,
    suggestions_ignored: 0,
    rewrite_opened: 0,
    rewrite_applied: 0,
  },
  domains: {},
  providers: {},
};

chrome.runtime.onInstalled.addListener(() => {
  void initializeStoredDefaults();
  void warmHarper();
});

// Warm the local engine when the SW spins back up so the first keystroke
// after an idle period doesn't pay the WASM init cost.
chrome.runtime.onStartup.addListener(() => {
  void warmHarper();
});

void initializeStoredDefaults();
void warmHarper();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CHECK_GRAMMAR') {
    handleGrammarCheck(request.text, request.context, sendResponse);
    return true;
  }

  if (request.type === 'REWRITE_TEXT') {
    handleRewrite(request.text, request.tone, sendResponse);
    return true;
  }

  if (request.type === 'REPHRASE_TEXT') {
    rephraseText(request.sentence, request.goal)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (request.type === 'GET_DEBUG_LOG') {
    formatCompact().then((r) => sendResponse(r));
    return true;
  }

  if (request.type === 'CLEAR_DEBUG_LOG') {
    clearLog().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'GET_SELECTION') {
    // Get selected text from the current tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_TEXT' }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ text: '' });
      }
    });
    return true;
  }

  if (request.type === 'SYNC_ACTIVE_CONTEXT') {
    const tabId = sender.tab?.id;
    if (!tabId || typeof request.text !== 'string') {
      sendResponse({ success: false });
      return false;
    }

    void storeActiveContext(tabId, request.text, request.issues || []).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_ACTIVE_TEXT') {
    void getActiveEditorContext().then((context) => {
      sendResponse(context || { text: '', issues: [] });
    });
    return true;
  }

  if (request.type === 'TRACK_ANALYTICS_EVENT') {
    void trackAnalyticsEvent(request.eventType, request.payload).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_ANALYTICS_SUMMARY') {
    void getAnalyticsSummary().then((summary) => sendResponse(summary));
    return true;
  }

  if (request.type === 'CLEAR_ANALYTICS') {
    void chrome.storage.sync.set({ analyticsSummary: DEFAULT_ANALYTICS }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_PROVIDERS') {
    sendResponse({ providers: getProviders() });
    return false;
  }

  if (request.type === 'GET_MODELS') {
    getModels(request.provider, request.apiKey, request.baseUrl)
      .then((models) => sendResponse({ models }))
      .catch((e) => sendResponse({ models: [], error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (request.type === 'CORRECT_TEXT') {
    correctText(request.text).then((r) => sendResponse(r));
    return true;
  }

  if (request.type === 'GET_OLLAMA_STATUS') {
    getOllamaStatus(request.baseUrl, request.model, request.probe)
      .then((s) => sendResponse(s))
      .catch((e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  if (request.type === 'OLLAMA_UNLOAD') {
    unloadOllama(request.baseUrl, request.model).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'OLLAMA_PULL') {
    pullOllama(request.baseUrl, request.model).then((r) => sendResponse(r));
    return true;
  }

  // D1: Badge count update
  if (request.type === 'UPDATE_BADGE_COUNT') {
    void updateBadge(request.count, sender.tab?.id);
    sendResponse({ success: true });
    return false;
  }

  // D4: Writing history
  if (request.type === 'SAVE_WRITING_SESSION') {
    void saveWritingSession(request.payload).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_WRITING_HISTORY') {
    void getWritingHistory(request.days || 30).then((history) => {
      sendResponse(history);
    });
    return true;
  }

  // Unknown message type — respond so a waiting sender never hangs on a dropped channel.
  sendResponse({ error: `unknown message type: ${request?.type}` });
  return false;
});


function filterIssues(issues: Issue[] | undefined, ignoredIssues: string[], dictionary: string[]): Issue[] {
  if (!issues || issues.length === 0) return [];
  let filtered = issues;

  const normalizedIgnored = normalizeIgnoredIssues(ignoredIssues);
  if (normalizedIgnored.length > 0) {
    filtered = filtered.filter((issue) => {
      // Word-keyed (TYPE + WORD, not position) so a dismissal sticks wherever the
      // word reappears — parity with the desktop's persisted ignore list.
      const issueId = `${issue.type}-${issue.original.toLowerCase().trim()}`;
      return !normalizedIgnored.includes(issueId);
    });
  }

  if (dictionary && dictionary.length > 0) {
    filtered = filtered.filter((issue) => {
      if (issue.type !== 'spelling') return true;
      const word = issue.original.toLowerCase().trim();
      return !dictionary.includes(word);
    });
  }

  return filtered;
}

function preservesProtectedFragments(original: string, candidate: string): boolean {
  const fragments = findProtectedSpans(original)
    .map((span) => original.slice(span.start, span.end))
    .filter((fragment) => fragment.trim().length > 1);

  return fragments.every((fragment) => candidate.includes(fragment));
}

interface LlmCorrectionSpan {
  original?: string;
  replacement?: string;
  start?: number;
  end?: number;
  type?: 'spelling' | 'grammar' | 'punctuation' | 'capitalization' | 'word-form';
  confidence?: 'high' | 'medium' | 'low';
  explanation?: string;
}

interface LlmCorrectionPayload {
  originalText?: string;
  correctedText?: string;
  corrections?: LlmCorrectionSpan[];
  protectedSpansPreserved?: boolean;
  shouldShow?: boolean;
}

function protectedFragmentList(text: string): string[] {
  return findProtectedSpans(text)
    .map((span) => text.slice(span.start, span.end))
    .filter((fragment) => fragment.trim().length > 1);
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]?.trim().startsWith('{')) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

function parseCorrectionPayload(raw: string): LlmCorrectionPayload | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as LlmCorrectionPayload;
  } catch {
    return null;
  }
}

function tokenChangeRatio(original: string, candidate: string): number {
  const ow = (original.match(/[A-Za-z0-9']+/g) || []).map((w) => w.toLowerCase());
  const cw = (candidate.match(/[A-Za-z0-9']+/g) || []).map((w) => w.toLowerCase());
  if (ow.length === 0) return candidate.trim() === '' ? 0 : 1;
  const maxLen = Math.max(ow.length, cw.length);

  let prev = new Array(cw.length + 1).fill(0);
  let cur = new Array(cw.length + 1).fill(0);
  for (let i = 1; i <= ow.length; i++) {
    for (let j = 1; j <= cw.length; j++) {
      cur[j] = ow[i - 1] === cw[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  const same = prev[cw.length] || 0;
  return (maxLen - same) / Math.max(1, maxLen);
}

function isConservativeCorrection(original: string, candidate: string): boolean {
  const o = original.trim();
  const c = candidate.trim();
  if (!c || o === c) return true;
  if (c.length > Math.max(80, o.length * 1.8)) return false;
  if (c.length < Math.max(1, o.length * 0.45)) return false;

  const originalWords = o.match(/[A-Za-z0-9']+/g)?.length || 0;
  const ratio = tokenChangeRatio(o, c);
  const maxRatio = originalWords <= 8 ? 0.65 : 0.48;
  return ratio <= maxRatio;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply the model's word-level corrections to `text`, keeping ONLY edits whose
 * target does not overlap a protected span. The model sees the full sentence
 * (so it understands context and corrects well); protection is enforced HERE by
 * filtering its edits — jargon/URLs/code are preserved by construction, and a
 * single bad edit never discards the whole correction. Each `original` is
 * matched at a word boundary so we don't replace a substring inside another word
 * (e.g. the "i" inside "this"). Edits are applied right-to-left to keep offsets
 * valid, skipping any that overlap an already-applied edit.
 */
function applySafeCorrections(
  text: string,
  corrections: LlmCorrectionSpan[],
  spans: { start: number; end: number }[],
): { corrected: string; applied: LlmCorrectionSpan[] } {
  const edits: { start: number; end: number; replacement: string; c: LlmCorrectionSpan }[] = [];
  for (const c of corrections) {
    const original = (c.original || '').trim();
    const replacement = c.replacement ?? '';
    if (!original || original === replacement) continue;
    const wordish = /^[A-Za-z0-9']+$/.test(original);
    const re = wordish
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(original)}(?![A-Za-z0-9])`, 'g')
      : new RegExp(escapeRegExp(original), 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + original.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue; // inside a protected span
      edits.push({ start, end, replacement, c });
      break; // first safe occurrence
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  const used: { start: number; end: number }[] = [];
  const applied: LlmCorrectionSpan[] = [];
  for (const e of edits) {
    if (used.some((r) => e.start < r.end && e.end > r.start)) continue;
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    used.push({ start: e.start, end: e.end });
    // Stamp the RESOLVED (protected-span-safe) offsets onto the returned
    // correction. Without this, the content script's buildLlmIssues re-searches
    // for `original` and may anchor the inline underline at a different (e.g.
    // protected) occurrence in repeated-token text. These offsets are valid
    // against the ORIGINAL `text` the model was given (which is what the content
    // script also re-derives), so they line up 1:1.
    applied.push({ ...e.c, start: e.start, end: e.end });
  }
  return { corrected: out, applied };
}

/**
 * Derive per-word corrections by aligning original vs corrected text with a word
 * LCS. Used when the model returns a good correctedText but NO usable structured
 * corrections array — which LLMs do often (we observed deepseek-chat return a
 * perfect corrected sentence with an empty/omitted corrections list, leaving the
 * proactive inline pass with nothing to underline). The LCS keeps unchanged
 * words aligned and emits a correction for each changed RUN (one or more
 * original words → one or more corrected words), so it handles word-count
 * changes too (e.g. "work I 'd" → "work, I'd"). Offsets are exact (the original
 * substring spanning the changed run); pure insertions/deletions and
 * protected-span runs are skipped, and over-long runs are dropped so a big
 * rewrite never paints a whole line.
 */
function correctionsFromDiff(
  original: string,
  corrected: string,
  spans: { start: number; end: number }[],
): LlmCorrectionSpan[] {
  const o: { text: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(original)) !== null) o.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  const c = corrected.match(/\S+/g) || [];
  const n = o.length;
  const p = c.length;
  if (n === 0) return [];
  // LCS length table (top-down) over the two word sequences.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(p + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = p - 1; j >= 0; j--) {
      dp[i]![j] = o[i]!.text === c[j]! ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LlmCorrectionSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < p) {
    if (i < n && j < p && o[i]!.text === c[j]!) { i++; j++; continue; }
    const dels: typeof o = [];
    const ins: string[] = [];
    while ((i < n || j < p) && !(i < n && j < p && o[i]!.text === c[j]!)) {
      if (j >= p) { dels.push(o[i]!); i++; }
      else if (i >= n) { ins.push(c[j]!); j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { dels.push(o[i]!); i++; }
      else { ins.push(c[j]!); j++; }
    }
    if (dels.length && ins.length) {
      const start = dels[0]!.start;
      const end = dels[dels.length - 1]!.end;
      const orig = original.slice(start, end);
      const repl = ins.join(' ');
      if (
        orig && repl && orig !== repl &&
        end - start <= 120 && repl.length <= 120 &&
        !spans.some((s) => start < s.end && end > s.start)
      ) {
        out.push({ original: orig, replacement: repl, start, end, type: 'grammar', confidence: 'high' });
      }
    }
  }
  return out;
}

function normalizeCorrectionResult(
  text: string,
  raw: string,
  mask?: ProtectedTextMask,
): { corrected: string; corrections: LlmCorrectionSpan[]; shouldShow: boolean } {
  const parsed = parseCorrectionPayload(raw);
  if (parsed?.shouldShow === false) {
    return { corrected: text, corrections: [], shouldShow: false };
  }

  if (!mask) {
    // Default path: full context in, apply only protected-span-safe edits.
    const spans = findProtectedSpans(text);
    const corrections = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
    if (corrections.length > 0) {
      const { corrected, applied } = applySafeCorrections(text, corrections, spans);
      return { corrected, corrections: applied, shouldShow: corrected.trim() !== text.trim() };
    }
    // No structured edits: fall back to the model's full correctedText, but only
    // if it keeps protected fragments intact and isn't an over-broad rewrite.
    // DERIVE per-word corrections from the diff so the proactive inline pass can
    // still draw blue underlines (the model often omits the corrections array).
    const proposed = (parsed?.correctedText || '').trim();
    if (
      proposed &&
      proposed !== text.trim() &&
      preservesProtectedFragments(text, proposed) &&
      isConservativeCorrection(text, proposed)
    ) {
      return { corrected: proposed, corrections: correctionsFromDiff(text, proposed, spans), shouldShow: true };
    }
    return { corrected: text, corrections: [], shouldShow: false };
  }

  // Legacy opt-in masking path (unchanged behaviour).
  const correctedMasked = (parsed?.correctedText || (!parsed ? raw : '')).trim();
  const proposedMasked = correctedMasked || mask.maskedText;
  const proposed = restoreProtectedText(proposedMasked, mask);
  const safe =
    preservesProtectedPlaceholders(proposedMasked, mask) &&
    preservesProtectedFragments(text, proposed) &&
    isConservativeCorrection(text, proposed) &&
    parsed?.protectedSpansPreserved !== false;
  if (!safe) {
    return { corrected: text, corrections: [], shouldShow: false };
  }
  return { corrected: proposed, corrections: [], shouldShow: proposed.trim() !== text.trim() };
}

async function handleGrammarCheck(
  text: string,
  context: AnalysisContext | undefined,
  sendResponse: (response: any) => void,
) {
  try {
    const { enabled, ignoredIssues, dictionary } = await chrome.storage.sync.get([
      'enabled',
      'ignoredIssues',
      'dictionary',
    ]);

    if (enabled === false) {
      sendResponse({
        issues: [],
        metadata: { textLength: text.length, issuesCount: 0, processingTimeMs: 0 },
      });
      return;
    }

    // Inline tier: Harper local engine. Instant, on-device, mechanical, fully
    // offline — no backend. The grammar/tone button (CORRECT_TEXT) is the only
    // LLM path and is separate. If Harper itself fails to init we return no
    // issues (the legacy rule-engine fallback was removed with the backend).
    try {
      const t0 = Date.now();
      const harperIssues = await harperLint(text);
      const contextSafeIssues = filterIssuesInProtectedSpans(
        harperIssues,
        findProtectedSpans(text),
      );
      const policySafeIssues = applyIssuePolicy(contextSafeIssues);
      const filtered = filterIssues(policySafeIssues, ignoredIssues || [], dictionary || []);

      await trackAnalyticsEvent('analysis_runs', {
        count: 1,
        domain: context?.domain,
        provider: 'harper',
      });
      if (filtered.length > 0) {
        await trackAnalyticsEvent('issues_found', {
          count: filtered.length,
          domain: context?.domain,
          provider: 'harper',
        });
      }

      void updateBadge(filtered.length, undefined);

      logEvent({
        kind: 'harper',
        meta: `${filtered.length} issue(s) in ${Date.now() - t0}ms`,
        in: text,
        out: filtered
          .slice(0, 12)
          .map((i) => `${i.route}:${i.type}:"${i.original}"→"${i.suggestion}"`)
          .join(' · '),
      });

      sendResponse({
        issues: filtered,
        metadata: {
          textLength: text.length,
          issuesCount: filtered.length,
          processingTimeMs: Date.now() - t0,
          provider: 'harper',
        },
      });
    } catch (harperError) {
      console.warn('[harper] lint failed; returning no issues:', harperError);
      sendResponse({
        issues: [],
        metadata: { textLength: text.length, issuesCount: 0, processingTimeMs: 0 },
      });
    }
  } catch (error) {
    console.error('Grammar check failed:', error);
    sendResponse({
      error: 'Failed to check grammar',
      message: error instanceof Error ? error.message : 'Unknown error',
      issues: [],
    });
  }
}

async function handleRewrite(text: string, tone: string, sendResponse: (response: any) => void) {
  try {
    if (!text || !tone) {
      sendResponse({ error: 'Text and tone are required' });
      return;
    }
    const apiKey = await getApiKey();
    const { model, provider, customBaseUrl, ollamaUrl, ollamaKeepAlive, llmProtectedMasking } =
      await chrome.storage.sync.get([
        'model',
        'provider',
        'customBaseUrl',
        'ollamaUrl',
        'ollamaKeepAlive',
        'llmProtectedMasking',
      ]);

    const toneSpec = prompts.rewrite.tones.find((t) => t.id === tone);
    if (!toneSpec) {
      sendResponse({ error: `Unknown tone: ${tone}` });
      return;
    }

    const rewritten = await chatCompletion({
      apiKey,
      baseURL: resolveBaseUrl(provider, customBaseUrl, ollamaUrl),
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompts.rewrite.system.replace('{instruction}', toneSpec.instruction) },
        { role: 'user', content: text },
      ],
      // Same settings as the desktop/mobile `llm_rewrite`: deterministic, and a token
      // budget that scales with the text so long messages aren't cut off.
      temperature: 0,
      maxTokens: Math.min(4000, Math.max(256, [...text].length * 2 + 200)),
      extraBody: ollamaKeepAliveParam(provider, ollamaKeepAlive),
      nativeOllama: provider === 'ollama',
    });

    const proposed = rewritten || text;
    const safeRewrite = preservesProtectedFragments(text, proposed) ? proposed : text;
    const data: RewriteResponse = { original: text, rewritten: safeRewrite, tone };
    logEvent({ kind: 'rewrite', provider, model, meta: tone, in: text, out: data.rewritten });
    sendResponse(data);
  } catch (error) {
    console.error('Rewrite failed:', error);
    sendResponse({
      error: 'Failed to rewrite text',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Multi-suggestion rephrase (the review card's "alternatives" panel). The prompt and
// goals live in the shared prompts.json (the desktop app uses the same ones). Returns
// the shape the panel renders: { suggestions:[{text,label}], explanation, bestMatch }.

/** Up to three usable alternatives from the model's `suggestions` — the same filter as
 *  the desktop's `parse_rephrase`: non-empty, not the unchanged sentence, no repeats,
 *  and every URL/@handle/code/ID/version kept verbatim. */
function usableRephrasings(
  sentence: string,
  raw: unknown,
): { text: string; label: string }[] {
  const seen = new Set<string>();
  const out: { text: string; label: string }[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const text = String(typeof s === 'string' ? s : (s?.text ?? '')).trim();
    if (!text || text === sentence.trim() || seen.has(text)) continue;
    if (!preservesProtectedFragments(sentence, text)) continue;
    seen.add(text);
    out.push({ text, label: (typeof s === 'object' && s?.label) || 'Option' });
    if (out.length === 3) break;
  }
  return out;
}

async function rephraseText(
  sentence: string,
  goal: string,
): Promise<{
  suggestions: { text: string; label: string }[];
  explanation: string;
  bestMatch: number;
}> {
  try {
    if (!sentence) return { suggestions: [], explanation: '', bestMatch: 0 };
    const apiKey = await getApiKey();
    const { model, provider, customBaseUrl, ollamaUrl, ollamaKeepAlive, llmProtectedMasking } =
      await chrome.storage.sync.get([
        'model',
        'provider',
        'customBaseUrl',
        'ollamaUrl',
        'ollamaKeepAlive',
        'llmProtectedMasking',
      ]);
    if (!apiKey && provider !== 'ollama') {
      return {
        suggestions: [],
        explanation: 'Rephrase failed. Please check your API key and try again.',
        bestMatch: 0,
      };
    }
    const goalSpec =
      prompts.rephrase.goals.find((g) => g.id === goal) || prompts.rephrase.goals[0];
    const raw = await chatCompletion({
      apiKey,
      baseURL: resolveBaseUrl(provider, customBaseUrl, ollamaUrl),
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompts.rephrase.system },
        {
          role: 'user',
          content: prompts.rephrase.user
            .replace('{goal}', goalSpec.description)
            .replace('{text}', () => sentence),
        },
      ],
      // Varied on purpose (three DIFFERENT alternatives); the budget fits three
      // rewrites of a long sentence plus the JSON around them.
      temperature: 0.7,
      maxTokens: Math.min(4000, Math.max(512, sentence.length * 2 + 300)),
      responseFormat: { type: 'json_object' },
      extraBody: ollamaKeepAliveParam(provider, ollamaKeepAlive),
      nativeOllama: provider === 'ollama',
    });
    const cleaned = (raw || '{}').replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    const suggestions = usableRephrasings(sentence, parsed.suggestions);
    const result = {
      suggestions,
      explanation: parsed.explanation || '',
      bestMatch: typeof parsed.bestMatch === 'number' ? parsed.bestMatch : 0,
    };
    logEvent({
      kind: 'rephrase',
      provider,
      model,
      meta: goal,
      in: sentence,
      out: result.suggestions.map((s: { text: string }) => s.text).join(' | '),
    });
    return result;
  } catch (error) {
    console.error('Rephrase error:', error);
    return {
      suggestions: [],
      explanation: 'Rephrase failed. Please check your API key and try again.',
      bestMatch: 0,
    };
  }
}

function getProviders() {
  return PROVIDERS;
}

// Live model list. Ollama: the native /api/tags (what `ollama list` uses)
// — the real installed models, not the curated names. Other providers:
// their OpenAI-compatible /v1/models when a key is set. The static
// PROVIDERS list is only a fallback for an unreachable server / no key.
async function getModels(provider: string, apiKey?: string, baseUrl?: string) {
  const staticModels = PROVIDERS.find((p) => p.id === provider)?.models || [];
  if (provider === 'ollama') {
    const live = await ollamaTags(baseUrl);
    return live.length > 0 ? live : staticModels;
  }
  if (apiKey && apiKey !== 'ollama') {
    const live = await listModels(provider, apiKey, baseUrl);
    if (live.length > 0) return live;
  }
  return staticModels;
}

// Whole-text correctness pass. Prompt/params ported verbatim from the former
// backend /correct so output is identical. No key (and not Ollama) → signal
// the content script to use its safe local fallback (llm:false); any error
// returns the original unchanged so a card never garbles.
async function correctText(
  text: string,
): Promise<{
  original: string;
  corrected: string;
  llm: boolean;
  corrections?: LlmCorrectionSpan[];
  shouldShow?: boolean;
  error?: string;
}> {
  try {
    const apiKey = await getApiKey();
    const { model, provider, customBaseUrl, ollamaUrl, ollamaKeepAlive, llmProtectedMasking } =
      await chrome.storage.sync.get([
        'model',
        'provider',
        'customBaseUrl',
        'ollamaUrl',
        'ollamaKeepAlive',
        'llmProtectedMasking',
      ]);

    if (!apiKey && provider !== 'ollama') {
      return { original: text, corrected: text, llm: false };
    }

    // Default OFF: send the full sentence (better corrections) and enforce
    // protection by applying only safe edits (see normalizeCorrectionResult).
    // Masking is now an explicit opt-in — it strips context and made the model
    // abstain on jargon-heavy text.
    const useMasking = llmProtectedMasking === true;
    const mask = useMasking ? maskProtectedText(text) : undefined;
    const llmText = mask?.maskedText || text;
    const protectedFragments = mask?.fragments.map((fragment) => fragment.placeholder) || protectedFragmentList(text);
    const raw = await chatCompletion({
      apiKey,
      baseURL: resolveBaseUrl(provider, customBaseUrl, ollamaUrl),
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompts.proofread.system },
        {
          role: 'user',
          content: JSON.stringify({
            text: llmText,
            protectedFragments,
          }),
        },
      ],
      temperature: 0,
      maxTokens: Math.min(4000, Math.ceil(text.length / 2) + 600),
      extraBody: ollamaKeepAliveParam(provider, ollamaKeepAlive),
      nativeOllama: provider === 'ollama',
    });
    const result = normalizeCorrectionResult(text, raw, mask);
    logEvent({
      kind: 'correct',
      provider,
      model,
      meta: result.shouldShow ? 'changed' : 'no-change',
      in: text,
      out: result.corrected,
    });
    return {
      original: text,
      corrected: result.corrected,
      llm: true,
      corrections: result.corrections,
      shouldShow: result.shouldShow,
    };
  } catch (error) {
    console.error('Correct error:', error);
    return {
      original: text,
      corrected: text,
      llm: false,
      shouldShow: false,
      error: error instanceof Error ? error.message : 'Correction failed',
    };
  }
}

async function getOllamaStatus(baseUrl?: string, model?: string, probe?: boolean) {
  console.log('[OGrammar] getOllamaStatus →', { baseUrl, model, probe });
  const r = await ollamaStatus(baseUrl, model, probe);
  console.log('[OGrammar] getOllamaStatus ←', r);
  return r;
}

/**
 * Explicitly unload the Ollama model so memory/VRAM returns to the system.
 * Fired when the user switches away from Ollama or disables the extension
 * (the idle keep_alive handles the in-use case). Best-effort; silent on
 * failure (Ollama may simply not be reachable).
 */
async function unloadOllama(ollamaUrl?: string, model?: string): Promise<void> {
  try {
    await ollamaUnloadDirect(ollamaUrl, model);
  } catch {
    /* Ollama not reachable — nothing to reclaim. */
  }
}

async function pullOllama(
  ollamaUrl?: string,
  model = DEFAULT_WRITING_MODEL,
): Promise<{ success: boolean; error?: string }> {
  try {
    return await ollamaPullDirect(ollamaUrl, model);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `Could not pull ${model}`,
    };
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  // Spelling dialect changed → rebuild the linter with the new dialect so the
  // next check uses it, and warm it ahead of the first keystroke.
  if (changes.harperDialect) {
    invalidateHarperLinter();
    void warmHarper();
  }

  // Provider switched away from Ollama → free the local model's memory.
  if (
    changes.provider &&
    changes.provider.oldValue === 'ollama' &&
    changes.provider.newValue !== 'ollama'
  ) {
    chrome.storage.sync.get(['ollamaUrl', 'model'], (r) => {
      void unloadOllama(r.ollamaUrl, r.model);
    });
  }

  // Extension disabled while Ollama is the active provider → free memory.
  if (changes.enabled && changes.enabled.newValue === false) {
    chrome.storage.sync.get(['provider', 'ollamaUrl', 'model'], (r) => {
      if (r.provider === 'ollama') void unloadOllama(r.ollamaUrl, r.model);
    });
  }
});

async function initializeStoredDefaults(): Promise<void> {
  const existing = await chrome.storage.sync.get([
    'enabled',
    'provider',
    'model',
    'llmProtectedMasking',
  ]);

  await chrome.storage.sync.set({
    enabled: existing.enabled !== false,
    provider: existing.provider || DEFAULT_PROVIDER,
    model: existing.model || DEFAULT_MODEL,
    llmProtectedMasking: existing.llmProtectedMasking !== false,
  });
}

function normalizeIgnoredIssues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      if (entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string') {
        return entry.id;
      }

      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

async function storeActiveContext(
  sourceTabId: number,
  text: string,
  issues: AnalyzeResponse['issues'] = [],
): Promise<void> {
  const payload: EditorContext = {
    text,
    issues,
    sourceTabId,
    capturedAt: Date.now(),
  };

  await chrome.storage.local.set({ lastEditorContext: payload });
}

async function getActiveEditorContext(): Promise<EditorContext | null> {
  const result = await chrome.storage.local.get('lastEditorContext');
  return (result.lastEditorContext as EditorContext | undefined) || null;
}

async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const result = await chrome.storage.sync.get('analyticsSummary');
  return {
    ...DEFAULT_ANALYTICS,
    ...(result.analyticsSummary as AnalyticsSummary | undefined),
    totals: {
      ...DEFAULT_ANALYTICS.totals,
      ...((result.analyticsSummary as AnalyticsSummary | undefined)?.totals || {}),
    },
    domains: {
      ...((result.analyticsSummary as AnalyticsSummary | undefined)?.domains || {}),
    },
    providers: {
      ...((result.analyticsSummary as AnalyticsSummary | undefined)?.providers || {}),
    },
  };
}

async function trackAnalyticsEvent(
  eventType: AnalyticsEventType,
  payload?: { count?: number; domain?: string; provider?: string },
): Promise<void> {
  const summary = await getAnalyticsSummary();
  const count = payload?.count || 1;
  summary.totals[eventType] = (summary.totals[eventType] || 0) + count;

  if (payload?.domain) {
    summary.domains[payload.domain] = (summary.domains[payload.domain] || 0) + count;
  }

  if (payload?.provider) {
    summary.providers[payload.provider] = (summary.providers[payload.provider] || 0) + count;
  }

  summary.lastUpdatedAt = Date.now();
  await chrome.storage.sync.set({ analyticsSummary: summary });
}

// ─── D1: Badge ───────────────────────────────────────────────────────────────

async function updateBadge(issueCount: number, tabId?: number): Promise<void> {
  try {
    if (issueCount > 0) {
      const text = issueCount > 99 ? '99+' : String(issueCount);
      const color = issueCount > 5 ? '#DC2626' : issueCount > 0 ? '#F59E0B' : '#16A34A';
      await chrome.action.setBadgeText({ text, tabId });
      await chrome.action.setBadgeBackgroundColor({ color, tabId });
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }
  } catch (error) {
    // Badge API may not be available in all contexts
    console.debug('Badge update failed:', error);
  }
}

// ─── D4: Writing History ─────────────────────────────────────────────────────

interface WritingSessionEntry {
  date: string; // YYYY-MM-DD
  wordsChecked: number;
  issuesFound: number;
  issuesFixed: number;
  writingScore: number;
  sessionsCount: number;
  topErrors: Record<string, number>;
}

async function saveWritingSession(payload: {
  wordsChecked: number;
  issuesFound: number;
  issuesFixed: number;
  writingScore: number;
  errorTypes?: Record<string, number>;
}): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const result = await chrome.storage.local.get('writingHistory');
  const history: Record<string, WritingSessionEntry> = result.writingHistory || {};

  const existing = history[today] || {
    date: today,
    wordsChecked: 0,
    issuesFound: 0,
    issuesFixed: 0,
    writingScore: 0,
    sessionsCount: 0,
    topErrors: {},
  };

  existing.wordsChecked += payload.wordsChecked;
  existing.issuesFound += payload.issuesFound;
  existing.issuesFixed += payload.issuesFixed;
  existing.sessionsCount += 1;

  // Rolling average of writing score
  existing.writingScore = Math.round(
    (existing.writingScore * (existing.sessionsCount - 1) + payload.writingScore) /
      existing.sessionsCount,
  );

  // Aggregate error types
  if (payload.errorTypes) {
    for (const [type, count] of Object.entries(payload.errorTypes)) {
      existing.topErrors[type] = (existing.topErrors[type] || 0) + count;
    }
  }

  history[today] = existing;

  // Keep only last 90 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(history)) {
    if (key < cutoffStr) delete history[key];
  }

  await chrome.storage.local.set({ writingHistory: history });
}

async function getWritingHistory(days: number = 30): Promise<WritingSessionEntry[]> {
  const result = await chrome.storage.local.get('writingHistory');
  const history: Record<string, WritingSessionEntry> = result.writingHistory || {};

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return Object.values(history)
    .filter((entry) => entry.date >= cutoffStr)
    .sort((a, b) => a.date.localeCompare(b.date));
}
