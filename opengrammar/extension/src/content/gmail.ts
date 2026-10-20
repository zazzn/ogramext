/**
 * Gmail per-site detection assist.
 *
 * Mirrors the google-docs.ts pattern (standalone module + MutationObserver),
 * but instead of running its own grammar pipeline it hands compose fields off
 * to the main content script (content/index.ts) so there is ONE apply path,
 * ONE highlighter, and ONE badge — no double-processing.
 *
 * Why this exists (from the audit):
 *  - Gmail compose is a contenteditable, so index.ts already *can* handle it,
 *    but the compose window mounts/remounts lazily (SPA). The main script's
 *    one-shot focus check on load misses it. We watch for the compose body /
 *    subject mounting and nudge index.ts to activate them.
 *  - Gmail sometimes reverting our first insert is handled generically by
 *    editorAdapter.ts (verify after the editor settles, retry once) — no
 *    Gmail-specific apply code.
 *
 * The nudge is a bubbling, composed `focusin` dispatched on the field: index.ts
 * listens for `focusin` on the document (capture phase) and activates editable
 * targets there, so this reuses its full pipeline without exporting internals.
 */

// Stable Gmail selectors. The compose body has historically used both
// `g_editable="true"` and an aria-label of "Message Body"; we accept either,
// plus the generic role=textbox contenteditable as a final fallback.
const COMPOSE_BODY_SELECTORS = [
  'div[aria-label="Message Body"][contenteditable="true"]',
  'div[g_editable="true"]',
  '[role="textbox"][contenteditable="true"]',
];
const SUBJECT_SELECTOR = 'input[name="subjectbox"]';

// Fields we've already nudged, so we don't re-dispatch focus on every mutation
// (which would steal focus from the user). WeakSet → no leaks as compose
// windows are torn down.
const nudged = new WeakSet<HTMLElement>();

function nudge(el: HTMLElement | null) {
  if (!el || nudged.has(el)) return;
  nudged.add(el);
  console.log('[OGrammar] Gmail field detected, handing off to content script:', el.tagName);
  // Dispatch a composed, bubbling focusin so the main content script's
  // document-level capture listener activates the field through its normal path.
  try {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  } catch {
    el.dispatchEvent(new Event('focusin', { bubbles: true }));
  }
}

function scan() {
  for (const sel of COMPOSE_BODY_SELECTORS) {
    const body = document.querySelector(sel) as HTMLElement | null;
    if (body) {
      nudge(body);
      break;
    }
  }
  const subject = document.querySelector(SUBJECT_SELECTOR) as HTMLElement | null;
  if (subject) nudge(subject);
}

let scanScheduled = false;
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  // Coalesce bursts of DOM churn (compose open animates in many nodes).
  setTimeout(() => {
    scanScheduled = false;
    scan();
  }, 400);
}

function start() {
  console.log('[OGrammar] Initializing Gmail integration...');
  // Initial scan in case compose is already open (e.g. ?compose=new deep link).
  scan();
  // Compose mounts/remounts as the user opens/closes draft windows.
  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
