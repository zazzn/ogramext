import type { AnalysisContext, Issue } from '../types';
import { isProtectedNonProseText } from '../shared/protectedText';
import {
  applySettledQuickFixes,
  cancelPendingAutocorrect,
  initAutocorrect,
  maybeAutocorrect,
  noteAutocorrectEdit,
  onRejectedStorageChange,
} from './autocorrect';
import { routeLlmCorrection } from '../background/issuePolicy';
import { findLearnedCorrections } from '../shared/learnedCorrections';
import { findSentenceCapitalizations } from '../shared/sentenceCaps';
import {
  getLearnedMap,
  initLearnedCorrections,
  onLearnedStorageChange,
  recordLearnedCorrection,
} from './learnedStore';
import {
  clearHighlights,
  highlightIssues,
  isUIActive,
  rebuildFloatingDecorations,
  refreshFloatingDecorations,
  setAssistantState,
  startFloatingDecorationObservers,
  stopFloatingDecorationObservers,
  updateSelectionBubble,
} from './highlighter';
import {
  extractText,
  getCaretPosition,
  getElementFromTarget,
  stripQuotedBBCode,
} from './textExtractor';
import { debounce } from './utils';

interface EditableElement {
  element: HTMLElement;
  observer?: MutationObserver;
  lastText: string;
  lastCheck?: number;
  lastIssues?: Issue[];
  lastLocalIssues?: Issue[];
  lastLlmText?: string;
  lastLlmIssues?: Issue[];
  llmSeq?: number;
  /** The field's original `spellcheck` attribute value (null if unset), so we
   *  can restore it when OGrammar stops managing the field. */
  prevSpellcheck?: string | null;
}

interface LlmCorrection {
  original?: string;
  replacement?: string;
  start?: number;
  end?: number;
  type?: 'spelling' | 'grammar' | 'punctuation' | 'capitalization' | 'word-form';
  confidence?: 'high' | 'medium' | 'low';
}

const PROACTIVE_LLM_MIN_WORDS = 6;
const PROACTIVE_LLM_MAX_CHARS = 3500;

const activeElements = new Map<HTMLElement, EditableElement>();
let currentFocusElement: HTMLElement | null = null;
let lastSelectionRange: Range | null = null;
let lastInputSelection: {
  element: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
} | null = null;

// Track which domains are disabled
let disabledDomains: string[] = [];
let autocorrectEnabled = false; // opt-in; see loadUserSettings()
let autocorrectDelayMs = 2000; // idle (ms) before autocorrect applies; see settings

let isContextInvalidated = false;

/**
 * Resolve the *real* focused element across (open) Shadow DOM boundaries.
 *
 * Plain `document.activeElement` stops at the shadow HOST: when a field lives
 * inside a web component (Angular/Material, Play Console, Lit, etc.) focus
 * retargets to the host and the actual editable inside the shadow root is never
 * seen. We descend `shadowRoot.activeElement` until we reach the innermost
 * focused node.
 *
 * NOTE: CLOSED shadow roots expose `null` for `.shadowRoot` by design and are
 * inaccessible — this cannot be recovered. Most Angular/Material components use
 * OPEN roots, which this fully recovers.
 */
function deepActiveElement(): HTMLElement | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el instanceof HTMLElement ? el : null;
}

/**
 * Resolve the originating element of a (focus/input) event, undoing Shadow DOM
 * retargeting. `event.composedPath()[0]` is the true target inside an open
 * shadow root; `event.target` would be the host. Falls back to the existing
 * target resolution when composedPath is unavailable (older targets / closed
 * roots / synthetic events).
 */
function getElementFromEvent(event: Event): HTMLElement | null {
  try {
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      const first = path && path[0];
      if (first instanceof HTMLElement) return first;
    }
  } catch {
    /* composedPath can throw on some synthetic events — fall through */
  }
  return getElementFromTarget(event.target);
}

/**
 * Check if the extension context is still valid
 */
function checkContext(): boolean {
  if (isContextInvalidated) return false;

  if (!chrome.runtime?.id) {
    if (!isContextInvalidated) {
      console.warn('[OGrammar] Extension context invalidated. Please refresh the page.');
      isContextInvalidated = true;
      deactivateAll();
    }
    return false;
  }
  return true;
}

/**
 * Deactivate all active elements
 */
function deactivateAll() {
  activeElements.forEach((_, element) => {
    deactivateElement(element);
  });
  activeElements.clear();
  // Stop the late-mount watcher too (e.g. on context invalidation) so we don't
  // keep reacting to DOM churn after the extension is gone.
  if (lateMountObserver) {
    lateMountObserver.disconnect();
    lateMountObserver = null;
  }
}

/**
 * Initialize the content script
 */
