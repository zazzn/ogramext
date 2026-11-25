// Harper local engine — the instant, on-device MECHANICAL tier.
//
// Runs Automattic Harper (Rust → WASM, Apache-2.0) inside the MV3 background
// service worker. Content scripts can't host the WASM (they inherit the host
// page CSP), and `WorkerLinter` spins up a blob worker that MV3 forbids — so
// `LocalLinter` in the SW is the only viable placement. It blocks the SW event
// loop while linting, which is acceptable for single-editor-sized text.
//
// The LLM `/correct` + `/rephrase` grammar/tone button path is unaffected;
// this engine only feeds the inline mechanical underline layer.
import {
  LocalLinter,
  createBinaryModuleFromUrl,
  Dialect,
  SuggestionKind,
} from 'harper.js';
import type { Lint } from 'harper.js';
import type { Issue } from '../types';
import { rankByContext, rankSpellByContext, warmContextModel } from './contextRanker';
import { spellSuggestions, warmSpell } from './spellSuggest';

let linterPromise: Promise<LocalLinter> | null = null;

export type HarperDialectName = 'American' | 'British' | 'Australian' | 'Canadian';

const DIALECT_BY_NAME: Record<HarperDialectName, Dialect> = {
  American: Dialect.American,
  British: Dialect.British,
  Australian: Dialect.Australian,
  Canadian: Dialect.Canadian,
};

/**
 * The Harper spelling dialect, from the user's `harperDialect` setting. Defaults
 * to American (the prior hardcoded behaviour) when unset or unreadable. Running
 * the wrong dialect is a large false-positive source: under American, correct
 * British/AU/CA spellings (colour, organise, centre, behaviour) are flagged and
 * routed to quick-fix, silently "Americanizing" correct text.
 */
async function resolveDialect(): Promise<Dialect> {
  try {
    const { harperDialect } = await chrome.storage.sync.get('harperDialect');
    return DIALECT_BY_NAME[harperDialect as HarperDialectName] ?? Dialect.American;
  } catch {
    return Dialect.American;
  }
}

/**
 * Drop the cached linter so the next lint rebuilds it with the current dialect
 * setting. Call this when `harperDialect` changes.
 */
export function invalidateHarperLinter(): void {
  linterPromise = null;
  lintCache.clear();
  lintGeneration++;
}

// Recent results by exact text. The same text is often linted again unchanged
// (refocusing a field, the input + MutationObserver paths, several frames), and a
// lint blocks the service worker that every tab shares. Output depends only on the
// text, the dialect (cleared above) and static models.
const LINT_CACHE_MAX = 8;
const LINT_CACHE_MAX_CHARS = 100_000;
const lintCache = new Map<string, Issue[]>();
let lintGeneration = 0;

// Harper lint config overrides. The word/phrase-level style opt-ins give the
// Grammarly-style "consider rewriting" grey tier for free; the whole-sentence
// readability lints are forced OFF.
//
// CRITICAL: Harper's `Readability` lint (default ON) and `LongSentences`
// SWALLOW the word-level spelling/capitalization fixes inside a long sentence —
// for a single long run-on Harper returns ONLY the "hard to read" lint and
// emits none of the actual typo fixes (verified). That silently breaks inline
// correction on exactly the text people write (forum posts, emails). So we
// disable them; the LLM "sentence review" tier handles readability instead.
// `BoringWords` is also off — it made meaning-changing swaps (very→too,
// several→various) on clean prose (false-positive audit, docs/24 T7).
const STYLE_LINTS_TO_ENABLE: Record<string, boolean> = {
  FillerWords: true,
  RepeatedWords: true,
  DiscourseMarkers: true,
  Readability: false,
  LongSentences: false,
  BoringWords: false,
};

const COMMON_SPELLING_OVERRIDES: Record<string, string> = {
  adress: 'address',
  corect: 'correct',
  hadd: 'had',
  teh: 'the',
};

