import { buildTextMap, pointToOffset } from './textMap';

/**
 * Blank out forum quote blocks (`[QUOTE=...]...[/QUOTE]`, depth-aware) so we
 * never spell/grammar-check someone else's quoted post. Replaces quoted chars
 * with spaces but KEEPS newlines and overall length, so every offset the
 * backend returns still maps 1:1 to the editor text (no offset drift).
 */
export function stripQuotedBBCode(text: string): string {
  if (!/\[quote/i.test(text)) return text;
  const tokenRe = /\[quote\b[^\]]*\]|\[\/quote\]/gi;
  const chars = text.split('');
  let depth = 0;
  let blankFrom = -1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const isOpen = m[0][1] !== '/';
    if (isOpen) {
      if (depth === 0) blankFrom = m.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && blankFrom >= 0) {
        for (let i = blankFrom; i < m.index + m[0].length; i++) {
          if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        }
        blankFrom = -1;
      }
    }
  }
  // Unclosed quote (user still pasting): blank from the open tag to the end.
  if (depth > 0 && blankFrom >= 0) {
    for (let i = blankFrom; i < chars.length; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * Extracts text from an editable element
 * Handles input, textarea, and contenteditable elements
 */
export function extractText(element: HTMLElement): string {
  if (!element) return '';

  if (window.location.hostname.includes('docs.google.com')) {
    const docsText = extractGoogleDocsText(element);
    if (docsText) return docsText;
  }

  if (element.tagName === 'INPUT') {
    return (element as HTMLInputElement).value;
  }

  if (element.tagName === 'TEXTAREA') {
    return (element as HTMLTextAreaElement).value;
  }

  if (element.isContentEditable) {
    // Use the shared text map so the string we send to the backend is the SAME
    // coordinate space the offsets are later mapped back through. Never use
    // innerText here — it disagrees with the node walk and corrupts offsets.
    return buildTextMap(element).text;
  }

  // Check for role="textbox"
  if (element.getAttribute('role') === 'textbox') {
    return element.getAttribute('aria-valuetext') || element.innerText || '';
  }

  return '';
}

/**
 * Gets the HTMLElement from an event target
 * Handles shadow DOM and other edge cases
 */
export function getElementFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!target) return null;

  if (target instanceof HTMLElement) {
    if (window.location.hostname.includes('docs.google.com')) {
      const docsTarget = target.closest(
        '[contenteditable="true"], [role="textbox"], .kix-appview-editor',
      ) as HTMLElement | null;
      if (docsTarget) return docsTarget;
    }

    return target;
  }

  return null;
}

function extractGoogleDocsText(element: HTMLElement): string {
  const docsRoot =
    element.closest('[role="textbox"]') ||
    element.closest('.kix-appview-editor') ||
    document.querySelector('[role="textbox"]') ||
    document.querySelector('.kix-appview-editor');

  if (!docsRoot) return '';

  const wordNodes = docsRoot.querySelectorAll(
    '.kix-wordhtmlgenerator-word-node, .kix-lineview-text-block',
  );
  if (wordNodes.length > 0) {
    return Array.from(wordNodes)
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return docsRoot.textContent?.replace(/\s+/g, ' ').trim() || '';
}

/**
 * Gets the caret position within an editable element
 */
export function getCaretPosition(element: HTMLElement): number {
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    return (element as HTMLInputElement | HTMLTextAreaElement).selectionStart || 0;
  }

  if (element.isContentEditable) {
    // Measure through the shared text map so the caret is in the SAME coordinates as
    // extractText() (Range.toString() drops the "\n" the map adds per line break).
    const sel = window.getSelection();
    if (!sel?.focusNode || !element.contains(sel.focusNode)) return 0;
    return pointToOffset(buildTextMap(element), sel.focusNode, sel.focusOffset);
  }

  return 0;
}