function initialize() {
  console.log('🚀 [OGrammar] Content script starting...');

  // Check context immediately
  if (!checkContext()) return;

  // Check for file:// protocol
  if (window.location.protocol === 'file:') {
    console.warn(
      '⚠️ [OGrammar] You are using file:// protocol. Make sure "Allow access to file URLs" is enabled in chrome://extensions for OGrammar.',
    );
  }

  // Load disabled domains
  loadUserSettings();

  // Listen for focus events on editable elements
  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('focusout', handleFocusOut, true);

  // Highlight updates are coalesced inside highlighter.ts with one rAF.
  window.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', handleResize, true);

  // Selection-rewrite bubble: show whenever there's a non-empty selection
  // inside an editable field (works on clean, error-free text too).
  document.addEventListener('selectionchange', debounce(syncSelectionBubble, 180));
  document.addEventListener('mouseup', debounce(syncSelectionBubble, 60), true);

  // Check for already focused elements on page load
  setTimeout(checkExistingFocusedElement, 500);

  // SPA fields (Gmail compose, Play Console, any JS-heavy app) mount lazily,
  // so the one-shot check above misses them. Watch for late DOM additions and
  // re-probe the (deep) focused element when the page grows.
  startLateMountObserver();

  // Verify connection to background script (no backend — direct provider model)
  try {
    chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }, (response) => {
      if (chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message?.includes('context invalidated')) {
          isContextInvalidated = true;
        }
        console.error(
          '❌ [OGrammar] Cannot connect to background script:',
          chrome.runtime.lastError.message,
        );
      } else {
        console.log(
          '✅ [OGrammar] Connected to background script.',
          response?.providers?.length ? `${response.providers.length} providers` : '',
        );
      }
    });
  } catch (e) {
    console.error('❌ [OGrammar] Fatal error connecting to background:', e);
    isContextInvalidated = true;
  }

  console.log(
    '[OGrammar] Content script initialized on',
    window.location.hostname || 'local file',
  );

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'GET_SELECTED_TEXT') {
      sendResponse({ text: captureSelectedText() });
      return false;
    }

    if (request.type === 'GET_ACTIVE_TEXT') {
      const text = currentFocusElement ? extractText(currentFocusElement) : '';
      const issues = currentFocusElement
        ? activeElements.get(currentFocusElement)?.lastIssues || []
        : [];
      sendResponse({ text, issues });
      return false;
    }

    if (request.type === 'APPLY_REWRITE') {
      const success = applyRewrite(request.original, request.rewritten);
      sendResponse(success);
      return false;
    }

    return false;
  });
}

/**
 * Load disabled domains from storage
 */
async function loadUserSettings() {
  if (!checkContext()) return;

  try {
    const result = await chrome.storage.sync.get([
      'disabledDomains',
      'autocorrectEnabled',
      'autocorrectDelayMs',
    ]);
    disabledDomains = result.disabledDomains || [];
    // iPhone-style autocorrect is OPT-IN (default off): it silently edits the
    // user's text as they type, so it must be explicitly enabled.
    autocorrectEnabled = result.autocorrectEnabled === true;
    if (typeof result.autocorrectDelayMs === 'number') {
      autocorrectDelayMs = result.autocorrectDelayMs;
    }
    void initAutocorrect();
    void initLearnedCorrections();
  } catch (e) {
    if (e instanceof Error && e.message.includes('context invalidated')) {
      isContextInvalidated = true;
    }
    console.debug('[OGrammar] Could not load disabled domains');
  }
}

/**
 * Check if current domain is disabled
 */
function isDomainDisabled(): boolean {
  if (!checkContext()) return true;
  const domain = window.location.hostname.toLowerCase();
  return disabledDomains.some((d) => domain.includes(d) || d.includes(domain));
}

/**
 * Check for already focused elements on page load
 */
/** The editable element + selected text + best-effort offset, or null. */
function getEditableSelection(): { el: HTMLElement; text: string; offset: number } | null {
  // deepActiveElement() so a focused input/textarea inside an open shadow root
  // (e.g. Play Console web components) is found, not its host.
  const ae = deepActiveElement();
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
    const input = ae as HTMLInputElement | HTMLTextAreaElement;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    if (typeof s === 'number' && typeof e === 'number' && e > s) {
      const text = String(input.value ?? '').slice(s, e);
      if (text.trim().length >= 2) return { el: ae, text, offset: s };
    }
    return null;
  }

  // Document-level selection. Inside a Shadow DOM, window.getSelection() is
  // often empty/collapsed because the selection lives in the shadow root's own
  // selection. Recover it from the shadow root (open roots only) or composedPath.
  let selObj = window.getSelection();
  if (!selObj || selObj.isCollapsed || selObj.rangeCount === 0) {
    const shadowSel = getShadowSelection();
    if (shadowSel) selObj = shadowSel;
  }
  if (!selObj || selObj.isCollapsed || selObj.rangeCount === 0) return null;
  const text = selObj.toString();
  if (text.trim().length < 2) return null;
  let node: Node | null = selObj.anchorNode;
  while (node) {
    if (node instanceof HTMLElement && node.isContentEditable) {
      let offset = 0;
      try {
        const full = extractText(node) || '';
        const i = full.indexOf(text);
        offset = i >= 0 ? i : 0;
      } catch {
        offset = 0;
      }
      return { el: node, text, offset };
    }
    // Hop out of a shadow root to its host so the contenteditable ancestor
    // search continues across the boundary.
    const parent = node.parentNode;
    if (!parent && node instanceof ShadowRoot) {
      node = node.host;
    } else {
      node = parent;
    }
  }
  return null;
}

/**
 * Recover a Selection from inside an (open) Shadow DOM, where the top-level
 * window.getSelection() reports nothing. We walk from deepActiveElement() up
 * through its hosting shadow roots and ask each root's own getSelection()
 * (a non-standard but widely-implemented Shadow DOM API) for a live selection.
 * Returns null if none is found (or roots are closed — inaccessible by design).
 */
function getShadowSelection(): Selection | null {
  let node: Node | null = deepActiveElement();
  while (node) {
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      const rootSel = (root as unknown as { getSelection?: () => Selection | null }).getSelection;
      if (typeof rootSel === 'function') {
        const sel = rootSel.call(root);
        if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim().length >= 2) {
          return sel;
        }
      }
      node = root.host;
    } else {
      break;
    }
  }
  return null;
}

