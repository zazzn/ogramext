// Opt-in debug capture for tuning. OFF by default and a no-op when off
// (the enabled flag is cached and refreshed via storage.onChanged, so a
// disabled logger costs one boolean check). When on, events are appended
// to a capped ring buffer in chrome.storage.local; the Options page can
// copy a compact, paste-friendly transcript for tuning.

const STORE_KEY = 'ogDebugLog';
const MAX_ENTRIES = 200;
const MAX_FIELD = 600; // per-field char cap so the buffer can't balloon

export type DebugKind = 'harper' | 'correct' | 'rewrite' | 'rephrase';

export interface DebugEntry {
  t: number; // epoch ms
  kind: DebugKind;
  provider?: string;
  model?: string;
  meta?: string; // tone/goal/llm-flag/etc.
  in: string;
  out: string;
}

let enabledCache = false;
let primed = false;

function prime(): void {
  if (primed) return;
  primed = true;
  chrome.storage.sync.get('debugLogging', (r) => {
    enabledCache = r.debugLogging === true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.debugLogging) {
      enabledCache = changes.debugLogging.newValue === true;
    }
  });
}
prime();

export function isDebugEnabled(): boolean {
  return enabledCache;
}

const clip = (s: unknown): string => {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length > MAX_FIELD ? `${str.slice(0, MAX_FIELD)}…[+${str.length - MAX_FIELD}]` : str;
};

export function logEvent(e: Omit<DebugEntry, 't'>): void {
  if (!enabledCache) return;
  const entry: DebugEntry = {
    t: Date.now(),
    kind: e.kind,
    provider: e.provider,
    model: e.model,
    meta: e.meta,
    in: clip(e.in),
    out: clip(e.out),
  };
  chrome.storage.local.get(STORE_KEY, (r) => {
    const buf: DebugEntry[] = Array.isArray(r[STORE_KEY]) ? r[STORE_KEY] : [];
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
    chrome.storage.local.set({ [STORE_KEY]: buf });
  });
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove(STORE_KEY);
}

async function getEntries(): Promise<DebugEntry[]> {
  const r = await chrome.storage.local.get(STORE_KEY);
  return Array.isArray(r[STORE_KEY]) ? (r[STORE_KEY] as DebugEntry[]) : [];
}

/**
 * Terse, paste-friendly transcript for tuning. One block per event:
 * time, kind, provider/model, meta, in →, out →. Designed to hand to a
 * model/maintainer to see exactly what the extension produced.
 */
export async function formatCompact(): Promise<{ text: string; count: number }> {
  const entries = await getEntries();
  const { version, version_name } = chrome.runtime.getManifest();
  const v = version_name || version;
  const lines: string[] = [
    `# OGrammar debug log v${v} — ${entries.length} event(s)`,
    `# generated ${new Date().toISOString()}`,
    '',
  ];
  for (const e of entries) {
    const ts = new Date(e.t).toISOString().slice(11, 19);
    const pm = [e.provider, e.model].filter(Boolean).join('/');
    const head = [`[${ts}]`, e.kind.toUpperCase(), pm, e.meta ? `(${e.meta})` : '']
      .filter(Boolean)
      .join(' ');
    lines.push(head, `  in : ${e.in}`, `  out: ${e.out}`, '');
  }
  return { text: lines.join('\n'), count: entries.length };
}
