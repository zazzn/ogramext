// Pure, platform-agnostic core of the inline context re-ranker.
//
// NO chrome / DOM / fetch deps — only erasable TypeScript — so the exact same
// scoring logic is shared by the background service worker
// (contextRanker.ts) and the Node regression harness
// (scripts/simulate-inline.mjs). One source of truth → the harness can't
// drift from shipped behaviour.
//
// Harper ranks spelling candidates by isolated word frequency + edit distance
// with no context, so "borwn" in "the quick borwn fox" yields
// ["born","brown","boron"] (born wins). rankCandidates() re-scores with a
// noisy-channel model: contextLogP(c | left,right) + W_CH·channel(typo→c),
// and only overrides Harper on a clear, in-vocabulary context win.

export interface NgramModel {
  V: number;
  idOf: Map<string, number>;
  uni: Float32Array; // ln(count / total)
  bi: Map<number, number>; // key = w1*V + w2 → ln(count(w1,w2)/count(w1))
  floor: number; // ln-prob floor for OOV words
}

export const LN_ALPHA = Math.log(0.4); // stupid-backoff weight
export const W_CH = 0.6; // channel weight (context dominates)
export const MARGIN = 2.0; // nats a challenger must beat Harper's #1 by to win

/** Parse the binary n-gram model (OGN1 layout, see build-ngram-model.mjs). */
export function parseModel(buf: ArrayBuffer): NgramModel {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  if (dec.decode(u8.subarray(0, 4)) !== 'OGN1') throw new Error('bad model magic');
  let o = 4;
  const V = dv.getUint32(o, true);
  o += 4;
  const B = dv.getUint32(o, true);
  o += 4;

  const idOf = new Map();
  for (let i = 0; i < V; i++) {
    const len = dv.getUint8(o);
    o += 1;
    idOf.set(dec.decode(u8.subarray(o, o + len)), i);
    o += len;
  }

  const uni = new Float32Array(V);
  let minUni = Infinity;
  for (let i = 0; i < V; i++) {
    const v = dv.getFloat32(o, true);
    o += 4;
    uni[i] = v;
    if (v < minUni) minUni = v;
  }

  const bi = new Map();
  for (let i = 0; i < B; i++) {
    const w1 = dv.getUint32(o, true);
    o += 4;
    const w2 = dv.getUint32(o, true);
    o += 4;
    const lncond = dv.getFloat32(o, true);
    o += 4;
    bi.set(w1 * V + w2, lncond);
  }

  return { V, idOf, uni, bi, floor: minUni - 5 };
}

function uniLn(m: NgramModel, w: string): number {
  const i = m.idOf.get(w);
  return i === undefined ? m.floor : m.uni[i];
}