function syncSelectionBubble(): void {
  // Don't tear down while the user is choosing a tone in the open menu
  // (selectionchange fires when focus moves to a menu button).
  if (document.querySelector('.og-selection-menu')) return;
  if (isDomainDisabled()) {
    updateSelectionBubble(null, '', 0);
    return;
  }
  const r = getEditableSelection();
  if (r) updateSelectionBubble(r.el, r.text, r.offset);
  else updateSelectionBubble(null, '', 0);
}

function checkExistingFocusedElement() {
  if (!checkContext()) return;
  if (isDomainDisabled()) {
    console.log('[OGrammar] Domain is disabled, skipping');
    return;
  }

  // deepActiveElement() so a field inside an (open) shadow root — the real
  // target on Play Console / web-component apps — is detected, not its host.
  const activeElement = deepActiveElement();
  if (activeElement && isEditable(activeElement)) {
    console.log('[OGrammar] Found active element on load:', activeElement.tagName);
    activateElement(activeElement);
  }
}

let lateMountObserver: MutationObserver | null = null;

/**
 * Re-probe the (deep) focused element for editability and activate it. Used by
 * the late-mount observer so fields that mount AFTER focus / page load (SPA
 * compose windows, web-component apps) still get picked up.
 */
function reprobeActiveElement() {
  if (!checkContext() || isDomainDisabled()) return;
  const el = deepActiveElement();
  if (el && isEditable(el) && !activeElements.has(el)) {
    console.log('[OGrammar] Late-mounted editable detected:', el.tagName);
    activateElement(el);
  }
}

const debouncedReprobe = debounce(reprobeActiveElement, 500);

/**
 * Watch document.documentElement for significant DOM growth and, when it
 * happens, re-check the focused element. Cheap by design: it only fires the
 * (debounced) re-probe when nodes are actually ADDED, and ignores mutations
 * coming from OpenGrammar's own decoration UI.
 */
function startLateMountObserver() {
  if (lateMountObserver) return;
  lateMountObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
      // Ignore our own UI churn (underlines/tooltips/badges) so we don't
      // re-probe in a loop while highlighting.
      let significant = false;
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (
          n.id === 'opengrammar-highlights' ||
          n.classList?.contains('opengrammar-tooltip') ||
          n.classList?.contains('opengrammar-badge') ||
          n.classList?.contains('opengrammar-underline') ||
          n.classList?.contains('og-selection-menu')
        ) {
          return;
        }
        significant = true;
      });
      if (significant) {
        debouncedReprobe();
        return;
      }
    }
  });
  lateMountObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Handle focus in event
 */
function handleFocusIn(event: FocusEvent) {
  if (!checkContext()) return;
  if (isDomainDisabled()) return;

  // Prefer composedPath()[0] so Shadow DOM retargeting (focus reported on the
  // shadow HOST) is undone and we get the real editable inside the root.
  const target = getElementFromEvent(event);
  const normalizedTarget = normalizeEditableTarget(target);
  if (normalizedTarget && isEditable(normalizedTarget)) {
    console.log('[OGrammar] Focus in:', normalizedTarget.tagName, normalizedTarget.className);
    activateElement(normalizedTarget);
  }
}

/**
 * Handle focus out event
 */
function handleFocusOut(event: FocusEvent) {
  if (!checkContext()) return;

  const target = getElementFromTarget(event.target);
  const relatedTarget = event.relatedTarget as HTMLElement;

  // If we're moving focus to something inside our own UI, don't deactivate
  if (
    relatedTarget &&
    (relatedTarget.closest('.opengrammar-tooltip') ||
      relatedTarget.closest('.opengrammar-badge') ||
      relatedTarget.closest('#opengrammar-highlights') ||
      relatedTarget.classList.contains('opengrammar-underline'))
  ) {
    console.log('[OGrammar] Focus moving to UI, staying active');
    return;
  }

  if (target && activeElements.has(target)) {
    // Longer timeout to allow clicks on UI to register
    setTimeout(() => {
      if (!checkContext()) return;

      // Don't deactivate while OpenGrammar UI (tooltip/panel) is active
      if (isUIActive()) return;

      const currentActive = document.activeElement;
      if (
        currentActive &&
        (currentActive.closest('.opengrammar-tooltip') ||
          currentActive.closest('.opengrammar-badge') ||
          currentActive.closest('#opengrammar-highlights') ||
          currentActive.classList.contains('opengrammar-underline'))
      ) {
        return;
      }

      if (document.activeElement !== target) {
        console.log('[OGrammar] Focus out:', target.tagName);
        deactivateElement(target);
      }
    }, 200);
  }
}

/**
 * Handle scroll event to update highlight positions
 */
function handleScroll() {
  refreshFloatingDecorations();
}

function handleResize() {
  rebuildFloatingDecorations();
}

/**
 * Activate an editable element for grammar checking
 */
