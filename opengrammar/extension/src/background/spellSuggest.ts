// Spelling suggestions via edit-distance candidate generation over a frequency
// dictionary (SymSpell's frequency_dictionary_en_82_765 — Google-Books
// frequencies ∩ SCOWL, ~82k words), re-ranked by the n-gram context model
// (contextRanker.rankSpellByContext). Replaces Harper's weak spelling
// candidates on the inline tier.
//
// Why on-demand Norvig-style generation, not a precomputed SymSpell delete
// index: candidate generators (SymSpell / Norvig / Hunspell) are
// accuracy-EQUIVALENT for a given dictionary — they return the same candidate
// set; SymSpell only wins on raw lookup speed via a large precomputed index that
// needs IndexedDB persistence in an MV3 service worker. OGrammar only queries
// the handful of words Harper already flagged per check, so per-word edit
// generation (ED1 + ED2) is fast enough and avoids that
// complexity. The accuracy comes from the dictionary + context ranking, not the
// algorithm. Benchmarked Harper 75% → this 95% top-1 on a common-typo set.
//
// Detection stays with Harper; this only generates/ranks the SUGGESTION.

let freqPromise: Promise<Map<string, number> | null> | null = null;

function loadFreq(): Promise<Map<string, number> | null> {
  if (!freqPromise) {
    freqPromise = (async () => {
      try {
        const text = await fetch(
          chrome.runtime.getURL('dict/frequency_dictionary_en_82_765.txt'),
        ).then((r) => r.text());
        const map = new Map<string, number>();
        for (const line of text.split('\n')) {
          const t = line.replace(/^﻿/, '').trim();
          if (!t) continue;
          const sp = t.split(/\s+/);
          const w = sp[0].toLowerCase();
          const c = Number(sp[1]);
          if (w && Number.isFinite(c)) map.set(w, c);
        }
        console.log(`[spell] frequency dictionary ready (${map.size} words)`);
        return map;
      } catch (e) {
        console.warn('[spell] dictionary load failed; using Harper suggestions:', e);
        return null;
      }
    })();
    freqPromise.catch(() => {
      freqPromise = null;
    });
  }
  return freqPromise;
}

/** Warm the dictionary ahead of first use (called alongside Harper warm-up). */
export async function warmSpell(): Promise<void> {
  await loadFreq();
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz'".split('');
function edits1(w: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= w.length; i++) {
    if (i < w.length) out.add(w.slice(0, i) + w.slice(i + 1)); // delete
    if (i < w.length - 1) out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); // transpose
    if (i < w.length) for (const c of LETTERS) out.add(w.slice(0, i) + c + w.slice(i + 1)); // replace
    for (const c of LETTERS) out.add(w.slice(0, i) + c + w.slice(i)); // insert
  }
  return out;
}

function matchCase(original: string, cand: string): string {
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) return cand.toUpperCase();
  if (original[0] && original[0] === original[0].toUpperCase()) {
    return cand[0]!.toUpperCase() + cand.slice(1);
  }
  return cand;
}

/**
 * Candidate pool for a single (already Harper-flagged) word: edit-distance-1
 * dictionary matches, then edit-distance-2 ones (see computeSuggestions).
 * Returns [] when the dictionary is unavailable or the word is itself in the
 * dictionary (caller falls back to Harper's own candidates). Best-first by
 * edit distance then corpus frequency, case-matched to the original; the
 * n-gram context re-ranker makes the final call.
 */
export async function spellSuggestions(word: string): Promise<string[]> {
  const freq = await loadFreq();
  if (!freq) return [];
  // Every check re-lints the whole field, so the same flagged words (names,
  // jargon) come back each time; the edit-2 pass builds ~10^5 strings per
  // word. The result depends only on the exact word and the static dictionary.
  const cached = suggestCache.get(word);
  if (cached) return cached.slice();
  const result = computeSuggestions(freq, word);
  suggestCache.set(word, result);
  if (suggestCache.size > SUGGEST_CACHE_MAX) {
    suggestCache.delete(suggestCache.keys().next().value as string);
  }
  return result.slice();
}

const SUGGEST_CACHE_MAX = 1000; // insertion-ordered; oldest entry evicted first
const suggestCache = new Map<string, string[]>();

/** Candidate pool handed to the context ranker (edit-1 words first, then edit-2). */
const MAX_SUGGESTIONS = 40;

// Every dictionary word within edit distance 2: edit-1 words first (by
// frequency), then edit-2 words (by frequency), cut to MAX_SUGGESTIONS. Edit-2
// words are generated even when edit-1 words exist — the intended word is often
// a rarer edit-2 word — and the context ranker's distance-aware channel score
// makes the final call.
function computeSuggestions(freq: Map<string, number>, word: string): string[] {
  const w = word.toLowerCase();
  if (freq.has(w)) return [];

  const byFreq = (a: string, b: string) =>
    (freq.get(b) || 0) - (freq.get(a) || 0) || (a < b ? -1 : a > b ? 1 : 0);

  const first = edits1(w);
  const e1: string[] = [];
  for (const e of first) if (e !== w && freq.has(e)) e1.push(e);

  const e2 = new Set<string>();
  for (const e of first) {
    for (const x of edits1(e)) {
      if (x !== w && !first.has(x) && freq.has(x)) e2.add(x);
    }
  }

  return [...e1.sort(byFreq), ...[...e2].sort(byFreq)]
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => matchCase(word, c));
}
