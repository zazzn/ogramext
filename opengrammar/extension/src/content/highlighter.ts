import type { IgnoredIssue, Issue } from '../types';
import { buildTextMap, offsetToRange, resolveInString, resolveSpan } from './textMap';
import {
  diffWords,
  renderCorrectedWithChangesHTML,
  renderInlineDiffHTML,
  renderOriginalWithChangesHTML,
  summarizeChange,
} from './diff';
import { applyFix } from './editorAdapter';
import { stripQuotedBBCode } from './textExtractor';
import { getApiKey } from '../shared/apiKeyStore';
import { findProtectedSpans, type ProtectedSpan } from '../shared/protectedText';
import prompts from '../shared/prompts.json';

/** The tone choices, in menu order — the same list the desktop + mobile apps show. */
const TONES: [string, string][] = prompts.rewrite.tones.map((t) => [t.id, t.label]);

let currentTooltip: HTMLElement | null = null;
let currentRephrasePanel: HTMLElement | null = null;
let highlightContainer: HTMLElement | null = null;
let assistantBubble: HTMLElement | null = null;
let assistantBubbleIssues: Issue[] = [];
// Contenteditable overlay state — so scroll/resize can re-place underlines
let overlayTarget: HTMLElement | null = null;
let overlayIssues: Issue[] = [];
// Field the floating bubble is anchored to (tracked on scroll/resize)
let assistantTarget: HTMLElement | null = null;
// Selection-rewrite bubble: shown only while there is a non-empty text
// selection inside an editable field, so a clean (no-error) section can
// still be sent for an AI tone rewrite. Separate from the issue bubble.
let selectionBubble: HTMLElement | null = null;
let selectionTarget: HTMLElement | null = null;
let selectionText = '';
let selectionApproxOffset = 0;
let currentSpellMenu: HTMLElement | null = null;
// Cache LLM whole-text corrections by (quote-stripped) source text so
// reopening / navigating the review panel doesn't refetch.
const correctionCache = new Map<string, string>();

const BUBBLE_SIZE = 30; // px — small, fits inside the field corner
const COMPACT_BUBBLE_SIZE = 24;
const MIN_FIELD_HEIGHT = 38; // skip tiny inputs (matches Grammarly)
const MODEL_BENCHMARK_URL = 'https://github.com/zazzn/ogramext/blob/og-rewrite/docs/25-local-llm-model-benchmark.md';
let modelHintShownThisSession = false;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

function isCompactEditor(element: HTMLElement, r = element.getBoundingClientRect()): boolean {
  return element.tagName === 'INPUT' || r.height < 72 || r.width < 280;
}

function placeBubble(
  bubble: HTMLElement,
  target: HTMLElement,
  slot: 0 | 1,
) {
  const r = target.getBoundingClientRect();
  // Prose fields (contenteditable / textarea) are legitimately short sometimes —
  // YouTube / Twitter / forum comment boxes are ~20px. Only apply the tall-field
  // gate to <input> (search bars etc.), where a bubble would just be noise.
  const minHeight = target.tagName === 'INPUT' ? MIN_FIELD_HEIGHT : 20;
  if (r.height < minHeight || r.width === 0) {
    bubble.style.display = 'none';
    return;
  }

  const compact = isCompactEditor(target, r);
  const size = compact ? COMPACT_BUBBLE_SIZE : BUBBLE_SIZE;
  const gap = compact ? 6 : 8;
  const margin = 8;
  let left: number;
  let top: number;

  bubble.style.display = 'inline-flex';
  bubble.style.width = `${size}px`;
  bubble.style.height = `${size}px`;

  if (compact) {
    left = r.right + gap;
    top = r.top + r.height / 2 - size / 2 - slot * (size + gap);

    if (left + size > window.innerWidth - margin) {
      if (r.left - size - gap >= margin) {
        left = r.left - size - gap;
      } else {
        left = r.right - size;
        top = r.top - size - gap - slot * (size + gap);
      }
    }
  } else {
    const inset = 6;
    left = r.right - size - inset;
    top = r.bottom - size - inset - slot * (size + gap);
  }

  bubble.style.left = `${Math.round(clamp(left, margin, window.innerWidth - size - margin))}px`;
  bubble.style.top = `${Math.round(clamp(top, margin, window.innerHeight - size - margin))}px`;
}

/** Anchor the bubble to the target field without covering compact inputs. */
function positionAssistantBubble() {
  if (!assistantBubble || !assistantTarget || !assistantTarget.isConnected) return;
  placeBubble(assistantBubble, assistantTarget, 0);
}

/** Anchor the selection bubble just above the issue-bubble corner so the
 *  two never overlap. */
function positionSelectionBubble() {
  if (!selectionBubble || !selectionTarget || !selectionTarget.isConnected) return;
  placeBubble(selectionBubble, selectionTarget, 1);
}
let inputMirrorOverlay: HTMLElement | null = null;
let inputMirrorContent: HTMLElement | null = null;
let inputMirrorTarget: HTMLElement | null = null;
let cleanupInputMirror: (() => void) | null = null;
let uiActive = false;

type RectLike = { left: number; top: number; width: number; height: number };
type DecorationUpdateKind = 'reposition' | 'rebuild';

let underlineRects: Array<{ el: HTMLElement; base: RectLike }> = [];
let underlineBaseTargetRect: RectLike | null = null;
let underlineBaseText = '';
let underlineBaseScrollLeft = 0;
let underlineBaseScrollTop = 0;
let underlinesAreVisible = true;
let decorationRaf = 0;
let pendingDecorationUpdate: DecorationUpdateKind | null = null;
let decorationResizeObserver: ResizeObserver | null = null;
let decorationIntersectionObserver: IntersectionObserver | null = null;
let decorationPollInterval: number | null = null;
let observedDecorationTarget: HTMLElement | null = null;
let observedTargetIntersects = true;
let fontReadyToken = 0;

export function isUIActive(): boolean {
  return uiActive;
}

/* ────────────────────────────────────────────────────────────
   GRAMMARLY COLOR SYSTEM — exact hex values from Grammarly
──────────────────────────────────────────────────────────── */
// Visual tiers (matches the QA legend "local mechanical = red" and the user's
// ask "red for misspelled, red for punctuation/capitalization"):
//   - Red (spelling + grammar) = Correctness, must-fix mechanical errors
//   - Grey (clarity/style)     = consider rewriting, suggestion only
//   - Blue (LLM/context)       = AI review (set in getUnderlineStyle, not here)
// Spelling and grammar share Correctness red (Grammarly's actual convention).
// Grey is darkened from #8e8e93 → #6b7280 so the dotted style line isn't too
// faint to notice on white backgrounds.
const COLORS = {
  spelling: { line: '#e53935', bg: 'rgba(229,57,53,0.10)',  hover: 'rgba(229,57,53,0.20)',  dot: '#e53935' },
  grammar:  { line: '#e53935', bg: 'rgba(229,57,53,0.10)',  hover: 'rgba(229,57,53,0.20)',  dot: '#e53935' },
  clarity:  { line: '#6b7280', bg: 'rgba(107,114,128,0.12)', hover: 'rgba(107,114,128,0.24)', dot: '#6b7280' },
  style:    { line: '#6b7280', bg: 'rgba(107,114,128,0.12)', hover: 'rgba(107,114,128,0.24)', dot: '#6b7280' },
};

function getC(type: string) {
  return COLORS[type as keyof typeof COLORS] ?? COLORS.grammar;
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'grammar':  return 'Grammar';
    case 'spelling': return 'Spelling';
    case 'clarity':  return 'Clarity';
    case 'style':    return 'Style';
    default:         return 'Suggestion';
  }
}

function getCategoryLabel(type: string): string {
  return type === 'grammar' || type === 'spelling' ? 'Correctness' : 'Clarity & Style';
}

function escapeHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}