function activateElement(element: HTMLElement) {
  if (activeElements.has(element)) {
    return; // Already active
  }

  currentFocusElement = element;

  const editableElement: EditableElement = {
    element,
    lastText: extractText(element),
  };

  // Suppress the browser's NATIVE spellcheck on fields we manage, so its red
  // wavy squiggle doesn't visually collide with OGrammar's own underlines
  // (Grammarly does exactly this). OGrammar ships its own spell engine, menu,
  // and per-user dictionary, so the native checker isn't needed while active;
  // the original value is restored on deactivate.
  editableElement.prevSpellcheck = element.getAttribute('spellcheck');
  element.setAttribute('spellcheck', 'false');

  // Set up mutation observer for contenteditable elements
  if (element.isContentEditable && element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') {
    const observer = new MutationObserver(
      debounce((mutations) => {
        const newText = extractText(element);
        if (newText !== editableElement.lastText) {
          editableElement.lastText = newText;
          console.log('[OGrammar] Content changed, checking grammar...');
          debouncedCheck(element);
        }
      }, 500),
    );

    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    editableElement.observer = observer;
  }

  // Listen for input events
  element.addEventListener('input', handleInput as EventListener);
  startFloatingDecorationObservers(element);

  activeElements.set(element, editableElement);

  // Initial check
  console.log(
    '[OGrammar] Activated element, initial text:',
    editableElement.lastText.substring(0, 50),
  );
  void syncActiveContext(editableElement.lastText, editableElement.lastIssues || []);
  debouncedCheck(element);
}

/**
 * Deactivate an editable element
 */
function deactivateElement(element: HTMLElement) {
  const editableElement = activeElements.get(element);
  if (!editableElement) return;

  // Restore the field's original native-spellcheck setting.
  if (editableElement.prevSpellcheck === null || editableElement.prevSpellcheck === undefined) {
    element.removeAttribute('spellcheck');
  } else {
    element.setAttribute('spellcheck', editableElement.prevSpellcheck);
  }

  // Disconnect observer
  if (editableElement.observer) {
    editableElement.observer.disconnect();
  }

  // Remove event listeners
  element.removeEventListener('input', handleInput as EventListener);
  stopFloatingDecorationObservers(element);

  // Clear highlights only if NOT currently interacting with a tooltip
  const currentActive = document.activeElement;
  const isInteractingWithUI =
    currentActive &&
    (currentActive.closest('.opengrammar-tooltip') || currentActive.closest('.opengrammar-badge'));

  if (!isInteractingWithUI && !isUIActive()) {
    clearHighlights();
  }

  activeElements.delete(element);

  if (currentFocusElement === element) {
    currentFocusElement = null;
  }

  console.log('[OGrammar] Deactivated element');
}

/**
 * Handle input event
 */
function handleInput(event: Event) {
  const target = getElementFromTarget(event.target);
  if (target && activeElements.has(target)) {
    const editableElement = activeElements.get(target)!;
    editableElement.lastText = extractText(target);
    void syncActiveContext(editableElement.lastText, editableElement.lastIssues || []);
    if (autocorrectEnabled) noteAutocorrectEdit();
    debouncedCheck(target);
  }
}

/**
 * Fold learned corrections (taught by prior high-conviction LLM fixes) into the
 * local issue set: emit a quick-fix for each occurrence of a learned typo that does
 * not overlap an existing local issue. They then ride the normal highlight +
 * caret-gated autocorrect path — so the local engine now fixes, with NO LLM call,
 * exactly what the LLM taught it. The pure matcher is shared with the desktop engine
 * and the self-learning benchmark.
 */
function mergeLearnedCorrections(localIssues: Issue[], text: string): Issue[] {
  const learnedIssues = findLearnedCorrections(text, getLearnedMap());
  if (learnedIssues.length === 0) return localIssues;
  const out = localIssues.slice();
  for (const li of learnedIssues) {
    const overlaps = out.some(
      (e) => li.offset < e.offset + e.length && e.offset < li.offset + li.length,
    );
    if (!overlaps) out.push(li);
  }
  return out;
}

/**
 * Fold the desktop's sentence-start capitalization detector into the local issue
 * set: Harper only flags the FIRST sentence; 2nd+ sentences after `. ! ?` go
 * unflagged. Emit a quick-fix for each mid-sentence lowercase start that does NOT
 * overlap an existing issue (so Harper's first-sentence flag isn't duplicated).
 * Same overlap pattern as mergeLearnedCorrections. The pure detector is a faithful
 * port of the desktop engine, so the extension flags + (caret-gated) auto-applies
 * these exactly like the desktop.
 */
function mergeSentenceCaps(localIssues: Issue[], text: string): Issue[] {
  const capIssues = findSentenceCapitalizations(text);
  if (capIssues.length === 0) return localIssues;
  const out = localIssues.slice();
  for (const ci of capIssues) {
    const overlaps = out.some(
      (e) => ci.offset < e.offset + e.length && e.offset < ci.offset + ci.length,
    );
    if (!overlaps) out.push(ci);
  }
  return out;
}

/**
 * Check grammar for an element
 */