/** ln P(w2 | w1) with stupid backoff to a discounted unigram. */
function condLn(m: NgramModel, w1: string, w2: string): number {
  const a = m.idOf.get(w1);
  const b = m.idOf.get(w2);
  if (a !== undefined && b !== undefined) {
    const v = m.bi.get(a * m.V + b);
    if (v !== undefined) return v;
  }
  return LN_ALPHA + uniLn(m, w2);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const sortedChars = (w: string) => [...w.toLowerCase()].sort().join('');

// Channel: how plausible is original→candidate as a typo. A pure
// transposition/anagram (borwn→brown) is one of the most common, cheapest
// real typos, so it gets a positive REWARD — enough to win weak-context ties
// ("a borwn dog") but far too small to overturn strong context
// ("she was born in May", where "born" leads by many nats).
function channel(original: string, cand: string): number {
  const o = original.toLowerCase();
  const c = cand.toLowerCase();
  if (o === c) return -5;
  if (sortedChars(o) === sortedChars(c)) return 1.5;
  const lev = levenshtein(o, c);
  const lenDiff = Math.abs(o.length - c.length);
  return -(0.6 * lev + 0.4 * lenDiff);
}

/**
 * Offline / no-model fallback: promote the first candidate that is an anagram
 * (pure transposition) of the typo above Harper's frequency-first pick, unless
 * Harper already led with one. Used ONLY when the n-gram model is unavailable
 * — never post-applied over a model decision (that would override deliberate
 * context choices, e.g. wrongly forcing "brown" in "she was born").
 */
export function promoteTransposition(original: string, cands: string[]): string[] {
  const out = cands.slice();
  if (out.length <= 1) return out;
  const o = sortedChars(original);
  if (sortedChars(out[0]) === o) return out;
  const i = out.findIndex((c) => sortedChars(c) === o);
  if (i > 0) {
    const [a] = out.splice(i, 1);
    out.unshift(a);
  }
  return out;
}

const WORD = /[a-zA-Z][a-zA-Z'-]*/g;

/** Word immediately before `idx` and immediately after `end` in `text`. */
function neighbours(text: string, idx: number, end: number): [string, string] {
  const before = text.slice(Math.max(0, idx - 64), idx);
  const after = text.slice(end, end + 64);
  const bm = before.match(WORD);
  const am = after.match(WORD);
  return [
    bm ? bm[bm.length - 1].toLowerCase() : '',
    am ? am[0].toLowerCase() : '',
  ];
}

/**
 * Re-rank Harper spelling candidates by neighbour context. `cands` is in
 * Harper's order. Returns a new ordering; Harper's order is preserved unless
 * an in-vocabulary challenger beats Harper's #1 by ≥ MARGIN nats. `m === null`
 * → offline transposition fallback. Pure & synchronous.
 */
export function rankCandidates(
  m: NgramModel | null,
  text: string,
  offset: number,
  length: number,
  original: string,
  cands: string[],
): string[] {
  if (cands.length <= 1) return cands.slice();
  if (!m) return promoteTransposition(original, cands);

  // Harper's #1 must be scoreable for a fair comparison. If it's out of
  // vocabulary (e.g. contractions like "don't" — apostrophe forms aren't in
  // the corpus), we have no basis to override Harper; trust its order. This
  // is the guard that stops "i dont know" → "don".
  if (!m.idOf.has(cands[0].toLowerCase())) return cands.slice();

  const [left, right] = neighbours(text, offset, offset + length);

  const score = (c: string): number => {
    const w = c.toLowerCase();
    let ctx = 0;
    let parts = 0;
    if (left) {
      ctx += condLn(m, left, w);
      parts++;
    }
    if (right) {
      ctx += condLn(m, w, right);
      parts++;
    }
    if (parts === 0) ctx = uniLn(m, w);
    return ctx + W_CH * channel(original, c);
  };

  const scored = cands.map((c, i) => ({ c, i, s: score(c) }));
  let best = scored[0];
  for (const e of scored) if (e.s > best.s) best = e;

  // Conservative gate: only override Harper's #1 on a clear context win by
  // an in-vocabulary challenger (an OOV winner only has floor/backoff
  // evidence — not enough to overrule Harper).
  if (
    best.i === 0 ||
    best.s - scored[0].s < MARGIN ||
    !m.idOf.has(best.c.toLowerCase())
  ) {
    return cands.slice();
  }

  const out = cands.slice();
  const [w] = out.splice(best.i, 1);
  out.unshift(w);
  return out;
}

// ── spell-pool channel (rankSpellCandidates) ──
// Tuned on 1,500 real typos in real sentences (scripts/tune-spell-rank.mjs):
// score = context − SPELL_W · typoCost, where typoCost is an edit distance in
// which a swap of two adjacent letters is ONE edit and the commonest slips cost
// half an edit. Right-first 66.7% → 74.1% with the 40-word ED1+ED2 pool.
// Keyboard-neighbour and first-letter costs were measured too and gave no
// reliable held-out gain, so they are left out. Mirrors context.rs exactly.
export const SPELL_W = 5; // nats per edit
export const SLIP_COST = 0.5; // transposition, vowel↔vowel, dropped/extra double letter
const VOWELS = 'aeiouy';

/**
 * Weighted restricted-Damerau (OSA) distance from the typo `a` to the
 * candidate `b`, both lowercase. Cheap edits (SLIP_COST): adjacent
 * transposition; substituting one vowel for another; deleting a letter the
 * typo doubled (untill→until); inserting a letter the word doubles
 * (ocasion→occasion). Everything else costs 1.
 */
export function typoCost(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const del = (i: number) => // drop a[i-1]
    (i > 1 && a[i - 1] === a[i - 2]) || (i < m && a[i - 1] === a[i]) ? SLIP_COST : 1;
  const ins = (j: number) => // add b[j-1]
    (j > 1 && b[j - 1] === b[j - 2]) || (j < n && b[j - 1] === b[j]) ? SLIP_COST : 1;
  const sub = (x: string, y: string) =>
    x === y ? 0 : VOWELS.includes(x) && VOWELS.includes(y) ? SLIP_COST : 1;
  const d: number[][] = [];
  for (let i = 0; i <= m; i++) d.push(new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) d[i][0] = d[i - 1][0] + del(i);
  for (let j = 1; j <= n; j++) d[0][j] = d[0][j - 1] + ins(j);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      let v = Math.min(d[i - 1][j] + del(i), d[i][j - 1] + ins(j), d[i - 1][j - 1] + sub(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== a[i - 2]) {
        v = Math.min(v, d[i - 2][j - 2] + SLIP_COST);
      }
      d[i][j] = v;
    }
  }
  return d[m][n];
}

/**
 * Rank an arbitrary candidate pool (e.g. from a Hunspell/SymSpell suggester) by
 * the same neighbour-aware noisy-channel score used above, returning ALL
 * candidates sorted best-first. Unlike `rankCandidates` — which conservatively
 * trusts Harper's frequency-first order and only overrides on a big margin —
 * this assumes the pool has no meaningful prior order (Hunspell's ranking is
 * opaque/weak), so it scores every candidate by context + channel and sorts.
 * Score = context − SPELL_W·typoCost (see typoCost). `m === null` → sort by
 * typoCost alone (most plausible slip first). Pure & synchronous.
 */
export function rankSpellCandidates(
  m: NgramModel | null,
  text: string,
  offset: number,
  length: number,
  original: string,
  cands: string[],
): string[] {
  if (cands.length <= 1) return cands.slice();
  const typo = original.toLowerCase();
  if (!m) {
    return cands
      .map((c) => ({ c, d: typoCost(typo, c.toLowerCase()) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.c);
  }
  const [left, right] = neighbours(text, offset, offset + length);
  const score = (c: string): number => {
    const w = c.toLowerCase();
    let ctx = 0;
    let parts = 0;
    if (left) {
      ctx += condLn(m, left, w);
      parts++;
    }
    if (right) {
      ctx += condLn(m, w, right);
      parts++;
    }
    if (parts === 0) ctx = uniLn(m, w);
    return ctx - SPELL_W * typoCost(typo, w);
  };
  return cands
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}
