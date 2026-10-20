/**
 * ONE apply primitive for every editable field: <input>, <textarea>, and any
 * contenteditable — plain, Gmail, Lexical (Facebook/Messenger), Draft, ProseMirror,
 * Slate, Quill, CKEditor… There is no per-editor detection; every field gets the same
 * four steps:
 *
 *  1. FIND   — re-locate the issue's text in the field's CURRENT text (it may have
 *              moved since analysis). If it's gone, give up rather than guess.
 *  2. EDIT   — select exactly that span and drive the browser's own editing commands,
 *              execCommand('delete') then execCommand('insertText'). They fire real,
 *              trusted beforeinput/input events, so React/Vue value tracking and every
 *              rich-editor framework (each keeps its own document model) see a normal
 *              edit; the caret lands after the fix; Ctrl+Z undoes it in one step. A
 *              single insertText over the selection is NOT enough — Lexical ignores the
 *              range and inserts at its own caret, leaving the old word ("tehthe").
 *              Structural edits (a delete across lines, a new line) are offered to
 *              the editor first via a beforeinput, which Lexical needs. Only when the
 *              browser refuses the commands do we write the field directly.
 *  3. VERIFY — after the editor settles (one tick), the field must hold exactly the
 *              expected text. If the editor reverted us (Gmail and Draft sometimes do on
 *              the first try), try once more; if it landed wrong, put the text back.
 *  4. REPORT — resolve true only when the fix is really in the field.
 */
import { buildTextMap, offsetToRange, pointToOffset, resolveInString } from './textMap';

export interface Fix {
  original: string;
  offset: number;
  length: number;
  replacement: string;
}

export interface ApplyOptions {
  /** Leave the user's caret where it was (shifted past the edit) instead of after the
   *  fix — for edits the user didn't ask for at that spot, like autocorrect. */
  keepCaret?: boolean;
}

/** What the apply needs from a field, for both field families. Offsets are in the
 *  field's text coordinates (`value`, or the shared text map for contenteditable). */
interface Field {
  text(): string;
  /** Point the browser's selection at exactly [start, end) (a caret when equal).
   *  False when that can't be guaranteed — editing commands would land elsewhere. */
  select(start: number, end: number): boolean;
  /** The caret offset, or null when the caret isn't in this field. */
  caret(): number | null;
  /** Delete the current (non-empty) selection. */
  deleteSelection(): boolean;
  /** Type `text` at the caret. */
  insert(text: string): Promise<boolean>;
  /** Direct write, for when the browser refuses its editing commands. */
  write(start: number, end: number, text: string): void;
}

/** The focused element, descending through open shadow roots. */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** execCommand only edits the FOCUSED field, so never run it on any other. */
function hasFocus(el: HTMLElement): boolean {
  const active = deepActiveElement();
  return !!active && (active === el || el.contains(active));
}

function fireInput(el: HTMLElement, data: string) {
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function formField(el: HTMLInputElement | HTMLTextAreaElement): Field {
  return {
    text: () => el.value,
    select(start, end) {
      if (!hasFocus(el)) return false;
      try {
        el.setSelectionRange(start, end);
      } catch {
        return false; // email/number inputs have no selection API
      }
      return el.selectionStart === start && el.selectionEnd === end;
    },
    caret: () => (hasFocus(el) ? el.selectionEnd : null),
    deleteSelection: () => exec('delete'),
    insert: async (text) => exec('insertText', text),
    write(start, end, text) {
      const value = el.value;
      // The PROTOTYPE setter, so React/Vue value trackers notice the change.
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = value.slice(0, start) + text + value.slice(end);
      if (setValue) setValue.call(el, next);
      else el.value = next;
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        /* no selection API */
      }
      fireInput(el, text);
    },
  };
}

function richField(el: HTMLElement): Field {
  return {
    text: () => buildTextMap(el).text,
    select(start, end) {
      if (!hasFocus(el)) return false;
      const range = offsetToRange(buildTextMap(el), start, end);
      const sel = window.getSelection();
      if (!range || !sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.rangeCount === 1 && el.contains(sel.anchorNode) && el.contains(sel.focusNode);
    },
    caret() {
      const sel = window.getSelection();
      if (!sel?.focusNode || !el.contains(sel.focusNode)) return null;
      return pointToOffset(buildTextMap(el), sel.focusNode, sel.focusOffset);
    },
    deleteSelection: () => viaEditor(el, 'deleteContentBackward', 'delete'),
    async insert(text) {
      // Line by line. A new line goes in like Shift+Enter (never Enter, which chat boxes
      // treat as "send"), and each step gets a tick so an editor with its own model has
      // absorbed the previous edit before the next one.
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !viaEditor(el, 'insertLineBreak', 'insertLineBreak')) return false;
        if (lines[i] && !exec('insertText', lines[i])) return false;
        await nextTick();
      }
      return true;
    },
    write(start, end, text) {
      const range = offsetToRange(buildTextMap(el), start, end);
      if (!range) return;
      range.deleteContents();
      if (text) {
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
      }
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      fireInput(el, text);
    },
  };
}