/* ────────────────────────────────────────────────────────────
   HIGHLIGHT OVERLAY
──────────────────────────────────────────────────────────── */
function initHighlightContainer() {
  if (!highlightContainer) {
    highlightContainer = document.createElement('div');
    highlightContainer.id = 'opengrammar-highlights';
    highlightContainer.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; z-index: 2147483647;
    `;
    document.body.appendChild(highlightContainer);
  }
}

/**
 * Inline layer = MECHANICAL fixes only: spelling, plus the small/local
 * grammar fixes that are deterministic (punctuation, capitalization,
 * apostrophes, a/an, doubled words, single short-token swaps). Anything
 * clause-level (real grammar, clarity, style) is NOT underlined — it is
 * reachable only via the Grammar/Tone (AI review) button.
 */
function isMechanical(i: Issue): boolean {
  if (i.ignored) return false;
  if (i.route === 'suppress' || i.route === 'sentence-review') return false;
  if (i.route === 'quick-fix') return true;
  if (i.type === 'spelling') return true;
  // Rewrite-tier (Grammarly-grey): clarity + style suggestions from local
  // Harper lints (PhraseSetCorrections, BoringWords, FillerWords, …). Allow
  // any phrase-bounded suggestion through; the length cap keeps a runaway
  // whole-clause lint from painting half a line grey.
  if (i.type === 'clarity' || i.type === 'style') {
    const o = (i.original || '').trim();
    const s = (i.suggestion || '').trim();
    return !!s && o !== s && o.length <= 80;
  }
  const o = (i.original || '').trim();
  const s = (i.suggestion || '').trim();
  if (!s || o === s) return false;
  const bare = (x: string) => x.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (bare(o) === bare(s)) return true; // only punctuation / case / spacing
  if (!/\s/.test(o) && !/\s/.test(s) && o.length <= 14 && s.length <= 18) return true;
  const ops = diffWords(o, s).filter((op) => op.kind !== 'eq');
  const changed = ops.map((op) => op.text).join('');
  return ops.length <= 2 && changed.length <= 14;
}

/**
 * Inline REVIEW layer = the conservative route. issuePolicy sends borderline
 * grammar fixes here, and every proactive LLM/context correction lands here
 * too (loose/lose, their/there). These are NOT auto-applied: they get a
 * visually DISTINCT (dotted) underline that opens a preview card so the user
 * notices the issue even when the local mechanical tier is silent — and decides
 * before any text changes. This is the fix for "issues found but nothing is
 * highlighted, so the user assumes the text is clean".
 */
function isInlineReview(i: Issue): boolean {
  if (i.ignored) return false;
  if (i.route !== 'sentence-review') return false;
  const o = (i.original || '').trim();
  const s = (i.suggestion || '').trim();
  // Needs a concrete span + a concrete single replacement to underline+preview.
  // Cap BOTH sides so a whole-sentence rewrite (which belongs in the sentence
  // review panel, not an inline word underline) doesn't paint half a line.
  return !!o && !!s && o !== s && o.length <= 120 && s.length <= 120;
}

/** Context/AI suggestions (vs local rule output) — drives the blue "AI" tint. */
function isLlmIssue(i: Issue): boolean {
  return i.source === 'llm' || i.source === 'context';
}

/** Anything that earns an inline underline: mechanical quick-fixes OR the
 *  distinct review layer. (isMechanical already excludes sentence-review.) */
function isUnderlinable(i: Issue): boolean {
  return isMechanical(i) || isInlineReview(i);
}

/**
 * Visual language for a single underline:
 *   - mechanical quick-fix → STRAIGHT line, type color (red/amber/grey)
 *   - local sentence-review → DOTTED line, type color
 *   - LLM / context review  → DOTTED line, blue (matches the QA legend's
 *     "LLM/context" swatch; clearly "AI suggestion, click to review")
 * Chrome's native squiggle is already suppressed (spellcheck="false"), so the
 * only collision left to resolve is local-vs-review, which dotted-vs-straight
 * and red-vs-blue handle.
 */
const REVIEW_LLM_LINE = '#3D7DCA';
function getUnderlineStyle(issue: Issue): { line: string; dashed: boolean } {
  if (isInlineReview(issue)) {
    return { line: isLlmIssue(issue) ? REVIEW_LLM_LINE : getC(issue.type).line, dashed: true };
  }
  return { line: getC(issue.type).line, dashed: false };
}

export function highlightIssues(element: HTMLElement, issues: Issue[]) {
  initHighlightContainer();
  clearHighlights();

  // ONE indicator: the AI Grammar/Tone review button (opens the LLM whole-text
  // review). Keep it visible even when the local rule engine found zero issues:
  // context-only errors such as "My" mid-sentence or groves/grooves need the
  // sentence-level model, so no underline would otherwise mean no discoverable
  // path to the correction.
  showAssistantBubble(element, issues || []);

  // Two visual tiers share one overlay: mechanical quick-fixes (straight) and
  // the review layer (dotted) — so a sentence-review/LLM issue is no longer
  // invisible just because it isn't a one-click destructive fix.
  const underlinable = (issues || []).filter(isUnderlinable);
  if (underlinable.length === 0) {
    overlayTarget = null;
    overlayIssues = [];
    return;
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    renderInputUnderlines(element, underlinable);
  } else {
    // Contenteditable: overlay only — never mutate/recolor the host DOM.
    renderOverlayUnderlines(element, underlinable);
  }
}

function getFieldTextSnapshot(element: HTMLElement): string {
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    return String((element as HTMLInputElement | HTMLTextAreaElement).value ?? '');
  }
  return element.innerText || element.textContent || '';
}

function getScrollSnapshot(element: HTMLElement): { left: number; top: number } {
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    return { left: input.scrollLeft, top: input.scrollTop };
  }
  return { left: 0, top: 0 };
}

function cacheUnderlineBase(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const scroll = getScrollSnapshot(element);
  underlineBaseTargetRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  underlineBaseText = getFieldTextSnapshot(element);
  underlineBaseScrollLeft = scroll.left;
  underlineBaseScrollTop = scroll.top;
  underlinesAreVisible = true;
}

function appendUnderline(
  rect: RectLike,
  fs: number,
  style: { line: string; dashed: boolean },
  issue: Issue,
  element: HTMLElement,
) {
  if (!highlightContainer) return;
  const underline = makeUnderlineDiv(rect, fs, style, issue, element);
  highlightContainer.appendChild(underline);
  underlineRects.push({
    el: underline,
    base: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  });
}

function clearOverlayUnderlines() {
  highlightContainer
    ?.querySelectorAll('.opengrammar-underline')
    .forEach((e) => e.remove());
  underlineRects = [];
  underlineBaseTargetRect = null;
  underlineBaseText = '';
  underlineBaseScrollLeft = 0;
  underlineBaseScrollTop = 0;
  underlinesAreVisible = true;
}

/**
 * Build one positioned underline from a viewport-space rect. Shared by the
 * contenteditable (Range) and input/textarea (measurement-mirror) paths so
 * both look and behave identically. Outer div is a transparent hit area over
 * the word; the straight local line is anchored just under the glyphs (not the
 * bottom of a tall line-box).
 */
function makeUnderlineDiv(
  r: { left: number; top: number; width: number; height: number },
  fs: number,
  style: { line: string; dashed: boolean },
  issue: Issue,
  element: HTMLElement,
): HTMLElement {
  const leadBelow = Math.max(0, Math.round((r.height - fs * 1.15) / 2));
  const u = document.createElement('div');
  u.className = 'opengrammar-underline';
  u.style.cssText = `
    position: fixed;
    left: ${r.left}px;
    top: ${Math.round(r.top)}px;
    width: ${r.width}px;
    height: ${Math.round(r.height)}px;
    pointer-events: auto;
    cursor: pointer;
    z-index: 2147483646;
  `;
  const wave = document.createElement('div');
  if (style.dashed) {
    // Review/AI layer: a DOTTED line (visually distinct from the straight
    // mechanical line and from Chrome's wavy squiggle). 2px dotted reads as
    // "suggestion — click to review" rather than "fix this now".
    wave.style.cssText = `
      position: absolute; left: 0; width: 100%; height: 0;
      bottom: ${leadBelow}px;
      border-bottom: 2px dotted ${style.line};
      pointer-events: none;
    `;
  } else {
    // Mechanical quick-fix: solid straight line.
    wave.style.cssText = `
      position: absolute; left: 0; width: 100%; height: 2px;
      bottom: ${leadBelow}px;
      background: ${style.line};
      border-radius: 999px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.65);
      pointer-events: none;
    `;
  }
  u.appendChild(wave);
  u.title = issue.reason || '';
  u.addEventListener('mousedown', (e) => e.preventDefault());
  if (isInlineReview(issue)) {
    // Review layer (local sentence-review OR LLM/context): open a preview card.
    // NEVER a one-click destructive replace — the user reviews, then Accepts.
    const open = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      showInlineReviewCard(u, issue, element);
    };
    u.addEventListener('click', open);
    u.addEventListener('contextmenu', open);
  } else if (issue.type === 'spelling') {
    const open = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      showSpellingMenu(u, issue, element);
    };
    u.addEventListener('click', open);
    u.addEventListener('contextmenu', open);
  } else {
    // Mechanical grammar (punctuation/caps/apostrophe): one-issue card.
    u.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      showTooltip(u, issue, element);
    });
  }
  return u;
}

/** Contenteditable: draw mechanical underlines from live Ranges. */
function renderOverlayUnderlines(element: HTMLElement, issues: Issue[]) {
  initHighlightContainer();
  clearOverlayUnderlines();
  overlayTarget = element;
  overlayIssues = issues;
  if (!highlightContainer) return;
  const map = buildTextMap(element);
  for (const issue of issues) {
    if (issue.ignored) continue;
    const span = resolveSpan(map, issue.offset, issue.length, issue.original);
    if (!span) continue;
    const range = offsetToRange(map, span.start, span.end);
    if (!range) continue;
    const cEl =
      (range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement) || element;
    const fs = parseFloat(getComputedStyle(cEl).fontSize) || 16;
    const st = getUnderlineStyle(issue);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 || r.height === 0) continue;
      appendUnderline(r, fs, st, issue, element);
    }
  }
  cacheUnderlineBase(element);
}

/**
 * Input/textarea: measure issue rects with a HIDDEN style-cloned mirror
 * (visibility:hidden retains layout) and draw the same overlay squiggles.
 * The real field is NEVER recolored or hidden — fixes the "text invisible
 * for several seconds" bug.
 */
function renderInputUnderlines(element: HTMLElement, issues: Issue[]) {
  initHighlightContainer();
  clearOverlayUnderlines();
  destroyInputMirror();
  overlayTarget = element;
  overlayIssues = issues;
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  inputMirrorTarget = element;

  const overlay = document.createElement('div');
  overlay.className = 'opengrammar-input-mirror';
  overlay.style.cssText = `
    position: fixed; visibility: hidden; pointer-events: none;
    z-index: -1; overflow: hidden; background: transparent;
  `;
  const content = document.createElement('div');
  content.className = 'opengrammar-input-mirror-content';
  content.style.cssText = `
    position: absolute; top: 0; left: 0;
    width: max-content; min-width: 100%;
    white-space: ${element.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre'};
    word-break: break-word;
  `;
  copyTypographyStyles(element, overlay, content);
  content.textContent = input.value; // single plain text node — measurement only
  overlay.appendChild(content);
  document.body.appendChild(overlay);
  inputMirrorOverlay = overlay;
  inputMirrorContent = content;
  positionInputMirror(element);
  syncInputMirrorScroll(element);

  const sync = () => {
    syncInputMirrorScroll(element);
    scheduleFloatingDecorationUpdate('rebuild');
  };
  input.addEventListener('scroll', sync, { passive: true });
  cleanupInputMirror = () => input.removeEventListener('scroll', sync);

  if (!highlightContainer) return;
  const tnode = content.firstChild;
  if (!tnode) return;
  const len = (tnode.textContent || '').length;
  const fs = parseFloat(getComputedStyle(input).fontSize) || 16;
  const clip = input.getBoundingClientRect();
  for (const issue of issues) {
    if (issue.ignored) continue;
    const span = resolveInString(input.value, issue.offset, issue.length, issue.original);
    if (!span) continue;
    const range = document.createRange();
    try {
      range.setStart(tnode, Math.min(span.start, len));
      range.setEnd(tnode, Math.min(span.end, len));
    } catch {
      continue;
    }
    const st = getUnderlineStyle(issue);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < clip.top || r.top > clip.bottom || r.right < clip.left || r.left > clip.right) {
        continue; // scrolled out of the field
      }
      appendUnderline(r, fs, st, issue, element);
    }
  }
  cacheUnderlineBase(element);
}

/** Replace one whole sentence span with the LLM-corrected text — same
 *  validated one-primitive path as every other apply. */
function replaceSentence(
  element: HTMLElement,
  origText: string,
  approxOffset: number,
  newText: string,
): Promise<boolean> {
  return applyFix(element, {
    original: origText,
    offset: approxOffset,
    length: origText.length,
    replacement: newText,
  });
}

export function clearHighlights() {
  clearOverlayUnderlines();
  overlayTarget = null;
  overlayIssues = [];
  destroyInputMirror();
  assistantBubble?.remove(); assistantBubble = null;
  assistantBubbleIssues = [];
  assistantTarget = null;
  selectionBubble?.remove(); selectionBubble = null;
  selectionTarget = null; selectionText = '';
  document.querySelector('.og-selection-menu')?.remove();
  currentSpellMenu?.remove(); currentSpellMenu = null;
  currentTooltip?.remove(); currentTooltip = null;
  currentRephrasePanel?.remove(); currentRephrasePanel = null;
  uiActive = false;
}

function rebuildActiveUnderlines() {
  if (!overlayTarget || !overlayTarget.isConnected) return;
  // Last issue accepted/dismissed → clear the stale underline div(s) instead of
  // early-returning and leaving them painted. Dismiss fires no input event, so
  // without this the final underline would linger permanently. The FAB stays.
  if (overlayIssues.length === 0) {
    clearOverlayUnderlines();
    return;
  }
  if (overlayTarget.tagName === 'INPUT' || overlayTarget.tagName === 'TEXTAREA') {
    renderInputUnderlines(overlayTarget, overlayIssues);
  } else {
    renderOverlayUnderlines(overlayTarget, overlayIssues);
  }
}

function setUnderlinesVisible(visible: boolean) {
  underlinesAreVisible = visible;
  for (const { el } of underlineRects) {
    el.style.display = visible ? '' : 'none';
  }
}

function repositionActiveUnderlines(): boolean {
  if (!overlayTarget || !overlayTarget.isConnected) return true;
  if (!underlineBaseTargetRect || underlineRects.length === 0) return true;

  // If the text or textarea scroll changed, cached rects no longer describe the
  // glyphs. Rebuild instead of translating stale hit targets.
  if (getFieldTextSnapshot(overlayTarget) !== underlineBaseText) return false;
  const scroll = getScrollSnapshot(overlayTarget);
  if (scroll.left !== underlineBaseScrollLeft || scroll.top !== underlineBaseScrollTop) return false;

  const rect = overlayTarget.getBoundingClientRect();
  if (
    Math.abs(rect.width - underlineBaseTargetRect.width) > 0.5 ||
    Math.abs(rect.height - underlineBaseTargetRect.height) > 0.5
  ) {
    return false;
  }

  const dx = rect.left - underlineBaseTargetRect.left;
  const dy = rect.top - underlineBaseTargetRect.top;
  for (const { el } of underlineRects) {
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  }
  if (inputMirrorOverlay && inputMirrorTarget === overlayTarget) {
    positionInputMirror(overlayTarget);
  }
  setUnderlinesVisible(true);
  return true;
}

function scheduleFloatingDecorationUpdate(kind: DecorationUpdateKind) {
  if (kind === 'rebuild' || !pendingDecorationUpdate) {
    pendingDecorationUpdate = kind;
  }
  if (decorationRaf) return;
  decorationRaf = requestAnimationFrame(() => {
    const update = pendingDecorationUpdate || 'reposition';
    decorationRaf = 0;
    pendingDecorationUpdate = null;

    positionAssistantBubble();
    positionSelectionBubble();

    if (!overlayTarget || !overlayTarget.isConnected || overlayIssues.length === 0) return;
    if (!observedTargetIntersects) {
      setUnderlinesVisible(false);
      return;
    }
    if (!underlinesAreVisible) setUnderlinesVisible(true);

    if (update === 'rebuild') {
      rebuildActiveUnderlines();
    } else if (!repositionActiveUnderlines()) {
      rebuildActiveUnderlines();
    }
  });
}

export function refreshFloatingDecorations() {
  scheduleFloatingDecorationUpdate('reposition');
}

export function rebuildFloatingDecorations() {
  scheduleFloatingDecorationUpdate('rebuild');
}

export function startFloatingDecorationObservers(element: HTMLElement) {
  stopFloatingDecorationObservers();
  observedDecorationTarget = element;
  observedTargetIntersects = true;

  if (typeof ResizeObserver !== 'undefined') {
    decorationResizeObserver = new ResizeObserver(() => scheduleFloatingDecorationUpdate('rebuild'));
    decorationResizeObserver.observe(element);
  }

  if (typeof IntersectionObserver !== 'undefined') {
    decorationIntersectionObserver = new IntersectionObserver((entries) => {
      observedTargetIntersects = entries.some((entry) => entry.isIntersecting);
      scheduleFloatingDecorationUpdate('reposition');
    });
    decorationIntersectionObserver.observe(element);
  }

  decorationPollInterval = window.setInterval(() => {
    if (observedDecorationTarget?.isConnected) scheduleFloatingDecorationUpdate('reposition');
  }, 1000);

  const fonts = document.fonts;
  if (fonts?.ready) {
    const token = ++fontReadyToken;
    void fonts.ready.then(() => {
      if (token === fontReadyToken && observedDecorationTarget === element) {
        scheduleFloatingDecorationUpdate('rebuild');
      }
    });
  }
}

export function stopFloatingDecorationObservers(element?: HTMLElement) {
  if (element && observedDecorationTarget && observedDecorationTarget !== element) return;
  decorationResizeObserver?.disconnect();
  decorationResizeObserver = null;
  decorationIntersectionObserver?.disconnect();
  decorationIntersectionObserver = null;
  if (decorationPollInterval !== null) {
    window.clearInterval(decorationPollInterval);
    decorationPollInterval = null;
  }
  if (decorationRaf) {
    cancelAnimationFrame(decorationRaf);
    decorationRaf = 0;
  }
  pendingDecorationUpdate = null;
  observedDecorationTarget = null;
  observedTargetIntersects = true;
  fontReadyToken++;
}

/* ────────────────────────────────────────────────────────────
   SPELLING QUICK-REPLACE MENU (right/left-click a misspelled word)
──────────────────────────────────────────────────────────── */
function parseSpellingOptions(issue: Issue): string[] {
  const opts: string[] = [];
  if (issue.suggestion && issue.suggestion !== issue.original) opts.push(issue.suggestion);
  // Backend reason often carries: "...Other suggestions: foo, bar"
  const m = /Other suggestions?:\s*([^.]+)/i.exec(issue.reason || '');
  if (m && m[1]) {
    for (const w of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (w && !opts.includes(w) && w !== issue.original) opts.push(w);
    }
  }
  return opts.slice(0, 5);
}

function addWordToDictionary(word: string) {
  const w = word.toLowerCase();
  chrome.storage.sync.get(['dictionary'], (r) => {
    const dict: string[] = Array.isArray(r.dictionary) ? r.dictionary : [];
    if (!dict.includes(w)) {
      dict.push(w);
      chrome.storage.sync.set({ dictionary: dict });
    }
  });
}

/** Re-paint the active overlay for whichever field type is in front. Used
 *  after dismissing/accepting one issue so the remaining underlines refresh —
 *  branches on element type so it doesn't break textarea/input underlines. */
function rerenderActiveUnderlines() {
  rebuildActiveUnderlines();
}

function removeIssueUnderline(issue: Issue, element: HTMLElement) {
  issue.ignored = true;
  overlayIssues = overlayIssues.filter((i) => i !== issue);
  rerenderActiveUnderlines();
  void element;
}

function showSpellingMenu(anchor: HTMLElement, issue: Issue, element: HTMLElement) {
  if (issue.route && issue.route !== 'quick-fix') {
    showSentenceReview([issue], element, 0);
    return;
  }

  currentSpellMenu?.remove();
  injectStyles();

  const options = parseSpellingOptions(issue);
  const ar = anchor.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.className = 'opengrammar-spell-menu';
  const top = Math.min(ar.bottom + 6, window.innerHeight - 220);
  const left = Math.max(8, Math.min(ar.left, window.innerWidth - 248));
  menu.style.cssText = `
    position: fixed; left: ${left}px; top: ${top}px;
    width: 240px;
    background: #fff; border-radius: 10px;
    box-shadow: 0 4px 28px rgba(0,0,0,0.16), 0 1px 5px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.07);
    z-index: 2147483647;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden; animation: og-fade-in 0.1s ease;
  `;

  const optionRows = options.length
    ? options
        .map(
          (o, i) => `
      <button class="og-sp-opt" data-i="${i}" style="
        display:flex; align-items:center; gap:8px; width:100%;
        padding:9px 12px; background:#fff; border:none; cursor:pointer;
        font-size:14px; color:#1c1c1e; text-align:left; font-family:inherit;
        border-bottom:1px solid #f4f4f5; transition:background 0.1s;
      ">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="#16a34a" style="flex-shrink:0;">
          <path d="M6.5 11.5L2.5 7.5l1.06-1.06 2.94 2.93 5.94-5.93 1.06 1.06z"/>
        </svg>
        <span style="font-weight:600;">${escapeHtml(o)}</span>
      </button>`,
        )
        .join('')
    : `<div style="padding:10px 12px;font-size:13px;color:#8e8e93;">No suggestion — add to dictionary or ignore.</div>`;

  menu.innerHTML = `
    <div style="
      padding:8px 12px; background:#fafafa; border-bottom:1px solid #f0f0f0;
      font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase;
      color:#e53935; display:flex; align-items:center; gap:6px;
    ">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="#e53935"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/></svg>
      Spelling · <span style="color:#b91c1c;text-transform:none;font-weight:600;">${escapeHtml(issue.original)}</span>
    </div>
    ${optionRows}
    <button class="og-sp-dict" style="
      display:flex; align-items:center; gap:8px; width:100%;
      padding:9px 12px; background:#fff; border:none; cursor:pointer;
      font-size:13px; color:#3c3c43; text-align:left; font-family:inherit;
      border-bottom:1px solid #f4f4f5; transition:background 0.1s;
    ">Add “${escapeHtml(issue.original)}” to dictionary</button>
    <button class="og-sp-ignore" style="
      display:flex; align-items:center; gap:8px; width:100%;
      padding:9px 12px; background:#fff; border:none; cursor:pointer;
      font-size:13px; color:#5f6368; text-align:left; font-family:inherit;
      transition:background 0.1s;
    ">✕ Dismiss</button>
  `;

  menu.addEventListener('mousedown', (e) => e.preventDefault());

  menu.querySelectorAll<HTMLButtonElement>('.og-sp-opt').forEach((btn) => {
    btn.addEventListener('mouseenter', () => { btn.style.background = '#E7F4EC'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#fff'; });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.i || 0);
      const chosen = options[i]!;
      if (await applySuggestion(element, { ...issue, suggestion: chosen })) {
        removeIssueUnderline(issue, element);
        menu.remove(); currentSpellMenu = null;
      } else {
        flashApplyFailure(menu);
      }
    });
  });

  const dictBtn = menu.querySelector('.og-sp-dict') as HTMLButtonElement;
  dictBtn.addEventListener('mouseenter', () => { dictBtn.style.background = '#f5f5f7'; });
  dictBtn.addEventListener('mouseleave', () => { dictBtn.style.background = '#fff'; });
  dictBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addWordToDictionary(issue.original);
    removeIssueUnderline(issue, element);
    menu.remove(); currentSpellMenu = null;
  });

  const ignBtn = menu.querySelector('.og-sp-ignore') as HTMLButtonElement;
  ignBtn.addEventListener('mouseenter', () => { ignBtn.style.background = '#f5f5f7'; });
  ignBtn.addEventListener('mouseleave', () => { ignBtn.style.background = '#fff'; });
  ignBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ignoreIssue(issue, anchor);
    removeIssueUnderline(issue, element);
    menu.remove(); currentSpellMenu = null;
  });

  const onDocClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove(); currentSpellMenu = null;
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      menu.remove(); currentSpellMenu = null;
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 60);

  document.body.appendChild(menu);
  currentSpellMenu = menu;
}

/* ────────────────────────────────────────────────────────────
   GRAMMARLY-STYLE FLOATING BADGE (bottom-right green circle)
──────────────────────────────────────────────────────────── */
export type AssistantPhase =
  | 'analyzing-local'
  | 'analyzing-llm'
  | 'has-issues'
  | 'clean-pending-ai'
  | 'clean';

export interface AssistantState {
  localCount: number;
  llmCount: number | null;
  phase: AssistantPhase;
  issues?: Issue[];
}

function getAssistantSeverity(issues: Issue[]): '#e53935' | '#f59e0b' {
  return issues.some((i) => i.type === 'grammar' || i.type === 'spelling') ? '#e53935' : '#f59e0b';
}

function getAssistantLabel(state: AssistantState, totalCount: number): string {
  switch (state.phase) {
    case 'analyzing-local':
      return 'OGrammar: checking writing';
    case 'analyzing-llm':
      return totalCount > 0
        ? `OGrammar: ${totalCount} suggestion${totalCount !== 1 ? 's' : ''}; AI is still checking context`
        : 'OGrammar: AI is checking context';
    case 'clean-pending-ai':
      return 'OGrammar: local check found no issues; AI context check pending';
    case 'clean':
      return 'OGrammar: writing looks clean';
    case 'has-issues':
    default:
      return state.llmCount === null
        ? `OGrammar: ${totalCount} suggestion${totalCount !== 1 ? 's' : ''}; AI is still checking context`
        : `OGrammar: ${totalCount} suggestion${totalCount !== 1 ? 's' : ''}`;
  }
}

function renderAssistantBadge(state: AssistantState, issues: Issue[]): string {
  const totalCount = issues.length || state.localCount + (state.llmCount || 0);
  const checking = state.phase === 'analyzing-local' || state.phase === 'analyzing-llm';
  const pendingAi = state.llmCount === null || state.phase === 'clean-pending-ai' || state.phase === 'analyzing-llm';
  const badgeBg =
    state.phase === 'clean'
      ? '#16a34a'
      : totalCount > 0
        ? getAssistantSeverity(issues)
        : '#1FA463';
  const badgeText =
    state.phase === 'clean'
      ? '✓'
      : state.phase === 'analyzing-local' && totalCount === 0
        ? ''
        : totalCount > 0
          ? String(totalCount)
          : 'AI';
  const badgeInner = badgeText
    ? escapeHtml(badgeText)
    : `<span style="width:8px;height:8px;border:1.5px solid rgba(255,255,255,0.55);border-top-color:white;border-radius:50%;animation:og-spin 0.7s linear infinite;"></span>`;
  const aiHint = pendingAi && totalCount > 0
    ? `<span style="
        position:absolute; bottom:-7px; right:-11px;
        height:12px; min-width:16px; padding:0 3px;
        border-radius:999px; background:#1FA463; color:white;
        font-size:7px; font-weight:800; line-height:12px;
        border:1.5px solid white;
        font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        box-shadow:0 1px 3px rgba(0,0,0,0.22);
      ">AI</span>`
    : '';

  const mainIcon = checking
    ? `<span style="width:15px;height:15px;border:2px solid rgba(255,255,255,0.45);border-top-color:white;border-radius:50%;animation:og-spin 0.7s linear infinite;"></span>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M20 4C15 4 10 7 8 12L4 20l8-4c5-2 8-7 8-12z" fill="white" opacity="0.92"/>
        <path d="M8 12 L4 20" stroke="rgba(255,255,255,0.55)" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M5 18l2 2 4-5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

  return `
    <span style="position:relative;display:flex;align-items:center;justify-content:center;">
      ${mainIcon}
      <span style="
        position:absolute; top:-6px; right:-8px;
        min-width:15px; height:15px; padding:0 3px;
        border-radius:999px; background:${badgeBg}; color:white;
        font-size:9px; font-weight:700;
        display:inline-flex; align-items:center; justify-content:center;
        border:1.5px solid white;
        font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        box-shadow:0 1px 3px rgba(0,0,0,0.25);
      ">${badgeInner}</span>
      ${aiHint}
    </span>
  `;
}

export function setAssistantState(element: HTMLElement, state: AssistantState) {
  assistantBubbleIssues = state.issues || assistantBubbleIssues || [];

  if (!assistantBubble || assistantTarget !== element || !assistantBubble.isConnected) {
    assistantBubble?.remove();
    assistantBubble = null;

    const bubble = document.createElement('button');
    bubble.className = 'opengrammar-assistant';
    bubble.type = 'button';
    bubble.style.cssText = `
      position: fixed;
      left: 0; top: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; padding: 0;
      border-radius: 50%;
      background: linear-gradient(135deg, #1FA463 0%, #1FA463 100%);
      box-shadow: 0 1px 6px rgba(31,164,99,0.45), 0 1px 3px rgba(0,0,0,0.18);
      z-index: 2147483646;
      cursor: pointer; pointer-events: auto;
      border: none; outline: none;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    `;
    bubble.addEventListener('mouseenter', () => { bubble.style.transform = 'scale(1.12)'; });
    bubble.addEventListener('mouseleave', () => { bubble.style.transform = 'scale(1)'; });
    bubble.addEventListener('mousedown', (e) => e.preventDefault());
    bubble.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!assistantTarget) return;
      // Nothing to fix → offer a tone rewrite of the whole message (+ an AI check).
      if (assistantBubbleIssues.length === 0) {
        openWholeMessageMenu(bubble, assistantTarget);
        return;
      }
      // Grammar/clarity/style → whole-sentence review.
      // Spelling is handled inline via right/left-click on the underline.
      showSentenceReview(assistantBubbleIssues, assistantTarget, 0);
    });

    document.body.appendChild(bubble);
    assistantBubble = bubble;
    assistantTarget = element;
  }

  const totalCount = assistantBubbleIssues.length || state.localCount + (state.llmCount || 0);
  const label = getAssistantLabel(state, totalCount);
  assistantBubble.setAttribute('aria-label', label);
  assistantBubble.title = label;
  assistantBubble.innerHTML = renderAssistantBadge(state, assistantBubbleIssues);
  positionAssistantBubble();
}

function showAssistantBubble(element: HTMLElement, issues: Issue[]) {
  setAssistantState(element, {
    localCount: issues.length,
    llmCount: 0,
    phase: issues.length > 0 ? 'has-issues' : 'clean-pending-ai',
    issues,
  });
}

/**
 * Show/hide the selection-rewrite bubble. Called by the content script
 * whenever the text selection inside an editable field changes. With a
 * non-empty selection it shows a bubble; clicking it offers tone rewrites
 * of just that selection (REWRITE_TEXT), applied via the same validated
 * replaceSentence primitive as everything else. Empty/no selection removes
 * it. Independent of grammar issues — works on clean text too.
 */
export function updateSelectionBubble(
  element: HTMLElement | null,
  text: string,
  approxOffset: number,
) {
  if (!element || !text || text.trim().length < 2) {
    selectionBubble?.remove();
    selectionBubble = null;
    selectionTarget = null;
    selectionText = '';
    document.querySelector('.og-selection-menu')?.remove();
    return;
  }
  selectionTarget = element;
  selectionText = text;
  selectionApproxOffset = approxOffset;

  if (selectionBubble) {
    positionSelectionBubble();
    return;
  }

  const bubble = document.createElement('button');
  bubble.className = 'opengrammar-selection';
  bubble.type = 'button';
  bubble.setAttribute('aria-label', 'OGrammar: rewrite selected text');
  bubble.title = 'Rewrite the selected text';
  bubble.style.cssText = `
    position: fixed; left: 0; top: 0;
    display: inline-flex; align-items: center; justify-content: center;
    width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; padding: 0;
    border-radius: 50%;
    background: linear-gradient(135deg, #1FA463 0%, #1FA463 100%);
    box-shadow: 0 1px 6px rgba(31,164,99,0.45), 0 1px 3px rgba(0,0,0,0.18);
    z-index: 2147483646; cursor: pointer; pointer-events: auto;
    border: none; outline: none; transition: transform 0.12s ease;
  `;
  bubble.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5"/>
      <path d="M2 2l7.586 7.586"/>
    </svg>
  `;
  bubble.addEventListener('mouseenter', () => { bubble.style.transform = 'scale(1.12)'; });
  bubble.addEventListener('mouseleave', () => { bubble.style.transform = 'scale(1)'; });
  bubble.addEventListener('mousedown', (e) => e.preventDefault());
  bubble.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSelectionMenu(bubble);
  });
  document.body.appendChild(bubble);
  selectionBubble = bubble;
  positionSelectionBubble();
}