function handleGrammarSuccess(element: HTMLElement, text: string, issues: Issue[]) {
  const editableElement = activeElements.get(element);
  // Self-learning: fold in corrections the local engine learned from prior LLM
  // fixes, so it now flags + (caret-gated) auto-applies them with NO LLM round-trip.
  // Then fold in the desktop's sentence-start capitalization fixes (Harper misses
  // 2nd+ sentences) so local parity matches the desktop engine.
  const localIssues = mergeSentenceCaps(
    mergeLearnedCorrections(issues || [], text),
    text,
  );
  if (editableElement) {
    editableElement.lastLocalIssues = localIssues;
    if (editableElement.lastLlmText !== text) editableElement.lastLlmIssues = [];
  }
  const visibleIssues = mergeLlmIssues(localIssues, editableElement?.lastLlmIssues || []);

  // Autocorrect (opt-in): silently apply high-confidence (quick-fix) fixes for
  // words the user just finished typing. Runs IN ADDITION to highlighting —
  // anything it doesn't apply is still underlined below. Only for the focused
  // field, and only when enabled.
  if (autocorrectEnabled && editableElement && element === currentFocusElement) {
    maybeAutocorrect(
      element,
      text,
      editableElement.lastText,
      visibleIssues,
      getCaretPosition(element),
      autocorrectDelayMs,
    );
  }

  const proactiveEligible = isProactiveLlmEligible(element, text);
  const llmCompletedForText = editableElement?.lastLlmText === text;
  const llmPending = proactiveEligible && !llmCompletedForText;
  if (visibleIssues.length > 0) {
    if (editableElement) editableElement.lastIssues = visibleIssues;
    void syncActiveContext(text, visibleIssues);
    // Don't tear down the review panel mid-batch: accepting a sentence
    // dispatches `input` → re-analysis, and re-highlighting would wipe the
    // open panel before the user finishes the remaining sentences. Defer
    // the underline refresh until the panel is closed.
    if (!isUIActive()) highlightIssues(element, visibleIssues);
    if (!isUIActive()) {
      setAssistantState(element, {
        localCount: localIssues.length,
        llmCount: llmPending ? null : (editableElement?.lastLlmIssues || []).length,
        phase: 'has-issues',
        issues: visibleIssues,
      });
    }

    const statsPerType = { grammar: 0, spelling: 0, clarity: 0, style: 0 };
    for (const issue of visibleIssues) {
      if (issue.type in statsPerType) statsPerType[issue.type as keyof typeof statsPerType]++;
    }
    void chrome.storage.local.set({
      lastIssueStats: {
        grammar: statsPerType.grammar + statsPerType.spelling,
        style: statsPerType.style,
        clarity: statsPerType.clarity,
        total: visibleIssues.length,
      },
    });

    void chrome.runtime.sendMessage({ type: 'UPDATE_BADGE_COUNT', count: visibleIssues.length });

    const wordCount = text.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
    const errorTypes: Record<string, number> = {};
    for (const issue of visibleIssues) {
      errorTypes[issue.type] = (errorTypes[issue.type] || 0) + 1;
    }
    const issuesPerHundred = wordCount > 0 ? (visibleIssues.length / wordCount) * 100 : 0;
    const writingScore = Math.round(Math.max(0, Math.min(100, 100 - issuesPerHundred * 10)));
    void chrome.runtime.sendMessage({
      type: 'SAVE_WRITING_SESSION',
      payload: { wordsChecked: wordCount, issuesFound: visibleIssues.length, issuesFixed: 0, writingScore, errorTypes },
    });
  } else {
    if (editableElement) editableElement.lastIssues = [];
    void syncActiveContext(text, []);
    // No local mechanical issues. Keep the AI review bubble available for prose:
    // context-only mistakes may still be caught by the sentence-level model.
    // For very short snippets, remove UI noise.
    const wordCount = text.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
    if (!isUIActive()) {
      if (wordCount >= 4) highlightIssues(element, []);
      else clearHighlights();
      if (wordCount >= 4) {
        setAssistantState(element, {
          localCount: 0,
          llmCount: llmPending ? null : 0,
          phase: llmPending ? 'clean-pending-ai' : 'clean',
          issues: [],
        });
      }
    }
    void chrome.runtime.sendMessage({ type: 'UPDATE_BADGE_COUNT', count: 0 });
  }

  scheduleProactiveLlmReview(element);
}


function rangesOverlap(a: { offset: number; length: number }, b: { offset: number; length: number }): boolean {
  return a.offset < b.offset + b.length && b.offset < a.offset + a.length;
}

function mergeLlmIssues(localIssues: Issue[], llmIssues: Issue[]): Issue[] {
  if (llmIssues.length === 0) return localIssues;
  const filtered = llmIssues.filter((llm) => !localIssues.some((local) => rangesOverlap(local, llm)));
  return [...localIssues, ...filtered];
}

function llmTypeToIssueType(type: LlmCorrection['type']): Issue['type'] {
  return type === 'spelling' || type === 'word-form' ? 'spelling' : 'grammar';
}

function confidenceScore(confidence: LlmCorrection['confidence']): number {
  if (confidence === 'high') return 0.95;
  if (confidence === 'medium') return 0.78;
  return 0.55;
}

function isWordBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !/[A-Za-z0-9_]/.test(text[index] || '');
}

function findCorrectionOffset(text: string, original: string, used: Array<{ start: number; end: number }>): number {
  const wordish = /^[A-Za-z0-9']+$/.test(original);
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(original, from);
    if (index < 0) return -1;
    const end = index + original.length;
    const boundaryOk = !wordish || (isWordBoundary(text, index - 1) && isWordBoundary(text, end));
    const unused = !used.some((span) => index < span.end && end > span.start);
    if (boundaryOk && unused) return index;
    from = index + Math.max(1, original.length);
  }
  return -1;
}

