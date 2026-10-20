/**
 * Shared text + position map.
 *
 * THE bug this solves: previously the extension sent `element.innerText` to the
 * backend (whitespace-collapsed, \n-injected, hidden nodes skipped) but mapped
 * the returned offsets back to the DOM by summing `textContent` (raw node text).
 * Those are different coordinate spaces, so offsets drifted and corrupted text
 * ("haven't" -> "hahavent"). Fix: ONE traversal produces BOTH the plain text we
 * analyze AND the offset<->DOM map, so they can never disagree.
 *
 * Design choice: we do NOT collapse whitespace inside text nodes. That keeps the
 * char<->node mapping perfectly linear (offset - segment.textStart === index into
 * node.data). We only synthesize "\n" for <br> and block boundaries, and skip
 * hidden subtrees. The exact string differs slightly from innerText, but that is
 * irrelevant — the only requirement is that extraction and mapping are identical,
 * which is guaranteed because both come from this function.
 */

export interface PosSegment {
  textStart: number;
  textEnd: number;
  /** null for synthetic separators (<br>, block boundaries) that back no node */
  node: Text | null;
}

export interface TextMap {
  text: string;
  segments: PosSegment[];
  root: HTMLElement;
}

const BLOCK_DISPLAYS = new Set([
  'block',
  'flex',
  'grid',
  'list-item',
  'table',
  'table-row',
  'table-cell',
  'flow-root',
]);

function isHidden(el: Element): boolean {
  const s = window.getComputedStyle(el);
  return s.display === 'none' || s.visibility === 'hidden';
}

function isBlock(el: Element): boolean {
  const d = window.getComputedStyle(el).display;
  return BLOCK_DISPLAYS.has(d) || /^table/.test(d);
}

/**
 * Build the plain text and segment map for a contenteditable root.
 */
export function buildTextMap(root: HTMLElement): TextMap {
  const segments: PosSegment[] = [];
  let text = '';

  const pushSep = () => {
    if (text.length && !text.endsWith('\n')) {
      segments.push({ textStart: text.length, textEnd: text.length + 1, node: null });
      text += '\n';
    }
  };

  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child as Text;
        const raw = t.data;
        if (raw.length === 0) continue;
        segments.push({ textStart: text.length, textEnd: text.length + raw.length, node: t });
        text += raw;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (isHidden(el)) continue;
        if (el.tagName === 'BR') {
          segments.push({ textStart: text.length, textEnd: text.length + 1, node: null });
          text += '\n';
          continue;
        }
        const block = isBlock(el);
        if (block) pushSep();
        walk(el);
        if (block) pushSep();
      }
    }
  };

  walk(root);
  return { text, segments, root };
}

/** Locate the segment + in-node offset for a given text index. */
function locate(
  map: TextMap,
  index: number,
  preferEnd: boolean,
): { node: Text; offset: number } | null {
  const segs = map.segments;
  const endBefore = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const s = segs[j]!;
      if (s.node) return { node: s.node, offset: s.node.data.length };
    }
    return null;
  };
  const startAfter = (i: number) => {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[j]!;
      if (s.node) return { node: s.node, offset: 0 };
    }
    return null;
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const within = preferEnd
      ? index > seg.textStart && index <= seg.textEnd
      : index >= seg.textStart && index < seg.textEnd;
    if (within) {
      if (seg.node) return { node: seg.node, offset: index - seg.textStart };
      // Synthetic separator: snap to the nearest real node boundary on the preferred
      // side — or the other side when there's nothing there (e.g. the end of the last
      // paragraph, which sits on the trailing block separator).
      return preferEnd ? (endBefore(i) ?? startAfter(i)) : (startAfter(i) ?? endBefore(i));
    }
  }
  // index === total length → end of last real node
  if (index >= map.text.length) {
    for (let j = segs.length - 1; j >= 0; j--) {
      const s = segs[j]!;
      if (s.node) return { node: s.node, offset: s.node.data.length };
    }
  }
  return null;
}

/**
 * Resolve a [start, end) plain-text span to a live DOM Range.
 * Returns null if the span can't be mapped (e.g. DOM changed).
 */