function openSelectionMenu(anchor: HTMLElement) {
  if (!selectionTarget || !selectionText) return;
  openRewriteMenu(anchor, selectionTarget, selectionText, selectionApproxOffset, 'Rewrite selection');
}

/** The in-field badge on a field with nothing to fix: rewrite the WHOLE message in a
 *  tone — the same action as the desktop app's pen beside the field. */
function openWholeMessageMenu(anchor: HTMLElement, el: HTMLElement) {
  const full = getFullText(el);
  const body = full.trim();
  if (body.length < 2) return;
  openRewriteMenu(anchor, el, body, full.indexOf(body), 'Rewrite message', () =>
    showSentenceReview(assistantBubbleIssues, el, 0),
  );
}

/** Tone menu → preview → Apply for `sel` (the text at ~`offset` in `el`). With
 *  `onReview`, a footer link also offers the AI sentence review. */
function openRewriteMenu(
  anchor: HTMLElement,
  el: HTMLElement,
  sel: string,
  offset: number,
  title: string,
  onReview?: () => void,
) {
  document.querySelector('.og-selection-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'og-selection-menu';
  menu.style.cssText = `
    position: fixed; z-index: 2147483647;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.18);
    padding: 10px; width: 264px;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;
  menu.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:#111827;margin-bottom:8px;">
      ${escapeHtml(title)}
    </div>
    <div class="og-sel-chips" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    <div class="og-sel-status" style="display:none;margin-top:8px;font-size:12px;color:#6b7280;"></div>
    ${onReview ? `<button class="og-sel-review" type="button" style="display:block;width:100%;margin-top:8px;
      padding:4px;background:none;border:none;color:#127A48;font-size:11px;font-weight:600;
      cursor:pointer;font-family:inherit;">Check the whole text with AI →</button>` : ''}
  `;
  const chips = menu.querySelector('.og-sel-chips') as HTMLElement;
  const status = menu.querySelector('.og-sel-status') as HTMLElement;
  menu.querySelector('.og-sel-review')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.remove();
    onReview?.();
  });
  for (const [tone, label] of TONES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.tone = tone;
    chip.textContent = label;
    chip.style.cssText = `
      flex:1 1 auto; min-width:70px; padding:6px 8px;
      background:#E7F4EC; color:#127A48; border:1px solid #A7E0C2;
      border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;
      font-family:inherit; transition:background 0.12s;
    `;
    chip.addEventListener('mouseenter', () => { chip.style.background = '#D6ECDD'; });
    chip.addEventListener('mouseleave', () => { chip.style.background = '#E7F4EC'; });
    chips.appendChild(chip);
  }

  let busy = false;
  let pending: { text: string; label: string } | null = null;

  // Preview + explicit Apply — nothing changes until the user confirms.
  // Picking another tone re-previews.
  const renderPreview = (label: string, proposed: string) => {
    status.style.display = 'block';
    status.innerHTML = `
      <div style="font-size:10px;color:#8e8e93;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">
        Preview · ${escapeHtml(label)}
      </div>
      <div style="font-size:12px;color:#1c1c1e;line-height:1.45;background:#E7F4EC;
        border:1px solid #A7E0C2;border-radius:6px;padding:7px 9px;white-space:pre-wrap;
        max-height:140px;overflow:auto;">${escapeHtml(proposed)}</div>
      <div style="display:flex;gap:6px;margin-top:7px;">
        <button class="og-sel-apply" type="button" style="flex:1;padding:6px 8px;background:#1FA463;
          color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Apply</button>
        <button class="og-sel-cancel" type="button" style="flex:1;padding:6px 8px;background:#fff;
          color:#6b7280;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button>
      </div>
      <div style="font-size:10px;color:#8e8e93;margin-top:5px;text-align:center;">Pick another tone above to re-preview.</div>
    `;
    (status.querySelector('.og-sel-apply') as HTMLButtonElement)?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!pending) return;
      // Keep the selection's own surrounding whitespace: double-clicking a word on
      // Windows selects its trailing space, which the trimmed rewrite would drop.
      const lead = sel.slice(0, sel.length - sel.trimStart().length);
      const trail = sel.slice(sel.trimEnd().length);
      const ok = await replaceSentence(el, sel, offset, lead + pending.text + trail);
      if (ok) {
        menu.remove();
        updateSelectionBubble(null, '', 0);
      } else {
        status.innerHTML = '';
        status.textContent = 'Could not apply here.';
      }
    });
    (status.querySelector('.og-sel-cancel') as HTMLButtonElement)?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.remove();
      updateSelectionBubble(null, '', 0);
    });
  };

  chips.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('[data-tone]') as HTMLElement | null;
    if (!chip || busy) return;
    busy = true;
    chips.style.opacity = '0.5';
    chips.style.pointerEvents = 'none';
    status.style.display = 'block';
    status.textContent = `Rewriting (${chip.textContent})…`;
    chrome.runtime.sendMessage(
      { type: 'REWRITE_TEXT', text: sel.trim(), tone: chip.dataset.tone },
      (resp) => {
        busy = false;
        chips.style.opacity = '';
        chips.style.pointerEvents = '';
        const rewritten = resp && resp.rewritten ? String(resp.rewritten).trim() : '';
        if (!rewritten || rewritten === sel.trim()) {
          pending = null;
          status.textContent =
            resp && resp.error ? 'Rewrite failed — check provider/API key.' : 'No change suggested.';
          return;
        }
        pending = { text: rewritten, label: chip.textContent || 'tone' };
        renderPreview(pending.label, rewritten);
      },
    );
  });

  // Keep the editable focused so applyFix can write back.
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const mw = menu.getBoundingClientRect().width;
  const mh = menu.getBoundingClientRect().height;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  let top = r.top - mh - 8;
  if (top < 8) top = r.bottom + 8;
  menu.style.left = `${Math.round(Math.max(8, left))}px`;
  menu.style.top = `${Math.round(top)}px`;

  const onDoc = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node) && ev.target !== anchor) {
      menu.remove();
      document.removeEventListener('mousedown', onDoc, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}

/* ────────────────────────────────────────────────────────────
   GRAMMARLY-STYLE TOOLTIP CARD (inline highlight → click)
──────────────────────────────────────────────────────────── */
/**
 * Place a panel relative to an anchor, staying fully inside the viewport.
 * Must be called AFTER the element is in the DOM (uses its measured size).
 * Opens below the anchor if it fits, else above, else clamps on-screen — so
 * it never runs off the bottom where the user might not be able to scroll.
 */
function placeFixedPanel(el: HTMLElement, anchorRect: DOMRect, gap = 8) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth || 334;
  const h = el.offsetHeight || 300;
  const left = Math.max(8, Math.min(anchorRect.left, vw - w - 8));
  const spaceBelow = vh - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  let top: number;
  if (h + gap <= spaceBelow) top = anchorRect.bottom + gap;
  else if (h + gap <= spaceAbove) top = anchorRect.top - gap - h;
  else top = spaceBelow >= spaceAbove ? vh - h - 8 : 8;
  top = Math.max(8, Math.min(top, vh - h - 8));
  el.style.position = 'fixed';
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Inline REVIEW card — opened by clicking a dotted underline (sentence-review
 * or LLM/context issue). Unlike the spelling menu / mechanical tooltip, this
 * NEVER does a silent destructive replace: it previews the single correction
 * and the user explicitly Accepts. "Review in context" is the only path that
 * re-calls the model (whole-sentence review); the card itself uses the
 * structured correction we already have, so opening it costs nothing.
 */
function showInlineReviewCard(anchor: HTMLElement, issue: Issue, element: HTMLElement) {
  uiActive = true;
  currentTooltip?.remove();
  currentRephrasePanel?.remove();
  currentRephrasePanel = null;
  injectStyles();

  const anchorRect = anchor.getBoundingClientRect();
  const ai = isLlmIssue(issue);
  const accent = ai ? REVIEW_LLM_LINE : getC(issue.type).line;
  const kicker = ai ? 'AI suggestion' : getCategoryLabel(issue.type);
  const headline = summarizeChange(issue.original, issue.suggestion) || getTypeLabel(issue.type);
  const diffHtml = renderInlineDiffHTML(issue.original, issue.suggestion);

  const card = document.createElement('div');
  card.className = 'opengrammar-tooltip';
  card.style.cssText = `
    position: fixed; left: -9999px; top: -9999px;
    width: 330px;
    background: #ffffff; border-radius: 12px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.14), 0 1px 6px rgba(0,0,0,0.07);
    z-index: 2147483647;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; max-height: calc(100vh - 16px); overflow-y: auto;
    border: 1px solid rgba(0,0,0,0.07); animation: og-fade-in 0.12s ease;
  `;

  card.innerHTML = `
    <div style="padding: 13px 16px 10px; border-bottom: 1px solid #f0f0f0;">
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:5px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${accent};display:inline-block;border:1px dotted ${accent};"></span>
        <span style="font-size:11px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(kicker)}</span>
        ${ai ? `<span style="margin-left:auto;font-size:10px;font-weight:600;color:#6b7280;background:#E7F4EC;border:1px solid #A7E0C2;border-radius:999px;padding:1px 7px;">context</span>` : ''}
      </div>
      <div style="font-size:14px;font-weight:600;color:#1c1c1e;line-height:1.4;">
        ${escapeHtml(headline)}
      </div>
    </div>

    <div class="og-rv-apply-box" style="
      padding: 12px 16px; background:#fafafa; cursor:pointer;
      transition:background 0.12s; border-bottom:1px solid #f0f0f0;
    ">
      <div style="font-size:14px; line-height:1.6; word-break:break-word;">
        ${diffHtml}
      </div>
      <div style="margin-top:6px;font-size:11px;color:#8e8e93;">Click to accept</div>
    </div>

    <details style="border-bottom:1px solid #f0f0f0;">
      <summary style="padding:8px 16px;cursor:pointer;font-size:12px;color:#5f6368;font-weight:600;list-style:none;user-select:none;">Why?</summary>
      <div style="padding:0 16px 10px;font-size:13px;color:#3c3c43;line-height:1.5;">
        ${escapeHtml(issue.reason || 'Suggested for clarity and correctness.')}
      </div>
    </details>

    <div style="display:flex; border-top: 1px solid #f0f0f0;">
      <button class="og-rv-accept" style="
        flex: 1.4; padding: 11px 12px; background: #1FA463; color: white;
        border: none; cursor: pointer; font-size: 13px; font-weight: 600;
        border-radius: 0 0 0 12px; font-family: inherit; transition: background 0.12s;
        display: flex; align-items: center; justify-content: center; gap: 5px;
      ">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="white">
          <path d="M6.5 11.5L2.5 7.5l1.06-1.06 2.94 2.93 5.94-5.93 1.06 1.06z"/>
        </svg>
        Accept
      </button>
      <button class="og-rv-context" style="
        flex: 1.3; padding: 11px 10px; background: white; color: #1FA463;
        border: none; border-left: 1px solid #f0f0f0; cursor: pointer;
        font-size: 12px; font-weight: 600; font-family: inherit; transition: background 0.12s;
      " title="Review the whole sentence with AI">Review in context</button>
      <button class="og-rv-dismiss" style="
        flex: 1; padding: 11px 10px; background: white; color: #5f6368;
        border: none; border-left: 1px solid #f0f0f0; cursor: pointer;
        font-size: 13px; font-weight: 500; border-radius: 0 0 12px 0;
        font-family: inherit; transition: background 0.12s;
      ">Dismiss</button>
    </div>
  `;

  card.addEventListener('mousedown', (e) => e.preventDefault());

  const accept = async () => {
    // Only drop the underline if the validated apply actually landed; a stale
    // span (text moved/changed since analysis) keeps its underline.
    if (await applySuggestion(element, issue)) {
      removeIssueUnderline(issue, element);
      hideTooltip();
      return;
    }
    // Apply failed (stale span / framework reverted the insert). Keep the card
    // open and surface why, instead of closing as if it worked.
    flashApplyFailure(card);
  };

  const applyBox = card.querySelector('.og-rv-apply-box') as HTMLElement | null;
  if (applyBox) {
    applyBox.addEventListener('click', (e) => { e.stopPropagation(); accept(); });
    applyBox.addEventListener('mouseenter', () => { applyBox.style.background = '#D6ECDD'; });
    applyBox.addEventListener('mouseleave', () => { applyBox.style.background = '#fafafa'; });
  }

  const acceptBtn = card.querySelector('.og-rv-accept') as HTMLButtonElement | null;
  if (acceptBtn) {
    acceptBtn.addEventListener('click', (e) => { e.stopPropagation(); accept(); });
    acceptBtn.addEventListener('mouseenter', () => { acceptBtn.style.background = '#127A48'; });
    acceptBtn.addEventListener('mouseleave', () => { acceptBtn.style.background = '#1FA463'; });
  }

  const contextBtn = card.querySelector('.og-rv-context') as HTMLButtonElement | null;
  if (contextBtn) {
    contextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      // Explicit deeper review — the ONLY path that re-invokes the model.
      showSentenceReview([issue], element, 0);
    });
    contextBtn.addEventListener('mouseenter', () => { contextBtn.style.background = '#E7F4EC'; });
    contextBtn.addEventListener('mouseleave', () => { contextBtn.style.background = 'white'; });
  }

  const dismissBtn = card.querySelector('.og-rv-dismiss') as HTMLButtonElement | null;
  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ignoreIssue(issue, anchor);
      hideTooltip();
    });
    dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.background = '#f8f9fa'; });
    dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.background = 'white'; });
  }

  const closeOnOutsideClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!card.contains(t) && !anchor.contains(t)) {
      hideTooltip();
      document.removeEventListener('click', closeOnOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 100);

  document.body.appendChild(card);
  placeFixedPanel(card, anchorRect, 8);
  currentTooltip = card;
}

function showTooltip(anchor: HTMLElement, issue: Issue, element: HTMLElement) {
  uiActive = true;
  currentTooltip?.remove();
  currentRephrasePanel?.remove();
  currentRephrasePanel = null;

  const anchorRect = anchor.getBoundingClientRect();
  const c = getC(issue.type);

  const card = document.createElement('div');
  card.className = 'opengrammar-tooltip';
  card.style.cssText = `
    position: fixed;
    left: -9999px; top: -9999px;
    width: 334px;
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.14), 0 1px 6px rgba(0,0,0,0.07);
    z-index: 2147483647;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    border: 1px solid rgba(0,0,0,0.07);
    animation: og-fade-in 0.12s ease;
  `;

  // Inject keyframe once
  injectStyles();

  const headline =
    summarizeChange(issue.original, issue.suggestion) || getTypeLabel(issue.type);
  const diffHtml = renderInlineDiffHTML(issue.original, issue.suggestion);
  // Spelling/punctuation fixes are self-evident → collapse the rationale.
  // Clarity/style need persuading → show it.
  const whyOpen = issue.type === 'clarity' || issue.type === 'style';
  const showRephrase = issue.type === 'clarity' || issue.type === 'style';

  card.innerHTML = `
    <!-- Header: category chip + concise what's-wrong -->
    <div style="padding: 13px 16px 10px; border-bottom: 1px solid #f0f0f0;">
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:5px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${c.line};display:inline-block;"></span>
        <span style="font-size:11px;font-weight:700;color:${c.line};text-transform:uppercase;letter-spacing:0.5px;">${getTypeLabel(issue.type)}</span>
      </div>
      <div style="font-size:14px;font-weight:600;color:#1c1c1e;line-height:1.4;">
        ${escapeHtml(headline)}
      </div>
    </div>

    <!-- The single minimal-change line (click to accept) -->
    <div class="og-suggestion-click" style="
      padding: 12px 16px; background:#fafafa; cursor:pointer;
      transition:background 0.12s; border-bottom:1px solid #f0f0f0;
    ">
      <div style="font-size:14px; line-height:1.6; word-break:break-word;">
        ${diffHtml}
      </div>
      <div style="margin-top:6px;font-size:11px;color:#8e8e93;">Click to apply</div>
    </div>

    <!-- Why (collapsed for correctness, open for clarity/style) -->
    <details ${whyOpen ? 'open' : ''} style="border-bottom:1px solid #f0f0f0;">
      <summary style="padding:8px 16px;cursor:pointer;font-size:12px;color:#5f6368;font-weight:600;list-style:none;user-select:none;">Why?</summary>
      <div style="padding:0 16px 10px;font-size:13px;color:#3c3c43;line-height:1.5;">
        ${escapeHtml(issue.reason)}
      </div>
    </details>

    <!-- Action buttons -->
    <div style="display:flex; border-top: 1px solid #f0f0f0;">
      <button class="og-apply-btn" style="
        flex: 1; padding: 11px 16px;
        background: #1FA463; color: white;
        border: none; cursor: pointer;
        font-size: 13px; font-weight: 600;
        border-radius: 0 0 0 12px;
        font-family: inherit;
        transition: background 0.12s;
        display: flex; align-items: center; justify-content: center; gap: 5px;
      ">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="white">
          <path d="M6.5 11.5L2.5 7.5l1.06-1.06 2.94 2.93 5.94-5.93 1.06 1.06z"/>
        </svg>
        Accept
      </button>
      <button class="og-rephrase-btn" style="
        flex: 1; padding: 11px 16px;
        background: white; color: #5f6368;
        border: none; border-left: 1px solid #f0f0f0; cursor: pointer;
        font-size: 13px; font-weight: 500;
        font-family: inherit;
        transition: background 0.12s;
        display: ${showRephrase ? 'flex' : 'none'}; align-items: center; justify-content: center; gap: 5px;
      " title="Get AI rewrites (requires API key)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#5f6368" stroke-width="1.5" stroke-linecap="round">
          <path d="M2 8a6 6 0 1 1 1.5 4M2 12V8h4"/>
        </svg>
        Rephrase
      </button>
      <button class="og-ignore-btn" style="
        flex: 1; padding: 11px 16px;
        background: white; color: #5f6368;
        border: none; border-left: 1px solid #f0f0f0; cursor: pointer;
        font-size: 13px; font-weight: 500;
        border-radius: 0 0 12px 0;
        font-family: inherit;
        transition: background 0.12s;
      ">Dismiss</button>
    </div>
  `;

  // Suggestion click = apply fix
  const suggClick = card.querySelector('.og-suggestion-click') as HTMLElement;
  if (suggClick) {
    suggClick.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await applySuggestion(element, issue)) hideTooltip();
      else flashApplyFailure(card);
    });
    suggClick.addEventListener('mouseenter', () => { suggClick.style.background = '#D6ECDD'; });
    suggClick.addEventListener('mouseleave', () => { suggClick.style.background = '#fafafa'; });
  }

  const applyBtn  = card.querySelector('.og-apply-btn') as HTMLButtonElement;
  const rephraseBtn = card.querySelector('.og-rephrase-btn') as HTMLButtonElement;
  const ignoreBtn = card.querySelector('.og-ignore-btn') as HTMLButtonElement;

  applyBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); e.preventDefault();
    if (await applySuggestion(element, issue)) hideTooltip();
    else flashApplyFailure(card);
  });
  applyBtn.addEventListener('mouseenter', () => { applyBtn.style.background = '#127A48'; });
  applyBtn.addEventListener('mouseleave', () => { applyBtn.style.background = '#1FA463'; });

  rephraseBtn.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    showRephrasePanel(card, issue, element);
  });
  rephraseBtn.addEventListener('mouseenter', () => { rephraseBtn.style.background = '#f8f9fa'; });
  rephraseBtn.addEventListener('mouseleave', () => { rephraseBtn.style.background = 'white'; });

  ignoreBtn.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    ignoreIssue(issue, anchor);
    hideTooltip();
  });
  ignoreBtn.addEventListener('mouseenter', () => { ignoreBtn.style.background = '#f8f9fa'; });
  ignoreBtn.addEventListener('mouseleave', () => { ignoreBtn.style.background = 'white'; });

  card.addEventListener('mousedown', (e) => e.preventDefault());

  const closeOnOutsideClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!card.contains(t) && !anchor.contains(t) && !(currentRephrasePanel?.contains(t))) {
      hideTooltip();
      document.removeEventListener('click', closeOnOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 100);

  document.body.appendChild(card);
  placeFixedPanel(card, anchorRect, 8);
  currentTooltip = card;
}

/* ────────────────────────────────────────────────────────────
   REPHRASE PANEL (slides below tooltip card)
──────────────────────────────────────────────────────────── */
function showRephrasePanel(tooltipCard: HTMLElement, issue: Issue, element: HTMLElement) {
  currentRephrasePanel?.remove();

  const panel     = document.createElement('div');
  panel.className = 'opengrammar-rephrase-panel';
  panel.style.cssText = `
    position: fixed;
    left: -9999px; top: -9999px;
    width: 334px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.14), 0 1px 6px rgba(0,0,0,0.07);
    border: 1px solid rgba(0,0,0,0.07);
    z-index: 2147483647;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    animation: og-fade-in 0.12s ease;
  `;

  const goals = [
    { id: 'clarity',  icon: '🎯', label: 'Clearer' },
    { id: 'formal',   icon: '👔', label: 'More Formal' },
    { id: 'concise',  icon: '✂️', label: 'Concise' },
    { id: 'friendly', icon: '😊', label: 'Friendlier' },
  ];

  panel.innerHTML = `
    <div style="padding: 12px 14px; border-bottom: 1px solid #f0f0f0; display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:7px;">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#1FA463" stroke-width="1.6" stroke-linecap="round">
          <path d="M2 8a6 6 0 1 1 1.5 4M2 12V8h4"/>
        </svg>
        <span style="font-size:13px;font-weight:700;color:#1c1c1e;">✨ Rephrase Sentence</span>
      </div>
      <button class="og-close-rephrase" style="
        background:none;border:none;cursor:pointer;padding:4px;
        color:#8e8e93;border-radius:6px;font-size:16px;line-height:1;
        transition:background 0.1s;
      " aria-label="Close">✕</button>
    </div>

    <!-- Goal selector -->
    <div style="padding: 10px 14px; border-bottom: 1px solid #f4f4f5; display:flex; gap:6px; flex-wrap:wrap;">
      ${goals.map(g => `
        <button class="og-goal-btn" data-goal="${g.id}" style="
          padding: 5px 10px;
          background: ${g.id === 'clarity' ? '#E7F4EC' : '#f4f4f5'};
          color: ${g.id === 'clarity' ? '#127A48' : '#5f6368'};
          border: 1px solid ${g.id === 'clarity' ? '#A7E0C2' : '#e5e7eb'};
          border-radius: 999px;
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 0.12s;
          font-family: inherit;
          white-space: nowrap;
        ">${g.icon} ${g.label}</button>
      `).join('')}
    </div>

    <!-- Content area -->
    <div class="og-rephrase-content" style="padding: 10px 14px; min-height: 80px;">
      <div class="og-rephrase-loading" style="
        display:flex;flex-direction:column;align-items:center;
        justify-content:center; gap:8px; padding:24px 0;
      ">
        <div style="
          width: 22px; height: 22px;
          border: 2px solid #e5e7eb; border-top-color: #1FA463;
          border-radius: 50%;
          animation: og-spin 0.7s linear infinite;
        "></div>
        <span style="font-size:12px;color:#8e8e93;">Generating alternatives…</span>
      </div>
    </div>

    <!-- Sentence shown -->
    <div style="padding: 0 14px 10px;">
      <div style="
        font-size: 11px; color: #8e8e93; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
        margin-bottom: 4px;
      ">Original sentence</div>
      <div style="
        font-size: 13px; color: #3c3c43;
        background: #fafafa; border-radius: 6px;
        padding: 7px 10px; line-height: 1.45;
        border: 1px solid #f0f0f0;
        word-break: break-word;
      ">${escapeHtml(issue.original)}</div>
    </div>

    <div style="padding: 0 14px 12px;">
      <p style="font-size:11px;color:#aeaeb2;margin:0;text-align:center;">
        Powered by your configured AI provider · Requires API key
      </p>
    </div>
  `;

  panel.addEventListener('mousedown', (e) => e.preventDefault());

  // Close button
  const closeBtn = panel.querySelector('.og-close-rephrase') as HTMLButtonElement;
  closeBtn.addEventListener('click', () => {
    currentRephrasePanel?.remove();
    currentRephrasePanel = null;
  });
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#f4f4f5'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; });

  // Goal buttons
  let activeGoal = 'clarity';
  const goalBtns = panel.querySelectorAll('.og-goal-btn') as NodeListOf<HTMLButtonElement>;

  const setGoalActive = (goal: string) => {
    activeGoal = goal;
    goalBtns.forEach((btn) => {
      const isActive = btn.dataset.goal === goal;
      btn.style.background = isActive ? '#E7F4EC' : '#f4f4f5';
      btn.style.color        = isActive ? '#127A48' : '#5f6368';
      btn.style.borderColor  = isActive ? '#A7E0C2' : '#e5e7eb';
    });
    triggerRephrase(goal);
  };

  goalBtns.forEach((btn) => {
    btn.addEventListener('click', () => setGoalActive(btn.dataset.goal || 'clarity'));
  });

  document.body.appendChild(panel);
  const repositionPanel = () =>
    placeFixedPanel(panel, tooltipCard.getBoundingClientRect(), 6);
  repositionPanel();
  currentRephrasePanel = panel;

  // Auto-trigger rephrase with default goal
  triggerRephrase(activeGoal);

  async function triggerRephrase(goal: string) {
    const content = panel.querySelector('.og-rephrase-content') as HTMLElement;
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 0;">
        <div style="
          width:22px;height:22px;
          border:2px solid #e5e7eb;border-top-color:#1FA463;
          border-radius:50%;animation:og-spin 0.7s linear infinite;
        "></div>
        <span style="font-size:12px;color:#8e8e93;">Generating alternatives…</span>
      </div>
    `;

    try {
      const stored = await new Promise<Record<string, string>>((res) =>
        chrome.storage.sync.get(['provider'], (r) => res(r as Record<string, string>))
      );
      const apiKey   = await getApiKey();
      const provider = stored.provider || 'openai';

      if (!apiKey && provider !== 'ollama') {
        content.innerHTML = `
          <div style="padding:16px;text-align:center;">
            <div style="font-size:13px;color:#dc2626;margin-bottom:6px;">🔑 API key required</div>
            <div style="font-size:12px;color:#8e8e93;">Add your API key in the OGrammar popup settings, then try again.</div>
          </div>
        `;
        repositionPanel();
        return;
      }

      const data: { suggestions?: { text: string; label: string }[]; explanation?: string } =
        await chrome.runtime.sendMessage({
          type: 'REPHRASE_TEXT',
          sentence: issue.original,
          goal,
        });
      const suggestions = data?.suggestions || [];

      if (suggestions.length === 0) {
        content.innerHTML = `
          <div style="padding:16px;text-align:center;font-size:13px;color:#8e8e93;">
            No alternatives generated. Try a different goal.
          </div>
        `;
        repositionPanel();
        return;
      }

      content.innerHTML = suggestions.map((s, i) => `
        <div class="og-rephrase-item" data-idx="${i}" style="
          display:flex; align-items:flex-start; gap:10px;
          padding: 9px 10px; margin-bottom: 5px;
          border: 1px solid #e5e7eb; border-radius: 8px;
          cursor: pointer; transition: all 0.12s;
          background: white;
        ">
          <span style="
            flex-shrink:0;
            display:inline-flex;align-items:center;justify-content:center;
            width:20px;height:20px;border-radius:50%;
            background:#E7F4EC;border:1px solid #A7E0C2;
            font-size:11px;font-weight:700;color:#127A48;
            margin-top:1px;
          ">${i + 1}</span>
          <span style="font-size:13px;color:#1c1c1e;line-height:1.45;flex:1;word-break:break-word;">
            ${escapeHtml(s.text)}
          </span>
          <button class="og-use-btn" data-text="${escapeHtml(s.text)}" style="
            flex-shrink:0;
            padding: 4px 10px;
            background: #1FA463; color: white;
            border: none; border-radius: 6px;
            font-size: 11px; font-weight: 700;
            cursor: pointer; transition: background 0.12s;
            font-family: inherit; white-space: nowrap;
            align-self: center;
          ">Use</button>
        </div>
      `).join('');

      // Wire "Use" buttons
      content.querySelectorAll('.og-use-btn').forEach((btn) => {
        const useBtn = btn as HTMLButtonElement;
        useBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const text = useBtn.dataset.text ? decodeHtmlEntities(useBtn.dataset.text) : '';
          if (text && element && !(await applySuggestion(element, { ...issue, suggestion: text }))) {
            if (currentRephrasePanel) flashApplyFailure(currentRephrasePanel);
            return;
          }
          hideTooltip();
          currentRephrasePanel?.remove();
          currentRephrasePanel = null;
        });
        useBtn.addEventListener('mouseenter', () => { useBtn.style.background = '#127A48'; });
        useBtn.addEventListener('mouseleave', () => { useBtn.style.background = '#1FA463'; });
      });

      // Hover effect on rows
      content.querySelectorAll('.og-rephrase-item').forEach((row) => {
        const r = row as HTMLElement;
        r.addEventListener('mouseenter', () => { r.style.background = '#f9fafb'; r.style.borderColor = '#d1d5db'; });
        r.addEventListener('mouseleave', () => { r.style.background = 'white'; r.style.borderColor = '#e5e7eb'; });
      });
      repositionPanel();

    } catch (err) {
      content.innerHTML = `
        <div style="padding:16px;text-align:center;font-size:13px;color:#dc2626;">
          Failed to get suggestions. Check your API key and connection.
        </div>
      `;
      repositionPanel();
    }
  }

}