function buildLlmIssues(text: string, corrections: LlmCorrection[] | undefined): Issue[] {
  if (!Array.isArray(corrections) || corrections.length === 0) return [];
  const used: Array<{ start: number; end: number }> = [];
  const issues: Issue[] = [];

  for (const correction of corrections) {
    if (correction.confidence === 'low') continue;
    const original = (correction.original || '').trim();
    const suggestion = (correction.replacement || '').trim();
    if (!original || !suggestion || original === suggestion) continue;
    // Prefer the model's own offsets (unambiguous for repeated words); fall back
    // to first-unused text match if they're missing or don't line up.
    let offset = -1;
    if (
      typeof correction.start === 'number' &&
      correction.start >= 0 &&
      text.slice(correction.start, correction.start + original.length) === original &&
      !used.some((s) => correction.start! < s.end && correction.start! + original.length > s.start)
    ) {
      offset = correction.start;
    } else {
      offset = findCorrectionOffset(text, original, used);
    }
    if (offset < 0) continue;
    const end = offset + original.length;
    used.push({ start: offset, end });
    const route = routeLlmCorrection(original, suggestion);
    issues.push({
      id: `llm-${offset}-${original}-${suggestion}`,
      type: llmTypeToIssueType(correction.type),
      original,
      suggestion,
      offset,
      length: original.length,
      reason: `Sentence review suggests ${original} -> ${suggestion}.`,
      confidence: confidenceScore(correction.confidence),
      priority: 2,
      source: 'llm',
      // Conviction routing (issuePolicy.routeLlmCorrection, the SAME FP guards as
      // local issues): a mechanical caps/punct fix or a high-confidence single-word
      // spelling fix becomes 'quick-fix' (the proactive pass auto-applies + learns
      // it); everything subtle (loose/lose, their/there — they fail the guards)
      // stays 'sentence-review' as a non-destructive Accept/Dismiss card.
      route,
      routeReason:
        route === 'quick-fix'
          ? 'high-confidence LLM fix (auto-apply + learn)'
          : 'Proactive sentence-level review after typing paused.',
    });
  }

  return issues;
}

function shouldRunProactiveLlm(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20 || trimmed.length > PROACTIVE_LLM_MAX_CHARS) return false;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return words >= PROACTIVE_LLM_MIN_WORDS;
}

function isProactiveLlmEligible(element: HTMLElement, text: string): boolean {
  if (!shouldRunProactiveLlm(text)) return false;
  const inputType =
    element.tagName === 'INPUT'
      ? ((element as HTMLInputElement).type || '').toLowerCase()
      : '';
  return !NON_PROSE_INPUT_TYPES.has(inputType) && !looksNonProse(text);
}

async function runProactiveLlmReview(element: HTMLElement) {
  if (!checkContext() || !activeElements.has(element) || isUIActive()) return;

  const editableElement = activeElements.get(element)!;
  const text = stripQuotedBBCode(extractText(element));
  if (!isProactiveLlmEligible(element, text)) return;
  if (editableElement.lastLlmText === text) return;

  const seq = (editableElement.llmSeq || 0) + 1;
  editableElement.llmSeq = seq;
  const localIssues = editableElement.lastLocalIssues || [];
  const pendingIssues = mergeLlmIssues(localIssues, editableElement.lastLlmIssues || []);
  setAssistantState(element, {
    localCount: localIssues.length,
    llmCount: null,
    phase: 'analyzing-llm',
    issues: pendingIssues,
  });

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CORRECT_TEXT', text });
    if (!activeElements.has(element)) return;
    const currentState = activeElements.get(element)!;
    const currentText = stripQuotedBBCode(extractText(element));
    if (currentState.llmSeq !== seq || currentText !== text || isUIActive()) return;

    currentState.lastLlmText = text;
    if (!response?.llm || response.shouldShow === false || !response.corrected || response.corrected.trim() === text.trim()) {
      currentState.lastLlmIssues = [];
      const merged = currentState.lastLocalIssues || [];
      currentState.lastIssues = merged;
      setAssistantState(element, {
        localCount: merged.length,
        llmCount: 0,
        phase: merged.length > 0 ? 'has-issues' : 'clean',
        issues: merged,
      });
      return;
    }

    const llmIssues = buildLlmIssues(text, response.corrections);
    // LEARN (Option A) — ALWAYS, regardless of the autocorrect opt-in (parity with the
    // desktop, which learns on every LLM result; previously this was gated behind
    // autocorrect and so never ran for default users). Remember the LLM's fix for any
    // word the LOCAL engine also flagged as a spelling typo — context-independent, so
    // next time it's typed the local engine corrects it with NO LLM call. Gated on a
    // local SPELLING flag to exclude homophones / word-choice (their/there, loose/lose).
    const localTypos = new Set(
      (currentState.lastLocalIssues || [])
        .filter((i) => i.type === 'spelling')
        .map((i) => i.original.toLowerCase()),
    );
    for (const li of llmIssues) {
      if (localTypos.has(li.original.toLowerCase())) {
        recordLearnedCorrection(li.original, li.suggestion);
      }
    }
    if (autocorrectEnabled) {
      // Auto-apply the high-conviction (quick-fix) LLM fixes into the settled text
      // (also learned). Applying mutates the field, whose input event retriggers a
      // fresh local+LLM cycle that repaints cleanly — so on success we clear and bail.
      const { applied } = await applySettledQuickFixes(element, text, llmIssues);
      for (const a of applied) recordLearnedCorrection(a.original, a.suggestion);
      if (applied.length > 0) {
        clearHighlights();
        return;
      }
    }
    currentState.lastLlmIssues = llmIssues;
    const merged = mergeLlmIssues(currentState.lastLocalIssues || [], llmIssues);
    currentState.lastIssues = merged;
    void syncActiveContext(text, merged);
    if (merged.length > 0) highlightIssues(element, merged);
    else clearHighlights();
    setAssistantState(element, {
      localCount: (currentState.lastLocalIssues || []).length,
      llmCount: llmIssues.length,
      phase: merged.length > 0 ? 'has-issues' : 'clean',
      issues: merged,
    });
    void chrome.runtime.sendMessage({ type: 'UPDATE_BADGE_COUNT', count: merged.length });
  } catch (err) {
    console.debug('[OGrammar] Proactive LLM review skipped:', err);
    if (activeElements.has(element) && !isUIActive()) {
      const currentState = activeElements.get(element)!;
      const localIssues = currentState.lastLocalIssues || [];
      const visibleIssues = mergeLlmIssues(localIssues, currentState.lastLlmIssues || []);
      setAssistantState(element, {
        localCount: localIssues.length,
        llmCount: null,
        phase: visibleIssues.length > 0 ? 'has-issues' : 'clean-pending-ai',
        issues: visibleIssues,
      });
    }
  }
}