export function offsetToRange(map: TextMap, start: number, end: number): Range | null {
  const a = locate(map, start, false);
  const b = locate(map, end, true);
  if (!a || !b) return null;
  try {
    const range = document.createRange();
    range.setStart(a.node, Math.min(a.offset, a.node.data.length));
    range.setEnd(b.node, Math.min(b.offset, b.node.data.length));
    return range;
  } catch {
    return null;
  }
}

/**
 * The inverse of `offsetToRange`: the text offset of a DOM boundary point (e.g. the
 * caret, `selection.focusNode/focusOffset`), in the SAME coordinates as `map.text`.
 * `Range.toString()` can't be used for this — it omits the "\n" this map adds for
 * <br> and block boundaries, so every line break before the caret would shift it.
 */
export function pointToOffset(map: TextMap, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const seg = map.segments.find((s) => s.node === container);
    if (seg) return seg.textStart + Math.min(offset, seg.textEnd - seg.textStart);
  }
  // Element boundary: the point sits after every mapped text node that starts before it.
  const point = document.createRange();
  try {
    point.setStart(container, offset);
  } catch {
    return map.text.length;
  }
  let pos = 0;
  for (const seg of map.segments) {
    if (!seg.node) continue;
    if (point.comparePoint(seg.node, 0) >= 0) break;
    pos = seg.textEnd;
  }
  return pos;
}

/**
 * Validate that the text currently at [offset, offset+length) still equals the
 * issue's original text. If the user edited since analysis, try a local re-find
 * within a small window so a still-present error is relocated rather than
 * applied to the wrong place. Returns the corrected [start,end) or null to drop.
 */
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRe(s: string): string {
  return s.replace(RE_SPECIAL, '\\$&');
}

/**
 * Last-resort match for `original` in `text`, tolerant of the differences a live
 * editor introduces vs the analyzed snapshot: inter-word WHITESPACE (a long sentence
 * wraps across nodes → newlines / NBSP / double spaces) and QUOTE GLYPHS (composers
 * smart-quote ' " into ' ' " "). Builds a flexible regex over the word tokens and
 * returns the match nearest the expected `offset` (disambiguates repeats). Returns the
 * RAW [start,end) so the caller replaces exactly what's live in the field.
 */
function flexibleMatch(
  text: string,
  original: string,
  near: number,
): { start: number; end: number } | null {
  const trimmed = original.trim();
  if (!trimmed) return null;
  const APOS = "['‘’ʼ]";
  const QUOTE = '["“”]';
  const pattern = trimmed
    .split(/\s+/)
    .map((tok) =>
      escapeRe(tok)
        .replace(/['‘’ʼ]/g, APOS)
        .replace(/["“”]/g, QUOTE),
    )
    .join('\\s+');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return null;
  }
  let m: RegExpExecArray | null;
  let best: { start: number; end: number } | null = null;
  let bestDist = Infinity;
  while ((m = re.exec(text)) !== null) {
    const dist = Math.abs(m.index - near);
    if (dist < bestDist) {
      bestDist = dist;
      best = { start: m.index, end: m.index + m[0].length };
    }
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width loops
  }
  return best;
}

export function resolveInString(
  text: string,
  offset: number,
  length: number,
  original: string,
): { start: number; end: number } | null {
  if (text.slice(offset, offset + length) === original) {
    return { start: offset, end: offset + length };
  }
  if (!original) return null;
  // Windowed exact search. The window SCALES with the original length so a long
  // sentence can still be relocated after offset drift — a fixed ±40 is smaller than
  // most sentences and could never re-find one (the "text changed" on a valid rewrite).
  const WINDOW = Math.max(40, original.length + 40);
  const from = Math.max(0, offset - WINDOW);
  const to = Math.min(text.length, offset + length + WINDOW);
  const hay = text.slice(from, to);
  const first = hay.indexOf(original);
  if (first !== -1 && hay.indexOf(original, first + 1) === -1) {
    const start = from + first;
    return { start, end: start + original.length };
  }
  // Exact search failed or was ambiguous: fall back to a whitespace/quote-tolerant
  // match near the expected offset (handles editors that reflow whitespace or
  // smart-quote apostrophes — the usual cause of a failed sentence apply).
  return flexibleMatch(text, original, offset);
}

export function resolveSpan(
  map: TextMap,
  offset: number,
  length: number,
  original: string,
): { start: number; end: number } | null {
  return resolveInString(map.text, offset, length, original);
}