function decodeHtmlEntities(str: string): string {
  const d = document.createElement('div');
  d.innerHTML = str;
  return d.textContent || '';
}

/* ────────────────────────────────────────────────────────────
   SPELL CHECK REVIEW PANEL
   Shows spelling issues one-by-one with full sentence context,
   Fix This / Fix All Spelling / Skip navigation.
──────────────────────────────────────────────────────────── */

function getFullText(element: HTMLElement): string {
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    return (element as HTMLInputElement | HTMLTextAreaElement).value;
  }
  return element.textContent || '';
}

interface SentenceGroup {
  start: number;
  end: number;
  issues: Issue[];
  /** Whole-sentence original/corrected (LLM pivot path). */
  origText?: string;
  corrText?: string;
}

function isProtectedOffset(index: number, spans: ProtectedSpan[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function isSentenceBoundaryAt(text: string, index: number, spans: ProtectedSpan[]): boolean {
  const ch = text[index];
  if (ch === '\n') return true;
  return (ch === '.' || ch === '!' || ch === '?') && !isProtectedOffset(index, spans);
}

/** Split text into sentences, keeping each one's start offset. */
function splitSentences(s: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const protectedSpans = findProtectedSpans(s);
  let start = 0;

  const push = (end: number) => {
    const text = s.slice(start, end);
    if (text.trim().length > 0) out.push({ start, end, text });
    start = end;
  };

  for (let i = 0; i < s.length; i++) {
    if (!isSentenceBoundaryAt(s, i, protectedSpans)) continue;
    push(i + 1);
  }

  if (start < s.length) push(s.length);
  return out;
}

/**
 * Build review groups by diffing the original text against the LLM's
 * whole-text correction — one coherent rewrite, no offset-merging of
 * fragments. Pairs sentences by index; if the counts diverge (the model
 * merged/split sentences) it falls back to one whole-text group so we
 * never mis-pair and corrupt.
 */
function buildGroupsFromCorrection(original: string, corrected: string): SentenceGroup[] {
  const norm = (x: string) => x.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (norm(original) === norm(corrected)) return [];

  const o = splitSentences(original);
  const c = splitSentences(corrected);
  if (o.length === c.length && o.length > 0) {
    const groups: SentenceGroup[] = [];
    for (let i = 0; i < o.length; i++) {
      const ot = o[i]!.text.trim();
      const ct = c[i]!.text.trim();
      if (norm(ot) === norm(ct)) continue;
      groups.push({ start: o[i]!.start, end: o[i]!.end, issues: [], origText: ot, corrText: ct });
    }
    if (groups.length) return groups;
  }
  // Counts diverged → single whole-text group (still coherent).
  return [{ start: 0, end: original.length, issues: [], origText: original.trim(), corrText: corrected.trim() }];
}

/** Offline/no-LLM fallback: apply ONLY spelling fixes per sentence (safe,
 *  deterministic, single-word). Grammar needs the LLM, so it's left alone
 *  rather than risk the old fragment-merge garble. */
function buildSpellingOnlyGroups(text: string, allIssues: Issue[]): SentenceGroup[] {
  const spelling = allIssues.filter((i) => i.type === 'spelling' && !i.ignored && i.route === 'quick-fix');
  const base = getSentenceGroups(text, spelling);
  for (const g of base) {
    g.origText = text.slice(g.start, g.end).trim();
    let s = text.slice(g.start, g.end);
    for (const iss of [...g.issues].sort((a, b) => b.offset - a.offset)) {
      const rel = iss.offset - g.start;
      if (rel < 0 || rel + iss.length > s.length) continue;
      if (s.substr(rel, iss.length) !== iss.original) continue;
      s = s.slice(0, rel) + iss.suggestion + s.slice(rel + iss.length);
    }
    g.corrText = s.trim();
  }
  return base.filter((g) => g.origText !== g.corrText);
}

/**
 * Group fixable issues by the sentence they fall in, so corrections can be
 * reviewed and accepted a whole sentence at a time instead of word-by-word.
 */
function getSentenceGroups(text: string, issues: Issue[]): SentenceGroup[] {
  // Re-validate every issue against the CURRENT text. If the text changed since
  // analysis (e.g. the user just accepted a fix), a stale offset would splice
  // the suggestion at the wrong place and garble the sentence ("haven't" ->
  // "havenn't"). resolveInString drops issues that no longer match and rebases
  // ones that merely shifted, so the panel only ever shows valid corrections.
  const fixable = issues
    .filter(i => !i.ignored && i.suggestion !== i.original)
    .map((i) => {
      const span = resolveInString(text, i.offset, i.length, i.original);
      if (!span) return null;
      return { ...i, offset: span.start, length: span.end - span.start };
    })
    .filter((i): i is Issue => i !== null)
    .sort((a, b) => a.offset - b.offset);

  const groups: SentenceGroup[] = [];
  const protectedSpans = findProtectedSpans(text);
  for (const issue of fixable) {
    let s = issue.offset;
    while (s > 0) {
      if (isSentenceBoundaryAt(text, s - 1, protectedSpans)) break;
      s--;
    }
    while (s < issue.offset && (text[s] === ' ' || text[s] === '\n')) s++;

    let e = issue.offset + issue.length;
    while (e < text.length) {
      if (isSentenceBoundaryAt(text, e, protectedSpans)) { e++; break; }
      e++;
    }

    const last = groups[groups.length - 1];
    if (last && s < last.end && last.start < e) {
      last.start = Math.min(last.start, s);
      last.end = Math.max(last.end, e);
      last.issues.push(issue);
    } else {
      groups.push({ start: s, end: e, issues: [issue] });
    }
  }
  return groups;
}

function typeColorLine(type: string): string {
  return getC(type).line;
}

/**
 * Render a sentence as HTML with each issue span marked with a wavy underline.
 * Offsets in `issues` are absolute; `sentenceStart` maps them into the slice.
 */
function renderMarkedSentence(text: string, group: SentenceGroup): string {
  const sentence = text.slice(group.start, group.end);
  const spans = [...group.issues].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  let html = '';
  for (const issue of spans) {
    const rel = Math.max(0, issue.offset - group.start);
    const relEnd = Math.min(sentence.length, issue.offset + issue.length - group.start);
    if (relEnd <= rel) continue;
    if (rel > cursor) html += escapeHtml(sentence.slice(cursor, rel));
    const line = typeColorLine(issue.type);
    html += `<mark style="background:${line}14;border-radius:3px;padding:0 1px;text-decoration:underline;text-decoration-style:wavy;text-decoration-color:${line};color:#b91c1c;font-style:normal;font-weight:600;">${escapeHtml(sentence.slice(rel, relEnd))}</mark>`;
    cursor = relEnd;
  }
  if (cursor < sentence.length) html += escapeHtml(sentence.slice(cursor));
  return html.trim();
}

/** Build the corrected sentence string by applying the group's fixes. */
function buildCorrectedSentence(text: string, group: SentenceGroup): string {
  let sentence = text.slice(group.start, group.end);
  const ordered = [...group.issues].sort((a, b) => b.offset - a.offset);
  for (const issue of ordered) {
    const rel = issue.offset - group.start;
    const relEnd = rel + issue.length;
    if (rel < 0 || relEnd > sentence.length) continue;
    sentence = sentence.slice(0, rel) + issue.suggestion + sentence.slice(relEnd);
  }
  return sentence.trim();
}

function showCheckingCard(element: HTMLElement) {
  uiActive = true;
  currentTooltip?.remove();
  injectStyles();
  const card = document.createElement('div');
  card.className = 'opengrammar-tooltip';
  card.style.cssText = `
    position: fixed; left:-9999px; top:-9999px; width: 300px;
    background:#fff; border-radius:12px; border:1px solid rgba(0,0,0,0.07);
    box-shadow:0 4px 32px rgba(0,0,0,0.14); z-index:2147483647;
    font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation: og-fade-in 0.12s ease;
  `;
  card.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; padding:16px 18px;">
      <div style="width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#1FA463;border-radius:50%;animation:og-spin 0.7s linear infinite;"></div>
      <div>
        <div class="og-checking-primary" style="font-size:13px; color:#3c3c43; font-weight:600;">Checking your writing…</div>
        <div class="og-checking-secondary" style="font-size:11px; color:#8e8e93; margin-top:3px; display:none;"></div>
      </div>
    </div>`;
  document.body.appendChild(card);
  const anchorEl = overlayTarget && overlayTarget.isConnected ? overlayTarget : element;
  placeFixedPanel(card, anchorEl.getBoundingClientRect(), 8);
  currentTooltip = card;
  return card;
}

function updateCheckingCard(card: HTMLElement | null, primary: string, secondary = '') {
  if (!card || !card.isConnected) return;
  const p = card.querySelector('.og-checking-primary') as HTMLElement | null;
  const s = card.querySelector('.og-checking-secondary') as HTMLElement | null;
  if (p) p.textContent = primary;
  if (s) {
    s.textContent = secondary;
    s.style.display = secondary ? 'block' : 'none';
  }
}

function showReviewStatusCard(
  element: HTMLElement,
  title: string,
  message: string,
  retry?: () => void,
  options?: { modelHint?: boolean },
) {
  uiActive = true;
  currentTooltip?.remove();
  injectStyles();

  const card = document.createElement('div');
  card.className = 'opengrammar-tooltip';
  card.style.cssText = `
    position: fixed; left:-9999px; top:-9999px; width: 334px;
    background:#fff; border-radius:12px; border:1px solid rgba(0,0,0,0.07);
    box-shadow:0 4px 32px rgba(0,0,0,0.14); z-index:2147483647;
    font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation: og-fade-in 0.12s ease;
    overflow:hidden;
  `;
  card.innerHTML = `
    <div style="padding:14px 16px 12px; border-bottom:1px solid #f0f0f0;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:7px;">
        <span style="width:8px; height:8px; border-radius:50%; background:#f59e0b; flex-shrink:0;"></span>
        <span style="font-size:12px; font-weight:700; color:#92400e; text-transform:uppercase; letter-spacing:0.5px;">${escapeHtml(title)}</span>
      </div>
      <div style="font-size:13px; color:#3c3c43; line-height:1.45;">${escapeHtml(message)}</div>
      <div class="og-model-hint-slot" style="display:none;"></div>
    </div>
    <div style="display:flex; border-top:1px solid #f0f0f0;">
      ${retry ? `<button class="og-review-retry" type="button" style="
        flex:1; padding:11px 14px; background:#1FA463; color:#fff;
        border:none; cursor:pointer; font-size:13px; font-weight:700; font-family:inherit;
      ">Retry</button>` : ''}
      <button class="og-review-close" type="button" style="
        flex:1; padding:11px 14px; background:#fff; color:#5f6368;
        border:none; ${retry ? 'border-left:1px solid #f0f0f0;' : ''}
        cursor:pointer; font-size:13px; font-weight:600; font-family:inherit;
      ">Close</button>
    </div>
  `;

  card.addEventListener('mousedown', (e) => e.preventDefault());
  const retryBtn = card.querySelector('.og-review-retry') as HTMLButtonElement | null;
  retryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    retry?.();
  });
  const closeBtn = card.querySelector('.og-review-close') as HTMLButtonElement | null;
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTooltip();
  });
  document.body.appendChild(card);
  const anchorEl = overlayTarget && overlayTarget.isConnected ? overlayTarget : element;
  placeFixedPanel(card, anchorEl.getBoundingClientRect(), 8);
  currentTooltip = card;
  if (options?.modelHint) void maybeShowModelHint(card, anchorEl);
}

function isSubstantialContextText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= 8;
}

async function shouldShowModelHint(): Promise<boolean> {
  if (modelHintShownThisSession) return false;
  const stored = await new Promise<Record<string, unknown>>((res) =>
    chrome.storage.sync.get(['provider', 'hideModelHint'], (r) => res(r as Record<string, unknown>))
  );
  if (stored.hideModelHint === true) return false;

  const provider = typeof stored.provider === 'string' ? stored.provider : 'openai';
  const apiKey = await getApiKey();
  if (apiKey && provider !== 'ollama') return false;
  return provider === 'ollama' || !apiKey;
}

async function maybeShowModelHint(card: HTMLElement, anchorEl: HTMLElement) {
  if (!(await shouldShowModelHint())) return;
  if (!card.isConnected) return;
  const slot = card.querySelector('.og-model-hint-slot') as HTMLElement | null;
  if (!slot) return;

  modelHintShownThisSession = true;
  slot.style.display = 'block';
  slot.style.marginTop = '10px';
  slot.style.padding = '9px 10px';
  slot.style.border = '1px solid #A7E0C2';
  slot.style.borderRadius = '7px';
  slot.style.background = '#E7F4EC';
  slot.style.color = '#127A48';
  slot.style.fontSize = '12px';
  slot.style.lineHeight = '1.45';
  slot.innerHTML = `
    <div style="display:flex; gap:8px; align-items:flex-start;">
      <div style="flex:1;">
        For context-aware suggestions (e.g. loose vs lose), a stronger cloud model like DeepSeek is more reliable than the local model.
        <a href="${MODEL_BENCHMARK_URL}" target="_blank" rel="noreferrer" style="color:#127A48; font-weight:700; text-decoration:underline;">See benchmark results</a>.
      </div>
      <button class="og-model-hint-dismiss" type="button" style="
        flex-shrink:0; border:none; background:transparent; color:#1FA463;
        font-size:11px; font-weight:700; cursor:pointer; padding:1px 0 0 4px;
        font-family:inherit;
      ">Dismiss</button>
    </div>
  `;
  const dismiss = slot.querySelector('.og-model-hint-dismiss') as HTMLButtonElement | null;
  dismiss?.addEventListener('click', (e) => {
    e.stopPropagation();
    void chrome.storage.sync.set({ hideModelHint: true });
    slot.remove();
    placeFixedPanel(card, anchorEl.getBoundingClientRect(), 8);
  });
  placeFixedPanel(card, anchorEl.getBoundingClientRect(), 8);
}

function showSentenceReview(
  allIssues: Issue[],
  element: HTMLElement,
  groupIndex: number,
  precomputed?: SentenceGroup[],
) {
  uiActive = true;
  currentTooltip?.remove();
  currentRephrasePanel?.remove();
  currentRephrasePanel = null;
  injectStyles();

  // Quote-stripped source (length-preserving, so offsets still map to DOM).
  const text = stripQuotedBBCode(getFullText(element));

  // PIVOT: the corrected sentence comes from ONE coherent LLM rewrite of the
  // whole text (errors-only), then diffed — never an offset-merge of rule
  // fragments. Rule engine now only drives inline spelling underlines.
  if (!precomputed) {
    const proceed = (corrected: string, llm: boolean): boolean => {
      const changed = (corrected || '').trim() !== text.trim();
      const g =
        llm && changed
          ? buildGroupsFromCorrection(text, corrected)
          : buildSpellingOnlyGroups(text, allIssues);
      if (g.length === 0) return false;
      showSentenceReview(allIssues, element, 0, g);
      return true;
    };
    const cached = correctionCache.get(text);
    if (cached !== undefined) {
      const shown = proceed(cached, cached.trim() !== text.trim());
      if (!shown) {
        showReviewStatusCard(
          element,
          'No sentence change',
          'The model did not find a confident sentence-level correction. Local underlines will remain available where a quick fix is safe.',
          undefined,
          { modelHint: isSubstantialContextText(text) },
        );
      }
      return;
    }
    const checkingCard = showCheckingCard(element);
    const slowTimer = window.setTimeout(() => {
      updateCheckingCard(
        checkingCard,
        'Loading the local model…',
        'The first Ollama request can take a bit while the model enters memory.',
      );
    }, 3500);
    const verySlowTimer = window.setTimeout(() => {
      updateCheckingCard(
        checkingCard,
        'Still waiting for Ollama…',
        'Keep this open. If it fails, you will get a retry button instead of losing the panel.',
      );
    }, 20000);
    chrome.runtime.sendMessage({ type: 'CORRECT_TEXT', text }, (resp) => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(verySlowTimer);
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        showReviewStatusCard(
          element,
          'Model response failed',
          runtimeError,
          () => showSentenceReview(allIssues, element, 0),
        );
        return;
      }
      if (!resp) {
        showReviewStatusCard(
          element,
          'No model response',
          'OGrammar did not receive a response from the configured model.',
          () => showSentenceReview(allIssues, element, 0),
        );
        return;
      }
      const corrected = (resp && resp.corrected) || text;
      const llm = !!(resp && resp.llm);
      if (llm && corrected.trim() !== text.trim()) correctionCache.set(text, corrected);
      const shown = proceed(corrected, llm);
      if (!shown && resp?.error) {
        showReviewStatusCard(
          element,
          'Correction failed',
          String(resp.error),
          () => showSentenceReview(allIssues, element, 0),
        );
        return;
      }
      if (!shown) {
        showReviewStatusCard(
          element,
          'No sentence change',
          'The model did not find a confident sentence-level correction. Local underlines will remain available where a quick fix is safe.',
          undefined,
          { modelHint: isSubstantialContextText(text) },
        );
      }
    });
    return;
  }

  const groups = precomputed;
  if (groups.length === 0) { hideTooltip(); return; }
  const idx = Math.max(0, Math.min(groupIndex, groups.length - 1));
  const group = groups[idx]!;
  const total = groups.length;
  const isFirst = idx === 0;
  const isLast  = idx >= total - 1;

  const origText = (group.origText ?? text.slice(group.start, group.end)).trim();
  const corrText = (group.corrText ?? origText).trim();
  const diffNonEq = diffWords(origText, corrText).filter((o) => o.kind !== 'eq');
  const changeCount   = Math.max(1, Math.ceil(diffNonEq.length / 2));
  const totalFixes    = groups.length;
  const typeSummary   = summarizeChange(origText, corrText) || '';
  const correctedText = corrText;
  const correctedHtml = renderCorrectedWithChangesHTML(origText, correctedText);
  const changeListHtml = `<div style="font-size:13px; line-height:1.6; word-break:break-word;">${renderInlineDiffHTML(origText, corrText)}</div>`;

  const card = document.createElement('div');
  card.className = 'opengrammar-tooltip';
  card.style.cssText = `
    position: fixed;
    left: -9999px; top: -9999px;
    width: 360px;
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.14), 0 1px 6px rgba(0,0,0,0.07);
    z-index: 2147483647;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid rgba(0,0,0,0.07);
    animation: og-fade-in 0.12s ease;
  `;

  card.innerHTML = `
    <!-- Header: progress + nav arrows -->
    <div style="
      padding: 11px 14px 9px;
      display:flex; align-items:center; justify-content:space-between;
      border-bottom: 1px solid #f0f0f0;
      background: #fafafa;
    ">
      <div style="display:flex; align-items:center; gap:9px;">
        <span style="
          display:inline-flex; align-items:center; justify-content:center;
          width:28px; height:28px; border-radius:50%;
          background:#1FA46318; flex-shrink:0;
        ">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#1FA463" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 11.5 11 2.5l2.5 2.5L4.5 14H2z"/><path d="M9.5 4 12 6.5"/>
          </svg>
        </span>
        <div>
          <div style="font-size:12px; font-weight:600; color:#1FA463; text-transform:uppercase; letter-spacing:0.5px;">Sentence ${idx + 1} of ${total}</div>
          <div style="font-size:11px; color:#8e8e93;">${changeCount} change${changeCount !== 1 ? 's' : ''}${typeSummary ? ' · ' + escapeHtml(typeSummary) : ''}</div>
        </div>
      </div>
      ${total > 1 ? `
      <div style="display:flex; gap:4px; align-items:center;">
        <button class="og-sr-prev" style="
          width:28px; height:28px;
          display:flex; align-items:center; justify-content:center;
          background:white; border:1px solid #e5e5ea; border-radius:7px;
          cursor:${isFirst ? 'default' : 'pointer'};
          opacity:${isFirst ? '0.3' : '1'};
          font-size:16px; color:#3c3c43; line-height:1;
        ">‹</button>
        <button class="og-sr-next" style="
          width:28px; height:28px;
          display:flex; align-items:center; justify-content:center;
          background:white; border:1px solid #e5e5ea; border-radius:7px;
          cursor:${isLast ? 'default' : 'pointer'};
          opacity:${isLast ? '0.3' : '1'};
          font-size:16px; color:#3c3c43; line-height:1;
        ">›</button>
      </div>` : ''}
    </div>

    <!-- Original sentence. In mechanical mode the words that will change
         get a whole-word amber highlight so the user sees what's flagged
         at a glance. In tone mode (a whole-sentence LLM rewrite) the
         highlights are removed — token-level diff against a re-written
         sentence is noise, not signal. -->
    <div style="padding: 11px 14px 9px;">
      <div style="font-size:10px; color:#8e8e93; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:5px;">Original sentence</div>
      <div class="og-sr-original-text" style="
        font-size:13px; color:#3c3c43; line-height:1.6; word-break:break-word;
        background:#fff7f7; border:1px solid #ffe0e0; border-radius:7px; padding:8px 10px;
      ">${renderOriginalWithChangesHTML(origText, correctedText)}</div>
    </div>

    <!-- Corrected sentence — the single preview surface. The updated text
         is highlighted directly here too, so punctuation, capitalization,
         inserted words, and replacements are visible before expanding the
         diff details. -->
    <div class="og-sr-accept-box" style="padding: 0 14px 10px; cursor:pointer;">
      <div class="og-sr-corrected-label" style="font-size:10px; color:#8e8e93; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:5px;">Corrected sentence</div>
      <div class="og-sr-corrected-text" style="
        font-size:13px; color:#1c1c1e; line-height:1.6; word-break:break-word; font-weight:500;
        background:#E7F4EC; border:1px solid #A7E0C2; border-radius:7px; padding:8px 10px;
        transition:background 0.12s;
      ">${correctedHtml}</div>
    </div>

    <!-- Per-change breakdown (diff vs original — also updates with tone) -->
    <details style="border-top:1px solid #f0f0f0;">
      <summary style="
        padding:8px 14px; cursor:pointer; font-size:12px; color:#5f6368;
        font-weight:600; list-style:none; user-select:none;
      ">View the change${changeCount !== 1 ? 's' : ''}</summary>
      <div class="og-sr-changes" style="padding:2px 14px 10px;">${changeListHtml}</div>
    </details>

    <!-- Improve / tone rewrite — clicking a chip swaps the Corrected box
         above. No separate preview / Apply / Cancel chrome. -->
    <div class="og-sr-improve" style="border-top:1px solid #f0f0f0; padding:9px 14px;">
      <button class="og-sr-improve-toggle" type="button" style="
        width:100%; display:flex; align-items:center; justify-content:center; gap:6px;
        background:#fff; border:1px solid #e5e5ea; border-radius:7px; padding:7px 10px;
        font-size:12px; font-weight:600; color:#1FA463; cursor:pointer; font-family:inherit;
        transition:background 0.12s;
      ">✦ Improve sentence ▾</button>
      <div class="og-sr-improve-menu" style="display:none; flex-wrap:wrap; gap:6px; margin-top:8px;"></div>
      <div class="og-sr-improve-status" style="display:none; font-size:11px; color:#8e8e93; margin-top:7px; text-align:center;"></div>
    </div>

    <!-- Action buttons (sticky so they stay reachable when the card scrolls).
         Original reverts a tone preview back to the mechanical correction;
         it stays disabled until the user has picked a tone. -->
    <div style="display:flex; border-top:1px solid #f0f0f0; position:sticky; bottom:0; background:#ffffff; z-index:1;">
      ${total > 1 ? `
      <button class="og-sr-fix-all" style="
        flex:1; padding:10px 8px;
        background:white; color:#1FA463;
        border:none; border-right:1px solid #f0f0f0; cursor:pointer;
        font-size:11px; font-weight:700; line-height:1.35;
        font-family:inherit; transition:background 0.12s;
      ">Fix All<br><span style="font-weight:400; color:#8e8e93;">${totalFixes} sentence${totalFixes !== 1 ? 's' : ''}</span></button>` : ''}
      <button class="og-sr-original" disabled style="
        flex:1; padding:11px 8px;
        background:white; color:#5f6368;
        border:none; border-right:1px solid #f0f0f0;
        cursor:not-allowed; opacity:0.4;
        font-size:12px; font-weight:600;
        border-radius:0 0 0 ${total > 1 ? '0' : '12px'};
        font-family:inherit; transition:opacity 0.12s, background 0.12s;
      " title="Revert to the original correction (undo tone rewrite)">Original</button>
      <button class="og-sr-accept" style="
        flex:2; padding:11px 10px;
        background:#1FA463; color:white;
        border:none; cursor:pointer;
        font-size:13px; font-weight:600;
        font-family:inherit; transition:background 0.12s;
        display:flex; align-items:center; justify-content:center; gap:5px;
      ">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="white">
          <path d="M6.5 11.5L2.5 7.5l1.06-1.06 2.94 2.93 5.94-5.93 1.06 1.06z"/>
        </svg>
        Accept Sentence
      </button>
      <button class="og-sr-skip" style="
        flex:1; padding:11px 10px;
        background:white; color:#5f6368;
        border:none; border-left:1px solid #f0f0f0;
        cursor:pointer;
        font-size:13px; font-weight:500;
        border-radius:0 0 12px 0;
        font-family:inherit; transition:background 0.12s;
      ">Skip</button>
    </div>
  `;

  card.addEventListener('mousedown', (e) => e.preventDefault());

  const anchorEl = (overlayTarget && overlayTarget.isConnected ? overlayTarget : element);
  const repositionSentenceCard = () => {
    if (!card.isConnected) return;
    placeFixedPanel(card, anchorEl.getBoundingClientRect(), 8);
  };

  // currentText is what's shown in the Corrected box and what Accept applies.
  // Starts as the mechanical Harper correction; a tone chip swaps it; the
  // Original button restores it.
  let currentText = corrText;
  let currentLabel: string | null = null;

  const labelEl    = card.querySelector('.og-sr-corrected-label') as HTMLElement | null;
  const textEl     = card.querySelector('.og-sr-corrected-text') as HTMLElement | null;
  const originalEl = card.querySelector('.og-sr-original-text') as HTMLElement | null;
  const changesEl  = card.querySelector('.og-sr-changes') as HTMLElement | null;

  const setBusy = (busy: boolean) => {
    if (textEl) textEl.style.opacity = busy ? '0.55' : '1';
  };

  const refreshCorrectedBox = () => {
    const inToneMode = currentLabel !== null;
    if (labelEl) {
      labelEl.textContent = inToneMode
        ? `Corrected sentence · ${currentLabel}`
        : 'Corrected sentence';
    }
    if (textEl) textEl.innerHTML = renderCorrectedWithChangesHTML(origText, currentText);
    if (originalEl) {
      originalEl.innerHTML = inToneMode
        ? escapeHtml(origText)
        : renderOriginalWithChangesHTML(origText, currentText);
    }
    // View-the-changes panel keeps the detailed inline diff for users
    // who want to inspect every shift; it's hidden behind a click so
    // its noise stays out of the default view.
    if (changesEl) changesEl.innerHTML = renderInlineDiffHTML(origText, currentText);
    const originalBtn = card.querySelector('.og-sr-original') as HTMLButtonElement | null;
    if (originalBtn) {
      const isOriginal = currentLabel === null;
      originalBtn.disabled = isOriginal;
      originalBtn.style.opacity = isOriginal ? '0.4' : '1';
      originalBtn.style.cursor = isOriginal ? 'not-allowed' : 'pointer';
    }
  };

  const acceptSentence = async () => {
    const apply = currentText;
    const ok = await replaceSentence(element, origText, group.start, apply);
    // A stale span (text edited since analysis) or a framework that reverted the
    // insert returns false. Don't advance/close as if it worked — keep the card
    // open and surface the failure so it isn't silent.
    if (!ok) {
      flashApplyFailure(card);
      return;
    }
    // Shift later groups by the length delta so their spans stay anchored.
    const delta = apply.length - origText.length;
    if (delta !== 0) {
      for (let g = idx + 1; g < groups.length; g++) {
        groups[g]!.start += delta;
        groups[g]!.end += delta;
      }
    }
    groups.splice(idx, 1);
    if (groups.length === 0) { hideTooltip(); return; }
    showSentenceReview(allIssues, element, Math.min(idx, groups.length - 1), groups);
  };

  // Original button: revert any tone preview back to the mechanical correction.
  const originalBtnEl = card.querySelector('.og-sr-original') as HTMLButtonElement | null;
  if (originalBtnEl) {
    originalBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentLabel === null) return;
      currentText = corrText;
      currentLabel = null;
      refreshCorrectedBox();
    });
    originalBtnEl.addEventListener('mouseenter', () => {
      if (!originalBtnEl.disabled) originalBtnEl.style.background = '#f8f9fa';
    });
    originalBtnEl.addEventListener('mouseleave', () => { originalBtnEl.style.background = 'white'; });
  }

  const acceptBox = card.querySelector('.og-sr-accept-box') as HTMLElement | null;
  const correctedInner = acceptBox?.firstElementChild?.nextElementSibling as HTMLElement | undefined;
  if (acceptBox) {
    acceptBox.addEventListener('click', (e) => { e.stopPropagation(); acceptSentence(); });
    acceptBox.addEventListener('mouseenter', () => { if (correctedInner) correctedInner.style.background = '#D6ECDD'; });
    acceptBox.addEventListener('mouseleave', () => { if (correctedInner) correctedInner.style.background = '#E7F4EC'; });
  }

  const acceptBtn = card.querySelector('.og-sr-accept') as HTMLButtonElement | null;
  if (acceptBtn) {
    acceptBtn.addEventListener('click', (e) => { e.stopPropagation(); acceptSentence(); });
    acceptBtn.addEventListener('mouseenter', () => { acceptBtn.style.background = '#127A48'; });
    acceptBtn.addEventListener('mouseleave', () => { acceptBtn.style.background = '#1FA463'; });
  }

  const fixAllBtn = card.querySelector('.og-sr-fix-all') as HTMLButtonElement | null;
  if (fixAllBtn) {
    fixAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Apply highest-offset first so earlier spans stay valid.
      const ordered = [...groups].sort((a, b) => b.start - a.start);
      const total = ordered.length;
      const failed: typeof groups = [];
      for (const g of ordered) {
        const ok = await replaceSentence(element, (g.origText ?? '').trim(), g.start, (g.corrText ?? '').trim());
        // A stale span / silently-reverted insert returns false. Collect it so
        // we don't close the card claiming every sentence was fixed.
        if (!ok) failed.push(g);
      }
      if (failed.length === 0) {
        hideTooltip();
        return;
      }
      // Some (or all) sentences didn't land. Keep the card open showing only the
      // ones that failed, and surface why instead of closing silently.
      const allFailed = failed.length === total;
      groups.splice(0, groups.length, ...failed.sort((a, b) => a.start - b.start));
      showSentenceReview(allIssues, element, 0, groups);
      const liveCard = currentTooltip;
      if (liveCard) {
        flashApplyFailure(
          liveCard,
          allFailed
            ? "Couldn't apply here — text changed"
            : "Couldn't apply some — text changed",
        );
      }
    });
    fixAllBtn.addEventListener('mouseenter', () => { fixAllBtn.style.background = '#D6ECDD'; });
    fixAllBtn.addEventListener('mouseleave', () => { fixAllBtn.style.background = 'white'; });
  }

  const skipBtn = card.querySelector('.og-sr-skip') as HTMLButtonElement | null;
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isLast) showSentenceReview(allIssues, element, idx + 1, groups);
      else hideTooltip();
    });
    skipBtn.addEventListener('mouseenter', () => { skipBtn.style.background = '#f8f9fa'; });
    skipBtn.addEventListener('mouseleave', () => { skipBtn.style.background = 'white'; });
  }

  const prevBtn = card.querySelector('.og-sr-prev') as HTMLButtonElement | null;
  if (prevBtn && !isFirst) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSentenceReview(allIssues, element, idx - 1, groups);
    });
  }

  const nextBtn = card.querySelector('.og-sr-next') as HTMLButtonElement | null;
  if (nextBtn && !isLast) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSentenceReview(allIssues, element, idx + 1, groups);
    });
  }

  // ── Improve: explicit, on-demand tone rewrite of THIS sentence ──────────
  // Whole-sentence LLM rewrite (the locked product model: tone/style is an
  // explicit button, never inline/automatic). Applied via the same
  // replaceSentence primitive as Accept.
  const improveToggle = card.querySelector('.og-sr-improve-toggle') as HTMLButtonElement | null;
  const improveMenu = card.querySelector('.og-sr-improve-menu') as HTMLElement | null;
  const improveStatus = card.querySelector('.og-sr-improve-status') as HTMLElement | null;
  if (improveToggle && improveMenu && improveStatus) {
    for (const [tone, label] of TONES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.tone = tone;
      chip.textContent = label;
      chip.style.cssText = `
        flex:1 1 auto; min-width:72px; padding:6px 8px;
        background:#E7F4EC; color:#1FA463; border:1px solid #A7E0C2;
        border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;
        font-family:inherit; transition:background 0.12s;
      `;
      chip.addEventListener('mouseenter', () => { chip.style.background = '#D6ECDD'; });
      chip.addEventListener('mouseleave', () => { chip.style.background = '#E7F4EC'; });
      improveMenu.appendChild(chip);
    }

    let busy = false;

    const setStatus = (msg: string) => {
      if (!msg) { improveStatus.style.display = 'none'; improveStatus.textContent = ''; return; }
      improveStatus.style.display = 'block';
      improveStatus.style.textAlign = 'center';
      improveStatus.textContent = msg;
    };

    improveToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = improveMenu.style.display !== 'none';
      improveMenu.style.display = open ? 'none' : 'flex';
      improveToggle.textContent = open ? '✦ Improve sentence ▾' : '✦ Improve sentence ▴';
      if (open) setStatus('');
      if (!open) {
        requestAnimationFrame(() => {
          repositionSentenceCard();
          improveMenu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
    });
    improveToggle.addEventListener('mouseenter', () => { improveToggle.style.background = '#E7F4EC'; });
    improveToggle.addEventListener('mouseleave', () => { improveToggle.style.background = '#fff'; });

    // Tone chip click: fetch the rewrite and swap the Corrected box content
    // in place. The footer Original button (handled outside this block) is
    // what reverts; there is no separate Apply / Cancel step any more.
    improveMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = (e.target as HTMLElement).closest('[data-tone]') as HTMLElement | null;
      if (!chip || busy) return;
      const tone = chip.dataset.tone!;
      const label = chip.textContent || tone;
      busy = true;
      setBusy(true);
      improveMenu.style.pointerEvents = 'none';
      improveMenu.style.opacity = '0.5';
      setStatus(`Rewriting (${label})…`);
      chrome.runtime.sendMessage(
        { type: 'REWRITE_TEXT', text: origText, tone },
        (resp) => {
          busy = false;
          setBusy(false);
          improveMenu.style.pointerEvents = '';
          improveMenu.style.opacity = '';
          const rewritten = resp && resp.rewritten ? String(resp.rewritten).trim() : '';
          if (!rewritten || rewritten === origText) {
            setStatus(resp && resp.error
              ? 'Rewrite failed — check provider/API key.'
              : 'No change suggested.');
            return;
          }
          currentText = rewritten;
          currentLabel = label;
          refreshCorrectedBox();
          setStatus('');
          requestAnimationFrame(repositionSentenceCard);
          // Scroll the (now updated) Corrected box back into view so the
          // user sees the swap.
          if (textEl) requestAnimationFrame(() =>
            textEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        },
      );
    });
  }

  const closeOnOutsideClick = (e: MouseEvent) => {
    if (!card.contains(e.target as Node)) {
      hideTooltip();
      document.removeEventListener('click', closeOnOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 100);

  document.body.appendChild(card);
  // Anchor the panel to the editor (not the viewport corner) so it sits
  // right by the text box; placeFixedPanel keeps it fully on-screen.
  repositionSentenceCard();
  currentTooltip = card;
}

/* ────────────────────────────────────────────────────────────
   INPUT / TEXTAREA MEASUREMENT MIRROR (geometry only — never visible,
   never recolors the field). Used by renderInputUnderlines().
──────────────────────────────────────────────────────────── */
function copyTypographyStyles(element: HTMLElement, overlay: HTMLElement, content: HTMLElement) {
  const styles = window.getComputedStyle(element);
  const target = element as HTMLInputElement | HTMLTextAreaElement;
  const rect   = element.getBoundingClientRect();
  overlay.style.left   = `${rect.left}px`;
  overlay.style.top    = `${rect.top}px`;
  overlay.style.width  = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.borderRadius = styles.borderRadius;
  overlay.style.boxSizing = styles.boxSizing;
  overlay.style.borderTopWidth = styles.borderTopWidth;
  overlay.style.borderRightWidth = styles.borderRightWidth;
  overlay.style.borderBottomWidth = styles.borderBottomWidth;
  overlay.style.borderLeftWidth = styles.borderLeftWidth;
  overlay.style.borderTopStyle = styles.borderTopStyle;
  overlay.style.borderRightStyle = styles.borderRightStyle;
  overlay.style.borderBottomStyle = styles.borderBottomStyle;
  overlay.style.borderLeftStyle = styles.borderLeftStyle;
  content.style.font          = styles.font;
  content.style.fontFamily    = styles.fontFamily;
  content.style.fontSize      = styles.fontSize;
  content.style.fontWeight    = styles.fontWeight;
  content.style.lineHeight    = styles.lineHeight;
  content.style.letterSpacing = styles.letterSpacing;
  content.style.wordSpacing   = styles.wordSpacing;
  content.style.textTransform = styles.textTransform;
  content.style.textAlign     = styles.textAlign;
  content.style.textIndent    = styles.textIndent;
  content.style.direction     = styles.direction;
  content.style.tabSize       = styles.tabSize;
  content.style.whiteSpace    = element.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
  content.style.padding       = styles.padding;
  content.style.color         = target.dataset.ogOriginalColor || styles.color;
}

function positionInputMirror(element: HTMLElement) {
  if (!inputMirrorOverlay) return;
  const rect = element.getBoundingClientRect();
  inputMirrorOverlay.style.left   = `${rect.left}px`;
  inputMirrorOverlay.style.top    = `${rect.top}px`;
  inputMirrorOverlay.style.width  = `${rect.width}px`;
  inputMirrorOverlay.style.height = `${rect.height}px`;
}

function syncInputMirrorScroll(element: HTMLElement) {
  if (!inputMirrorContent) return;
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  inputMirrorContent.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
}

function destroyInputMirror() {
  cleanupInputMirror?.(); cleanupInputMirror = null;
  inputMirrorOverlay?.remove(); inputMirrorOverlay = null;
  inputMirrorContent = null; inputMirrorTarget = null;
}

/* ────────────────────────────────────────────────────────────
   APPLY / IGNORE / HIDE
──────────────────────────────────────────────────────────── */
function hideTooltip() {
  currentTooltip?.remove(); currentTooltip = null;
  uiActive = false;
}

/**
 * Surface a failed apply on the suggestion card itself. The apply primitive
 * returns false when the span is stale or a framework silently reverted the
 * insert; without this the card would close as if it succeeded and the failure
 * would be invisible. Shows a small inline message at the bottom of the card
 * (idempotent — reuses/refreshes one), so the user knows nothing changed and the
 * card stays open for them to retry or dismiss.
 */
function flashApplyFailure(card: HTMLElement, message = "Couldn't apply here — text changed"): void {
  let note = card.querySelector('.og-apply-failure') as HTMLElement | null;
  if (!note) {
    note = document.createElement('div');
    note.className = 'og-apply-failure';
    note.style.cssText = `
      padding:8px 14px; font-size:12px; font-weight:600; color:#b91c1c;
      background:#fef2f2; border-top:1px solid #fecaca; line-height:1.4;
      display:flex; align-items:center; gap:6px;
    `;
    card.appendChild(note);
  }
  note.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#b91c1c" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
      <circle cx="8" cy="8" r="6.25"/><path d="M8 5v3.5"/><path d="M8 10.6h.01"/>
    </svg>
    <span>${escapeHtml(message)}</span>
  `;
  const existing = Number(note.dataset.timer || '0');
  if (existing) window.clearTimeout(existing);
  note.dataset.timer = String(
    window.setTimeout(() => {
      note?.remove();
    }, 4000),
  );
}

async function applySuggestion(element: HTMLElement, issue: Issue): Promise<boolean> {
  // One validated apply primitive for every field/editor type. It rejects stale
  // or ambiguous spans, so a failed apply must NOT be treated as success (the
  // underline should stay put rather than vanish without the text changing).
  const ok = await applyFix(element, {
    original: issue.original,
    offset: issue.offset,
    length: issue.length,
    replacement: issue.suggestion,
  });
  if (ok) {
    void chrome.runtime.sendMessage({
      type: 'TRACK_ANALYTICS_EVENT',
      eventType: 'suggestions_applied',
      payload: { count: 1, domain: window.location.hostname },
    });
  }
  return ok;
}

function ignoreIssue(issue: Issue, highlightEl: HTMLElement) {
  void chrome.runtime.sendMessage({
    type: 'TRACK_ANALYTICS_EVENT',
    eventType: 'suggestions_ignored',
    payload: { count: 1, domain: window.location.hostname },
  });

  chrome.storage.sync.get(['ignoredIssues'], (result) => {
    const ignoredIssues = normalizeIgnoredIssues(result.ignoredIssues);
    // Key the ignore by TYPE + WORD (not position) so dismissing a word keeps it
    // dismissed wherever it reappears — parity with the desktop's word-keyed ignore.
    const issueId = `${issue.type}-${issue.original.toLowerCase().trim()}`;
    if (!ignoredIssues.some((e) => e.id === issueId)) {
      ignoredIssues.push({ id: issueId, type: issue.type, original: issue.original, suggestion: issue.suggestion, ignoredAt: Date.now() });
      chrome.storage.sync.set({ ignoredIssues });
    }
  });

  // Drop this issue and re-render the remaining overlay underlines (no DOM
  // mutation of the editor — the underline lives in our overlay).
  issue.ignored = true;
  overlayIssues = overlayIssues.filter((i) => i !== issue);
  rerenderActiveUnderlines();
  if (highlightEl.classList?.contains('opengrammar-badge')) highlightEl.remove();
}

function normalizeIgnoredIssues(value: unknown): IgnoredIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return { id: entry, type: 'grammar' as const, original: entry, suggestion: '', ignoredAt: Date.now() };
    if (entry && typeof entry === 'object' && 'id' in entry && 'type' in entry && 'original' in entry && 'suggestion' in entry) return entry as IgnoredIssue;
    return null;
  }).filter(Boolean) as IgnoredIssue[];
}