const scheduleProactiveLlmReview = debounce((element: HTMLElement) => {
  void runProactiveLlmReview(element);
}, 1600);

/**
 * A field holds no prose to proofread when it's a single token that's a
 * URL / host:port / path / email / code-ish value (config inputs like an
 * Ollama or Whisper endpoint). Prose always has spaces.
 */
function looksNonProse(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false; // has spaces → treat as prose
  if (isProtectedNonProseText(t)) return true;
  return (
    t.includes('://') ||
    /^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i.test(t) || // email
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(t) || // host[:port][/path]
    /^[a-z]:\\/i.test(t) ||
    t.startsWith('/') ||
    t.startsWith('\\') ||
    (/[:/\\@]/.test(t) && /[.:]\d|\.\w/.test(t)) // generic code/path-ish
  );
}

const NON_PROSE_INPUT_TYPES = new Set([
  'url', 'email', 'password', 'number', 'tel', 'search',
  'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range',
]);

const checkGrammar = async (element: HTMLElement) => {
  if (!checkContext()) return;

  if (!activeElements.has(element)) {
    console.log('[OGrammar] Element not active, skipping check');
    return;
  }

  // Blank quoted posts (length-preserving) so we only check the user's own
  // writing. Offsets stay 1:1 with the editor text because length is kept.
  const text = stripQuotedBBCode(extractText(element));
  if (!text || text.trim().length < 5) {
    clearHighlights();
    return;
  }

  // Never analyze non-prose fields (URL/endpoint/path/email config inputs):
  // no bubble, no underline, no caret disturbance — nothing to proofread.
  const inputType =
    element.tagName === 'INPUT'
      ? ((element as HTMLInputElement).type || '').toLowerCase()
      : '';
  if (NON_PROSE_INPUT_TYPES.has(inputType) || looksNonProse(text)) {
    clearHighlights();
    return;
  }

  try {
    const startTime = Date.now();
    if (!isUIActive()) {
      setAssistantState(element, {
        localCount: 0,
        llmCount: null,
        phase: 'analyzing-local',
        issues: [],
      });
    }
    const response = await chrome.runtime.sendMessage({
      type: 'CHECK_GRAMMAR',
      text,
      context: buildAnalysisContext(element, text),
    });

    if (response?.error) {
      // The assistant bubble was set to 'analyzing-local' above; returning here
      // without resetting it leaves the bubble spinning forever. Reset to a
      // resting state (mirrors runProactiveLlmReview's catch).
      console.error('[OGrammar] Grammar check failed:', response.error);
      resetAssistantAfterError(element);
      return;
    }

    handleGrammarSuccess(element, text, response?.issues || []);
  } catch (err) {
    if (err instanceof Error && err.message.includes('context invalidated')) {
      isContextInvalidated = true;
      deactivateAll();
      return;
    }

    console.error('[OGrammar] Grammar check failed:', err);
    // Same reason as above: don't leave the bubble stuck spinning on a thrown error.
    resetAssistantAfterError(element);
  }
};

/**
 * Stop the assistant bubble spinner after a failed grammar check. Falls back to
 * the issues we already know about (so a prior result isn't lost): 'has-issues'
 * when some exist, otherwise 'clean'. No-op while a UI panel is open (we never
 * change the bubble out from under an open card).
 */
function resetAssistantAfterError(element: HTMLElement) {
  if (!activeElements.has(element) || isUIActive()) return;
  const editableElement = activeElements.get(element)!;
  const localIssues = editableElement.lastLocalIssues || [];
  const visibleIssues = mergeLlmIssues(localIssues, editableElement.lastLlmIssues || []);
  setAssistantState(element, {
    localCount: localIssues.length,
    llmCount: editableElement.lastLlmIssues ? editableElement.lastLlmIssues.length : null,
    phase: visibleIssues.length > 0 ? 'has-issues' : 'clean',
    issues: visibleIssues,
  });
}

const debouncedCheck = debounce(checkGrammar, 800);

/**
 * Check if an element is editable
 */
function isEditable(el: HTMLElement): boolean {
  if (!el) return false;

  // Check for input/textarea
  if (el.tagName === 'INPUT') {
    const inputType = (el as HTMLInputElement).type.toLowerCase();
    if (
      !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden'].includes(
        inputType,
      )
    ) {
      return true;
    }
  }

  if (el.tagName === 'TEXTAREA') {
    return true;
  }

  // Check for contenteditable
  if (el.isContentEditable) {
    return true;
  }

  // Check for role attribute indicating editability
  const role = el.getAttribute('role');
  if (role === 'textbox') {
    return true;
  }

  return false;
}

async function syncActiveContext(text: string, issues: Issue[]) {
  if (!checkContext()) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'SYNC_ACTIVE_CONTEXT',
      text,
      issues,
    });
  } catch {
    // ignore sync failures
  }
}

function normalizeEditableTarget(target: HTMLElement | null): HTMLElement | null {
  if (!target) return null;
  if (isEditable(target)) return target;

  const closest = target.closest(
    'input, textarea, [contenteditable="true"], [role="textbox"]',
  ) as HTMLElement | null;
  if (closest) return closest;

  if (window.location.hostname.includes('docs.google.com')) {
    return target.closest('.kix-appview-editor, [role="textbox"]') as HTMLElement | null;
  }

  return target;
}