function applyCommonSpellingOverride(
  original: string,
  suggestion: string,
): string {
  const replacement = COMMON_SPELLING_OVERRIDES[original.toLowerCase()];
  if (!replacement) return suggestion;
  if (suggestion.toLowerCase() === replacement) return suggestion;

  if (original.toUpperCase() === original) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function getLinter(): Promise<LocalLinter> {
  if (!linterPromise) {
    linterPromise = (async () => {
      const wasmUrl = chrome.runtime.getURL('wasm/harper_wasm_bg.wasm');
      const binary = createBinaryModuleFromUrl(wasmUrl);
      const dialect = await resolveDialect();
      const linter = new LocalLinter({ binary, dialect });
      await linter.setup();
      // Merge our opt-ins on top of the defaults rather than replacing the
      // whole config, so future Harper releases that flip more lints on by
      // default still benefit us.
      try {
        const current = await linter.getLintConfig();
        await linter.setLintConfig({ ...current, ...STYLE_LINTS_TO_ENABLE });
      } catch (e) {
        console.warn('[harper] could not enable style lints:', e);
      }
      return linter;
    })();
    // If setup throws, drop the cached promise so a later call can retry.
    linterPromise.catch(() => {
      linterPromise = null;
    });
  }
  return linterPromise;
}

/** Warm the engine ahead of first use (called on install/startup). */
export async function warmHarper(): Promise<void> {
  try {
    await Promise.all([getLinter(), warmContextModel(), warmSpell()]);
    console.log('[harper] local engine ready');
  } catch (e) {
    console.warn('[harper] warm failed:', e);
  }
}

// Harper reports spans as Unicode *code-point* indices. JS strings, DOM ranges,
// and the rest of the extension's position model are all UTF-16. Build a
// code-point → UTF-16 offset lookup for one text so spans land on glyphs.
function buildCpToUtf16(text: string): (cp: number) => number {
  const map: number[] = [];
  let u16 = 0;
  for (const ch of text) {
    map.push(u16);
    u16 += ch.length; // 2 for astral (surrogate pair), else 1
  }
  map.push(u16); // sentinel: code-point count → total UTF-16 length
  const end = u16;
  return (cp: number) => {
    if (cp <= 0) return 0;
    if (cp >= map.length) return end;
    return map[cp];
  };
}

// Map a Harper lint kind to the extension's four-bucket taxonomy. The inline
// highlighter additionally runs `isMechanical()` — only spelling plus
// punctuation/case-style grammar actually paints an underline, so
// over-classifying as "grammar" here is harmless (it gets filtered downstream).
function mapType(kind: string): Issue['type'] {
  const k = kind.toLowerCase();
  if (
    k.includes('spell') ||
    k.includes('typo') ||
    k.includes('eggcorn') ||
    k.includes('malapropism')
  ) {
    return 'spelling';
  }
  if (
    k.includes('capital') ||
    k.includes('punctuation') ||
    k.includes('grammar') ||
    k.includes('agreement') ||
    k.includes('boundary') ||
    k.includes('number') ||
    k.includes('regional')
  ) {
    return 'grammar';
  }
  if (
    k.includes('read') ||
    k.includes('clarity') ||
    k.includes('repetition')
  ) {
    return 'clarity';
  }
  return 'style';
}

/**
 * Lint text with Harper and return issues in the extension's `Issue` shape.
 * Offsets/lengths are UTF-16 (matching `textMap`/DOM). Only lints that carry a
 * concrete, non-no-op suggestion are surfaced — the inline layer is one-click
 * mechanical fixes, so an unactionable lint has no place there. All WASM
 * objects are freed before returning.
 */
export async function harperLint(text: string): Promise<Issue[]> {
  if (!text || !text.trim()) return [];
  const hit = lintCache.get(text);
  if (hit) {
    lintCache.delete(text); // refresh recency
    lintCache.set(text, hit);
    return hit.map((i) => ({ ...i }));
  }
  const gen = lintGeneration;
  const issues = await harperLintUncached(text);
  if (gen === lintGeneration && text.length <= LINT_CACHE_MAX_CHARS) {
    lintCache.set(text, issues.map((i) => ({ ...i })));
    if (lintCache.size > LINT_CACHE_MAX) {
      lintCache.delete(lintCache.keys().next().value as string);
    }
  }
  return issues;
}

async function harperLintUncached(text: string): Promise<Issue[]> {

  const linter = await getLinter();
  const lints: Lint[] = await linter.lint(text, { language: 'plaintext' });
  const cpToU16 = buildCpToUtf16(text);
  const issues: Issue[] = [];

  for (const lint of lints) {
    try {
      if (lint.suggestion_count() === 0) continue;

      const span = lint.span();
      const startU16 = cpToU16(span.start);
      const endU16 = cpToU16(span.end);
      span.free();

      if (endU16 <= startU16) continue;
      const original = text.slice(startU16, endU16);

      const kind = lint.lint_kind();
      const type = mapType(kind);

      const rawSuggs = lint.suggestions();
      const sg = rawSuggs.map((s) => ({ k: s.kind(), t: s.get_replacement_text() }));
      for (const s of rawSuggs) s.free();
      if (sg.length === 0) continue;

      let suggestion: string;
      let reason = lint.message();

      if (type === 'spelling') {
        const harperCands = sg
          .filter((x) => x.k === SuggestionKind.Replace)
          .map((x) => x.t)
          .filter((t) => t && t !== original);
        // Hunspell (nspell) gives a far better candidate pool than Harper for
        // real typos (doublt→doubt, crayz→crazy, where Harper offers
        // double/crays). Use it when available; fall back to Harper's own
        // candidates if the dictionary failed to load or returns nothing.
        const hunspellCands = await spellSuggestions(original);
        const useHunspell = hunspellCands.length > 0;
        const pool = useHunspell ? hunspellCands.slice() : harperCands;
        for (const c of harperCands) {
          if (!pool.some((x) => x.toLowerCase() === c.toLowerCase())) pool.push(c);
        }
        const cands = pool.filter((t) => t && t.toLowerCase() !== original.toLowerCase());
        if (cands.length === 0) continue;
        // Full-score the Hunspell pool by neighbour context; for the Harper-only
        // fallback keep the conservative re-ranker that trusts Harper's order.
        const ranked = useHunspell
          ? await rankSpellByContext(text, startU16, endU16 - startU16, original, cands)
          : await rankByContext(text, startU16, endU16 - startU16, original, cands);
        suggestion = ranked[0];
        const alts = (
          useHunspell
            ? ranked
                .slice(1)
                .filter((c) => hunspellCands.some((h) => h.toLowerCase() === c.toLowerCase()))
            : ranked.slice(1)
        ).slice(0, 5);
        if (useHunspell) {
          reason = `Did you mean to spell \`${original}\` as \`${suggestion}\`?`;
          if (alts.length > 0) reason += ` Other suggestions: ${alts.join(', ')}.`;
        } else if (alts.length > 0) {
          reason = `${reason} Other suggestions: ${alts.join(', ')}.`;
        }
      } else {
        const s0 = sg[0];
        switch (s0.k) {
          case SuggestionKind.Remove:
            suggestion = '';
            break;
          case SuggestionKind.InsertAfter:
            suggestion = original + s0.t;
            break;
          default:
            suggestion = s0.t;
            break;
        }
      }

      const beforeCommonOverride = suggestion;
      suggestion = applyCommonSpellingOverride(original, suggestion);
      if (suggestion !== beforeCommonOverride) {
        reason = `Did you mean to spell \`${original}\` as \`${suggestion}\`?`;
      }

      // Drop no-ops — nothing to one-click apply.
      if (suggestion === original) continue;

      issues.push({
        type,
        original,
        suggestion,
        reason,
        offset: startU16,
        length: endU16 - startU16,
        source: 'rule',
        confidence: 0.95,
      });
    } finally {
      lint.free();
    }
  }

  return issues;
}