/* ────────────────────────────────────────────────────────────
   GLOBAL CSS INJECTION (keyframes + font)
──────────────────────────────────────────────────────────── */
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  // Bundle the brand font (Geist) so in-page cards/menus/bubbles match the
  // popup & options. Loaded from the extension's own web_accessible_resources
  // via chrome.runtime.getURL, so the host page's CSP can't block it. Wrapped
  // in a try/catch and using font-display:swap — if the font fails to load the
  // in-page UI silently falls back to the system stack and never breaks.
  let fontFaces = '';
  try {
    const geistUrl = (w: string) =>
      JSON.stringify(chrome.runtime.getURL(`fonts/Geist-${w}.woff2`));
    fontFaces = `
    @font-face {
      font-family: 'Geist';
      src: url(${geistUrl('Regular')}) format('woff2');
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url(${geistUrl('Medium')}) format('woff2');
      font-weight: 500; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url(${geistUrl('SemiBold')}) format('woff2');
      font-weight: 600; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url(${geistUrl('Bold')}) format('woff2');
      font-weight: 700; font-style: normal; font-display: swap;
    }`;
  } catch {
    fontFaces = '';
  }
  style.textContent = `
    ${fontFaces}
    @keyframes og-fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes og-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .opengrammar-tooltip, .opengrammar-rephrase-panel {
      -webkit-font-smoothing: antialiased;
    }
  `;
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHighlightContainer);
} else {
  initHighlightContainer();
}
