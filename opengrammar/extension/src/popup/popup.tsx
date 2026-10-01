/**
 * OGrammar Popup — React UI
 * Layout: Header → Issue summary → AI card → Settings → Footer
 */
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './popup.css';
import type { ProviderConfig } from '../types';
import { getApiKey, setApiKey } from '../shared/apiKeyStore';
import {
  DEFAULT_WRITING_MODEL,
  hiddenOllamaWritingModels,
  ollamaWritingModelLabel,
  pickRecommendedOllamaWritingModel,
  visibleOllamaWritingModels,
} from '../shared/ollamaModels';

interface Settings {
  enabled: boolean;
  apiKey: string;
  model: string;
  provider: string;
  customBaseUrl: string;
  ollamaUrl: string;
  ollamaKeepAlive: string;
}

/** Normalize an Ollama server URL to its OpenAI-compatible /v1 base. */
export function ollamaV1(url: string): string {
  const b = (url || 'http://localhost:11434').trim().replace(/\/+$/, '');
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

/* ─── Icon components ─── */
const EyeIcon = ({ show }: { show: boolean }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
    {!show && <line x1="1" y1="1" x2="23" y2="23" />}
  </svg>
);
const SettingsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const ChevronIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

/* ─── Issue summary (live breakdown of issues found on the page) ─── */
const IssueSummary = ({ issueStats }: { issueStats: any }) => (
  <>
    <div className="score-section">
      <div className="score-info">
        <h2>{issueStats.total === 0 ? 'No issues found' : 'Issues detected'}</h2>
        <p>
          {issueStats.total === 0
            ? 'No issues found on this page.'
            : `${issueStats.total} issue${issueStats.total !== 1 ? 's' : ''} detected — click underlined text to fix.`}
        </p>
      </div>
    </div>
    <div className="issue-chips">
      {issueStats.total === 0 ? (
        <span className="chip ok"><span className="chip-dot" />All clear</span>
      ) : (
        <>
          {issueStats.grammar > 0 && <span className="chip grammar"><span className="chip-dot" />{issueStats.grammar} grammar</span>}
          {issueStats.clarity > 0 && <span className="chip clarity"><span className="chip-dot" />{issueStats.clarity} clarity</span>}
          {issueStats.style > 0 && <span className="chip style"><span className="chip-dot" />{issueStats.style} style</span>}
        </>
      )}
    </div>
  </>
);

/* ─── Settings Panel ─── */
const SettingsPanel = ({
  settings,
  saveSettings,
  providers,
  selectedProvider,
  modelList,
  fetchingModels,
  handleProviderChange,
  showApiKey,
  setShowApiKey,
  showAdvanced,
  setAdvanced,
  advancedRef,
  scanModels,
  scannedCount,
  hiddenOllamaModels,
  ollamaStatus,
  testOllama,
  ollamaSwitch,
  unloadNow,
  unloadMsg,
  pullRecommended,
  pullingModel,
  pullMsg,
}: any) => (
  <div className={`settings-area ${!settings.enabled ? 'muted' : ''}`}>
    <div className="field-group">
      <label className="field-label">AI Provider</label>
      <select value={settings.provider} onChange={handleProviderChange} className="select-input">
        {providers.map((p: any) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {selectedProvider && <p className="field-hint">{selectedProvider.description}</p>}
    </div>

    {settings.provider === 'custom' && (
      <div className="field-group">
        <label className="field-label">Custom Base URL</label>
        <input
          type="url"
          value={settings.customBaseUrl}
          onChange={(e) => saveSettings({ customBaseUrl: e.target.value })}
          placeholder="https://your-api.com/v1"
          className="text-input"
        />
      </div>
    )}

    {selectedProvider?.requiresApiKey && (
      <div className="field-group">
        <label className="field-label">API Key <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: '#aeaeb2' }}>— stored locally</span></label>
        <div className="input-row">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={settings.apiKey}
            onChange={(e) => saveSettings({ apiKey: e.target.value })}
            placeholder="sk-…"
            className="text-input"
          />
          <button type="button" onClick={() => setShowApiKey((v: boolean) => !v)} className="icon-btn" title={showApiKey ? 'Hide' : 'Show'}>
            <EyeIcon show={showApiKey} />
          </button>
        </div>
      </div>
    )}

    <div className="field-group">
      <label className="field-label">Model</label>
      <select
        value={settings.model}
        onChange={(e) => saveSettings({ model: e.target.value })}
        className="select-input"
        disabled={fetchingModels}
      >
        {fetchingModels
          ? <option>Loading…</option>
          : modelList.map((m: string) => {
              const rec = settings.provider === 'ollama' ? pickRecommendedOllamaWritingModel(modelList) : null;
              const label = settings.provider === 'ollama' ? ollamaWritingModelLabel(m, rec) : '';
              return <option key={m} value={m}>{m}{label ? `  (${label})` : ''}</option>;
            })}
      </select>
      {settings.provider === 'ollama' && (() => {
        const rec = pickRecommendedOllamaWritingModel(modelList);
        const hidden = hiddenOllamaModels || [];
        const missingDefault = !modelList.includes(DEFAULT_WRITING_MODEL);
        return (
          <>
            {rec && (
              <p className="field-hint" style={{ marginTop: 5 }}>
                Recommended from installed writing models: <strong>{rec}</strong>
              </p>
            )}
            {hidden.length > 0 && (
              <p className="field-hint" style={{ marginTop: 5 }}>
                Hidden from this list: {hidden.length} code/embed/vision/math model{hidden.length !== 1 ? 's' : ''}.
              </p>
            )}
            {missingDefault && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}
                  title={`Pull ${DEFAULT_WRITING_MODEL} from Ollama`}
                  onClick={() => pullRecommended && pullRecommended()}
                  disabled={!!pullingModel}
                >
                  {pullingModel ? 'Pulling…' : `Pull ${DEFAULT_WRITING_MODEL}`}
                </button>
                <span className="status-text" style={{ flex: 1 }}>{pullMsg || ''}</span>
              </div>
            )}
          </>
        );
      })()}
    </div>

    {settings.provider === 'ollama' && (
      <button type="button" className={`advanced-toggle ${showAdvanced ? 'open' : ''}`} onClick={() => setAdvanced((v: boolean) => !v)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><SettingsIcon /> Advanced settings</span>
        <ChevronIcon />
      </button>
    )}

    {showAdvanced && settings.provider === 'ollama' && (
      <div className="advanced-panel" ref={advancedRef}>
        <div className="field-group">
            <label className="field-label">Ollama Server URL</label>
            <p className="field-hint" style={{ marginBottom: 5 }}>Default: http://localhost:11434</p>
            <div className="input-row">
              <input
                type="url"
                value={settings.ollamaUrl}
                onChange={(e) => saveSettings({ ollamaUrl: e.target.value })}
                onBlur={() => scanModels()}
                placeholder="http://localhost:11434"
                className="text-input"
              />
              <button
                type="button"
                className="icon-btn"
                title="Scan installed models"
                onClick={() => scanModels()}
                disabled={fetchingModels}
              >↻</button>
            </div>
            <p className="field-hint" style={{ marginTop: 5 }}>
              {fetchingModels
                ? 'Scanning…'
                : scannedCount > 0
                  ? `${scannedCount} model${scannedCount !== 1 ? 's' : ''} found`
                  : 'No models found — is Ollama running at this URL?'}
            </p>
            {ollamaSwitch?.active ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                {ollamaSwitch.phase === 'error' ? (
                  <>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#e53935', flexShrink: 0 }} />
                    <span className="status-text" style={{ flex: 1, color: '#e53935' }}>
                      {ollamaSwitch.error || 'Switch failed'}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 'auto', padding: '3px 9px', fontSize: 12 }}
                      title="Retry loading the selected model"
                      onClick={() => testOllama && testOllama()}
                    >Retry</button>
                  </>
                ) : (
                  <>
                    <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2, flexShrink: 0 }} />
                    <span className="status-text" style={{ flex: 1 }}>
                      {ollamaSwitch.phase === 'unloading'
                        ? 'Unloading previous model…'
                        : `Loading ${ollamaSwitch.model}… (${ollamaSwitch.elapsed}s)`}
                    </span>
                  </>
                )}
              </div>
            ) : (() => {
              const st = ollamaStatus || {};
              const color = st.testing
                ? '#f59e0b'
                : !st.reachable
                  ? '#e53935'
                  : st.modelReady
                    ? '#16a34a'
                    : '#f59e0b';
              const label = st.testing
                ? 'Testing model…'
                : !st.reachable
                  ? 'Server offline'
                  : st.modelReady
                    ? 'Ready · model loaded'
                    : st.error
                      ? st.error
                      : 'Online · model not loaded (loads on first use)';
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span className="status-text" style={{ flex: 1 }}>{label}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 'auto', padding: '3px 9px', fontSize: 12 }}
                    title="Load the selected model and confirm it responds"
                    onClick={() => testOllama && testOllama()}
                    disabled={st.testing || !st.reachable}
                  >Test</button>
                </div>
              );
            })()}
            <div style={{ marginTop: 10 }}>
              <label className="field-label">Unload model when idle</label>
              <select
                className="select-input"
                value={settings.ollamaKeepAlive}
                onChange={(e) => saveSettings({ ollamaKeepAlive: e.target.value })}
              >
                <option value="0">Immediately after each use</option>
                <option value="30s">After 30 seconds idle</option>
                <option value="2m">After 2 minutes idle</option>
                <option value="5m">After 5 minutes idle</option>
                <option value="-1">Never — keep loaded</option>
              </select>
              <p className="field-hint" style={{ marginTop: 5 }}>
                Returns system/VRAM when not in use. Shorter frees memory sooner;
                longer keeps repeat checks fast.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
                  title="Evict the model from VRAM now (free GPU before gaming / heavy tasks)"
                  onClick={() => unloadNow && unloadNow()}
                >Unload now</button>
                <span className="status-text" style={{ flex: 1 }}>{unloadMsg || ''}</span>
              </div>
              <p className="field-hint" style={{ marginTop: 5 }}>
                Free the GPU before launching a game or other GPU-heavy task.
                The extension can’t detect a game starting — use this, or a
                short idle setting above. See Options → “Which model for my
                GPU?” for sizing.
              </p>
            </div>
          </div>
      </div>
    )}
  </div>
);