function buildAnalysisContext(element: HTMLElement, text: string): AnalysisContext {
  const cursor = getCaretPosition(element);
  const previousText = text.slice(Math.max(0, cursor - 220), cursor).trim();
  const nextText = text.slice(cursor, Math.min(text.length, cursor + 220)).trim();
  const activeSentence = text
    .slice(
      Math.max(0, text.lastIndexOf('.', cursor - 1) + 1),
      Math.min(
        text.length,
        (() => {
          const nextPeriod = text.indexOf('.', cursor);
          return nextPeriod === -1 ? text.length : nextPeriod + 1;
        })(),
      ),
    )
    .trim();

  return {
    domain: window.location.hostname,
    editorType: getEditorType(element),
    activeSentence,
    previousText,
    nextText,
    fullTextExcerpt: text.slice(0, 1500),
    pageContext: getPageContext(),
  };
}

/**
 * Title + URL + the page's main visible text (capped), so the grammar/AI
 * review can ground its suggestions in what the user is actually reading.
 * Included in the AnalysisContext sent to the configured LLM provider.
 */
function getPageContext(): string {
  try {
    const main = (document.querySelector('main, article, [role="main"]') ||
      document.body) as HTMLElement | null;
    const body = (main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    return `Title: ${document.title}\nURL: ${location.href}\nPage: ${body}`;
  } catch {
    return '';
  }
}

function getEditorType(element: HTMLElement): string {
  if (window.location.hostname.includes('docs.google.com')) return 'google-docs';
  if (
    window.location.hostname.includes('mail.google.com') &&
    element.closest('div[g_editable="true"], div[aria-label="Message Body"][contenteditable="true"]')
  ) {
    return 'gmail';
  }
  if (element.tagName === 'TEXTAREA') return 'textarea';
  if (element.tagName === 'INPUT') return 'input';
  if (element.isContentEditable) return 'contenteditable';
  return 'generic';
}

function captureSelectedText(): string {
  const activeElement = currentFocusElement;

  if (
    activeElement &&
    (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
  ) {
    const input = activeElement as HTMLInputElement | HTMLTextAreaElement;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    lastInputSelection = { element: input, start, end };
    return input.value.slice(start, end);
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return '';
  }

  const text = selection.toString();
  if (!text) {
    return '';
  }

  lastSelectionRange = selection.getRangeAt(0).cloneRange();
  return text;
}

function applyRewrite(original: string, rewritten: string): { success: boolean; error?: string } {
  if (
    lastInputSelection &&
    document.contains(lastInputSelection.element) &&
    lastInputSelection.end >= lastInputSelection.start
  ) {
    const { element, start, end } = lastInputSelection;
    const selected = element.value.slice(start, end);
    if (!selected || selected === original) {
      const before = element.value.slice(0, start);
      const after = element.value.slice(end);
      element.value = `${before}${rewritten}${after}`;
      const nextCaret = start + rewritten.length;
      element.setSelectionRange(nextCaret, nextCaret);
      element.focus();
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    }
  }

  if (lastSelectionRange) {
    try {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(lastSelectionRange);
      const activeText = selection?.toString() || '';
      if (!activeText || activeText === original) {
        lastSelectionRange.deleteContents();
        lastSelectionRange.insertNode(document.createTextNode(rewritten));
        currentFocusElement?.dispatchEvent(new Event('input', { bubbles: true }));
        selection?.removeAllRanges();
        lastSelectionRange = null;
        return { success: true };
      }
    } catch (error) {
      console.debug('[OGrammar] Failed to apply selection rewrite:', error);
    }
  }

  if (currentFocusElement) {
    const text = extractText(currentFocusElement);
    const index = text.indexOf(original);
    if (index !== -1) {
      if (currentFocusElement.tagName === 'INPUT' || currentFocusElement.tagName === 'TEXTAREA') {
        const input = currentFocusElement as HTMLInputElement | HTMLTextAreaElement;
        input.value = `${text.slice(0, index)}${rewritten}${text.slice(index + original.length)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
      }

      currentFocusElement.textContent = `${text.slice(0, index)}${rewritten}${text.slice(index + original.length)}`;
      currentFocusElement.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    }
  }

  return { success: false, error: 'No editable selection available to rewrite.' };
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes opengrammar-fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes opengrammar-slide-in {
    from { opacity: 0; transform: translateX(100%); }
    to { opacity: 1; transform: translateX(0); }
  }
`;
document.head.appendChild(style);

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

// Listen for storage changes (e.g., when domain is disabled/enabled)
chrome.storage?.onChanged?.addListener((changes) => {
  if (changes.disabledDomains) {
    disabledDomains = changes.disabledDomains.newValue || [];
    console.log('[OGrammar] Disabled domains updated:', disabledDomains);
  }
  if (changes.autocorrectEnabled) {
    autocorrectEnabled = changes.autocorrectEnabled.newValue === true;
    if (!autocorrectEnabled) cancelPendingAutocorrect();
  }
  if (changes.autocorrectDelayMs && typeof changes.autocorrectDelayMs.newValue === 'number') {
    autocorrectDelayMs = changes.autocorrectDelayMs.newValue;
  }
  if (changes.autocorrectRejected) {
    onRejectedStorageChange(changes.autocorrectRejected.newValue);
  }
  if (changes.learnedCorrections) {
    onLearnedStorageChange(changes.learnedCorrections.newValue);
  }
});