function exec(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/**
 * Run a structural edit through the editor's own input handling first. Editors that keep
 * their own document model (Lexical — Facebook/Messenger) handle a beforeinput and cancel
 * it, and they REVERT the browser's native edit whenever it changes their paragraph
 * structure (a delete across lines, a new line). Every other field ignores the event,
 * so the browser's editing command does the edit.
 */
function viaEditor(el: HTMLElement, inputType: string, command: string): boolean {
  const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
  return !el.dispatchEvent(event) || exec(command);
}

/** Replace [start, end) with `text`: the browser's editing pipeline when it can reach
 *  the field, otherwise a direct write. */
async function replace(field: Field, start: number, end: number, text: string): Promise<void> {
  if (!field.select(start, end)) {
    field.write(start, end, text);
    return;
  }
  await nextTick(); // let an editor with its own model (Lexical) adopt the selection
  // Delete only a real selection — on a bare caret it would eat a character.
  if (end > start && !field.deleteSelection()) {
    field.write(start, end, text);
    return;
  }
  if (text && !(await field.insert(text))) field.write(start, start, text);
}

/** Compare field text, ignoring what editors change on their own: zero-width
 *  characters (Lexical/Draft), &nbsp; for spaces, quote glyphs, and the outer
 *  whitespace a trailing <br> or block adds. Inner spacing still counts, so a
 *  double-space fix is never "already done". */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/[​-‍﻿]/g, '')
      .replace(/ /g, ' ')
      .replace(/['‘’ʼ]/g, "'")
      .replace(/["“”]/g, '"')
      .trim();
  return norm(a) === norm(b);
}

/** Put `before` back after an edit landed wrong, by replacing only the region that
 *  differs (works in editors where execCommand('undo') is a no-op, e.g. Lexical). */
async function restore(field: Field, now: string, before: string): Promise<void> {
  let p = 0;
  while (p < now.length && p < before.length && now[p] === before[p]) p++;
  let s = 0;
  while (
    s < now.length - p &&
    s < before.length - p &&
    now[now.length - 1 - s] === before[before.length - 1 - s]
  ) {
    s++;
  }
  await replace(field, p, now.length - s, before.slice(p, before.length - s));
}

/** Where a caret ends up after [start, end) is replaced by `length` characters. */
function shiftCaret(caret: number, start: number, end: number, length: number): number {
  if (caret <= start) return caret; // before the edit: unaffected
  if (caret >= end) return caret + length - (end - start); // after it: shifts with the text
  return start + length; // inside the replaced text: just after the fix
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Apply one correction to any editable element. Resolves true only if the field
 * now holds the corrected text; false (with the field unchanged) if the span no
 * longer matches or the editor wouldn't take the edit.
 */
export async function applyFix(
  element: HTMLElement,
  fix: Fix,
  options: ApplyOptions = {},
): Promise<boolean> {
  if (fix.original === fix.replacement) return false;
  // tagName, not instanceof: elements inside iframes come from another realm.
  const field =
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
      ? formField(element as HTMLInputElement | HTMLTextAreaElement)
      : richField(element);

  const before = field.text();
  const span = resolveInString(before, fix.offset, fix.length, fix.original);
  if (!span) return false;
  const expected = before.slice(0, span.start) + fix.replacement + before.slice(span.end);
  const caret = options.keepCaret ? field.caret() : null;

  element.focus();
  for (let attempt = 0; attempt < 2; attempt++) {
    await replace(field, span.start, span.end, fix.replacement);
    await nextTick(); // let the editor run its own update/reconcile
    const now = field.text();
    if (sameText(now, expected)) {
      if (caret !== null) {
        const at = shiftCaret(caret, span.start, span.end, fix.replacement.length);
        field.select(at, at);
      }
      return true;
    }
    if (!sameText(now, before)) {
      await restore(field, now, before);
      return false;
    }
    // Unchanged: the editor reverted or ignored the edit — one more try.
  }
  return false;
}