/* ─── Main Popup Component ─── */
const Popup = () => {
  const [settings, setSettings] = useState<Settings>({
    enabled: true, apiKey: '', model: 'gpt-4o-mini',
    provider: 'openai', customBaseUrl: '', ollamaUrl: 'http://localhost:11434', ollamaKeepAlive: '2m',
  });
  const [providerModelMemory, setProviderModelMemory] = useState<Record<string, string>>({});
  const [showApiKey, setShowApiKey]   = useState(false);
  const [loading, setLoading]         = useState(true);
  const [providers, setProviders]     = useState<ProviderConfig[]>([]);
  const [availableModels, setModels]  = useState<string[]>([]);
  const [hiddenOllamaModels, setHiddenOllamaModels] = useState<string[]>([]);
  const [fetchingModels, setFetching] = useState(false);
  const [showAdvanced, setAdvanced]   = useState(false);
  const [issueStats, setIssueStats]   = useState({ grammar: 0, style: 0, clarity: 0, total: 0 });
  const [ollamaStatus, setOllamaStatus] = useState<{ reachable: boolean; running: string[]; modelReady: boolean; testing: boolean; error?: string }>({ reachable: false, running: [], modelReady: false, testing: false });
  const [ollamaSwitch, setOllamaSwitch] = useState<{ active: boolean; phase: 'unloading' | 'loading' | 'error'; model: string; elapsed: number; error?: string }>({ active: false, phase: 'loading', model: '', elapsed: 0 });
  const [unloadMsg, setUnloadMsg] = useState('');
  const [pullingModel, setPullingModel] = useState('');
  const [pullMsg, setPullMsg] = useState('');
  const lastOllamaModel = useRef<string | null>(null);
  const switchTimer = useRef<number | null>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  // Only the latest GET_MODELS request may update state; an older one that
  // returns late would show the previous provider's or URL's models.
  const modelsRequest = useRef(0);

  useEffect(() => { loadSettings(); loadProviders(); loadIssueStats(); }, []);
  useEffect(() => {
    if (
      !settings.provider ||
      (settings.provider !== 'ollama' && !settings.apiKey) ||
      (settings.provider === 'custom' && !settings.customBaseUrl)
    ) {
      modelsRequest.current++;
      setModels([]);
      setHiddenOllamaModels([]);
      return;
    }

    const timer = setTimeout(loadModels, 300);
    return () => clearTimeout(timer);
  }, [settings.provider, settings.apiKey, settings.customBaseUrl, settings.ollamaUrl]);
  useEffect(() => {
    if (settings.provider !== 'ollama') {
      lastOllamaModel.current = null;
      if (switchTimer.current) { clearInterval(switchTimer.current); switchTimer.current = null; }
      setOllamaSwitch((s) => (s.active ? { ...s, active: false } : s));
      return;
    }
    if (!settings.ollamaUrl) return;
    const prev = lastOllamaModel.current;
    lastOllamaModel.current = settings.model;
    if (prev && prev !== settings.model) void applyOllamaSwitch(prev, settings.model);
    else void checkOllama(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, settings.ollamaUrl, settings.model]);

  // Switching Ollama models: evict the old (return VRAM) then force-load
  // the new, with honest phase + elapsed feedback (Ollama gives no load %).
  const applyOllamaSwitch = async (oldModel: string, newModel: string) => {
    if (switchTimer.current) { clearInterval(switchTimer.current); switchTimer.current = null; }
    const startedAt = Date.now();
    setOllamaSwitch({ active: true, phase: 'unloading', model: newModel, elapsed: 0 });
    switchTimer.current = setInterval(() => {
      setOllamaSwitch((s) =>
        s.active ? { ...s, elapsed: Math.round((Date.now() - startedAt) / 1000) } : s,
      );
    }, 1000) as unknown as number;
    const baseUrl = ollamaV1(settings.ollamaUrl);
    const stop = () => {
      if (switchTimer.current) { clearInterval(switchTimer.current); switchTimer.current = null; }
    };
    try {
      await chrome.runtime.sendMessage({ type: 'OLLAMA_UNLOAD', baseUrl, model: oldModel });
      setOllamaSwitch((s) => ({ ...s, phase: 'loading' }));
      const r = await chrome.runtime.sendMessage({
        type: 'GET_OLLAMA_STATUS',
        baseUrl,
        model: newModel,
        probe: true,
      });
      stop();
      if (r?.modelReady) {
        setOllamaSwitch({ active: false, phase: 'loading', model: newModel, elapsed: 0 });
        setOllamaStatus({ reachable: !!r.reachable, running: r.running || [], modelReady: true, testing: false });
      } else {
        setOllamaSwitch({
          active: true,
          phase: 'error',
          model: newModel,
          elapsed: Math.round((Date.now() - startedAt) / 1000),
          error: r?.error || (r?.reachable ? 'Model failed to load' : 'Ollama server offline'),
        });
        setOllamaStatus({ reachable: !!r?.reachable, running: r?.running || [], modelReady: false, testing: false });
      }
    } catch {
      stop();
      setOllamaSwitch({ active: true, phase: 'error', model: newModel, elapsed: 0, error: 'Switch failed' });
    }
  };

  const loadSettings = () => {
    chrome.storage.sync.get(['enabled', 'model', 'provider', 'customBaseUrl', 'ollamaUrl', 'ollamaKeepAlive', 'providerModelMemory'], (result) => {
      const memory = (result.providerModelMemory || {}) as Record<string, string>;
      const selectedProvider = result.provider || 'openai';
      setSettings({
        enabled: result.enabled !== false, apiKey: '', model: memory[selectedProvider] || result.model || 'gpt-4o-mini',
        provider: selectedProvider, customBaseUrl: result.customBaseUrl || '',
        ollamaUrl: result.ollamaUrl || 'http://localhost:11434',
        ollamaKeepAlive: result.ollamaKeepAlive || '2m',
      });
      setProviderModelMemory(memory);
      setLoading(false);
      // API key lives in the encrypted store (chrome.storage.local), not sync.
      void getApiKey().then((k) => setSettings((s) => ({ ...s, apiKey: k })));
    });
  };

  const loadProviders = async () => { try { const r = await chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }); if (r.providers) setProviders(r.providers); } catch {} };

  const loadModels = async () => {
    const request = ++modelsRequest.current;
    setFetching(true);
    const baseUrl =
      settings.provider === 'custom'
        ? settings.customBaseUrl
        : settings.provider === 'ollama'
          ? ollamaV1(settings.ollamaUrl)
          : undefined;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_MODELS', provider: settings.provider, apiKey: settings.apiKey, baseUrl });
      if (request !== modelsRequest.current) return;
      const models: string[] = r?.models || [];
      const displayModels =
        settings.provider === 'ollama' ? visibleOllamaWritingModels(models) : models;
      setModels(displayModels);
      setHiddenOllamaModels(settings.provider === 'ollama' ? hiddenOllamaWritingModels(models) : []);
      // For Ollama, default to the recommended model if the user hasn't
      // explicitly picked a visible writing model that's actually installed.
      if (settings.provider === 'ollama' && models.length) {
        const rec = pickRecommendedOllamaWritingModel(models);
        if (rec && !displayModels.includes(settings.model)) saveSettings({ model: rec });
      }
      // Custom has no static fallback, so pick the first listed model rather
      // than leave the model empty (the background would send gpt-4o-mini).
      if (settings.provider === 'custom' && displayModels.length && !displayModels.includes(settings.model)) {
        saveSettings({ model: displayModels[0] });
      }
    } catch {} finally { if (request === modelsRequest.current) setFetching(false); }
  };

  const checkOllama = async (probe: boolean) => {
    if (probe) setOllamaStatus((s) => ({ ...s, testing: true, error: undefined }));
    try {
      const req = {
        type: 'GET_OLLAMA_STATUS',
        baseUrl: ollamaV1(settings.ollamaUrl),
        model: settings.model,
        probe,
      };
      console.log('[OGrammar] checkOllama →', req);
      const r = await chrome.runtime.sendMessage(req);
      console.log('[OGrammar] checkOllama ←', r);
      setOllamaStatus({
        reachable: !!r?.reachable,
        running: r?.running || [],
        modelReady: !!r?.modelReady,
        testing: false,
        error: r?.error,
      });
    } catch (e) {
      console.error('[OGrammar] checkOllama failed', e);
      setOllamaStatus({ reachable: false, running: [], modelReady: false, testing: false, error: String(e) });
    }
  };

  // Manually evict the model from VRAM (free the GPU before gaming etc.).
  const unloadNow = async () => {
    setUnloadMsg('Unloading…');
    try {
      await chrome.runtime.sendMessage({
        type: 'OLLAMA_UNLOAD',
        baseUrl: ollamaV1(settings.ollamaUrl),
        model: settings.model,
      });
      setOllamaStatus((s) => ({ ...s, modelReady: false, running: [] }));
      setUnloadMsg('Unloaded — VRAM freed');
    } catch {
      setUnloadMsg('Unload failed');
    }
    setTimeout(() => setUnloadMsg(''), 5000);
  };

  const pullRecommended = async () => {
    const model = DEFAULT_WRITING_MODEL;
    setPullingModel(model);
    setPullMsg('Downloading model…');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'OLLAMA_PULL',
        baseUrl: ollamaV1(settings.ollamaUrl),
        model,
      });
      if (r?.success) {
        setPullMsg('Installed');
        await loadModels();
        saveSettings({ model });
        void checkOllama(true);
      } else {
        setPullMsg(r?.error || 'Pull failed');
      }
    } catch (error) {
      setPullMsg(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setPullingModel('');
      setTimeout(() => setPullMsg(''), 7000);
    }
  };

  const loadIssueStats = () => { chrome.storage.local.get(['lastIssueStats'], (r) => { if (r.lastIssueStats) setIssueStats(r.lastIssueStats as typeof issueStats); }); };

  const saveSettings = (updates: Partial<Settings>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    const mem = { ...providerModelMemory, ...(next.provider ? { [next.provider]: next.model } : {}) };
    setProviderModelMemory(mem);
    // The API key never goes to chrome.storage.sync — it's encrypted at rest
    // in chrome.storage.local via the shared keyStore.
    const { apiKey: _apiKey, ...syncable } = next;
    chrome.storage.sync.set({ ...syncable, providerModelMemory: mem });
    if ('apiKey' in updates) void setApiKey(updates.apiKey ?? '');
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const p = e.target.value;
    // Ollama models are resolved live from /api/tags; don't seed a static
    // or default name (it would 404 until the live picker fills it in).
    const fallback = p === 'ollama' || p === 'custom' ? '' : providers.find((x) => x.id === p)?.models[0] || 'gpt-4o-mini';
    saveSettings({ provider: p, model: providerModelMemory[p] || fallback });
  };

  const selectedProvider = providers.find((p) => p.id === settings.provider);
  const modelList = availableModels.length > 0 ? availableModels : selectedProvider?.models || [];

  if (loading) return <div className="load-screen"><div className="spinner" /><p>Loading…</p></div>;

  return (
    <div>
      <header className="popup-header">
        <div className="brand">
          <div className="brand-icon"><svg viewBox="0 0 128 128" fill="none" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#16191D"/><circle cx="64" cy="52" r="26" fill="none" stroke="#F4F6F4" strokeWidth="11"/><path d="M36 93 q7 -11 14 0 t14 0 t14 0 t14 0" fill="none" stroke="#34C77F" strokeWidth="8" strokeLinecap="round"/></svg></div>
          <span className="brand-name">O<span>Grammar</span></span>
        </div>
        <button className={`status-pill ${settings.enabled ? 'active' : 'paused'}`} onClick={() => saveSettings({ enabled: !settings.enabled })} title={settings.enabled ? 'Click to pause' : 'Click to enable'}>
          <span className="dot" />{settings.enabled ? 'Active' : 'Paused'}
        </button>
      </header>

      <IssueSummary issueStats={issueStats} />

      <div className="ai-card">
        <div className="ai-card-left"><strong>AI Engine</strong><span>{selectedProvider?.requiresApiKey && !settings.apiKey ? 'Off — add a key for AI suggestions' : `${selectedProvider?.name || 'OpenAI'} · ${settings.model}`}</span></div>
      </div>

      <hr className="divider" />
      
      <SettingsPanel
        settings={settings} saveSettings={saveSettings} providers={providers} selectedProvider={selectedProvider} modelList={modelList}
        fetchingModels={fetchingModels} handleProviderChange={handleProviderChange} showApiKey={showApiKey} setShowApiKey={setShowApiKey}
        showAdvanced={showAdvanced} setAdvanced={setAdvanced} advancedRef={advancedRef}
        scanModels={loadModels} scannedCount={availableModels.length + hiddenOllamaModels.length}
        hiddenOllamaModels={hiddenOllamaModels}
        ollamaStatus={ollamaStatus} testOllama={() => checkOllama(true)}
        ollamaSwitch={ollamaSwitch}
        unloadNow={unloadNow} unloadMsg={unloadMsg}
        pullRecommended={pullRecommended} pullingModel={pullingModel} pullMsg={pullMsg}
      />

      {/* ── Footer ── */}
      <footer className="popup-footer">
        <button onClick={() => chrome.runtime.openOptionsPage()} className="footer-btn">
          <SettingsIcon />
          Open full settings
        </button>
      </footer>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
