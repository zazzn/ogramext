# OGrammar

**Version 0.9** — a privacy-first, open-source writing-assistant browser
extension. A fork of [OpenGrammar](https://github.com/swadhinbiswas/opengrammar).

- Repo: <https://github.com/zazzn/ogramext>
- License: Apache-2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE))

There is no hosted service, account, or documentation site — everything
runs in the extension and talks directly to the LLM provider you choose.

## How it works — two strictly separated tiers

1. **Inline (mechanical only) — fully offline, no network.**
   Spelling, capitalization and punctuation are checked on-device by the
   [Harper](https://github.com/Automattic/harper) engine (Rust →
   WebAssembly, Apache-2.0) in the extension's service worker. Instant,
   private, no API key, no internet. A local n-gram re-ranker improves
   spelling-candidate ordering. This tier is always on.

2. **Grammar & Tone — explicit, never automatic.**
   Whole-text/sentence correction and tone rewriting use an LLM. The
   extension calls **your chosen provider directly — there is no backend.**
   Your API key is stored encrypted on-device (AES-GCM, never synced) and
   sent only to the provider you pick.

Inline checking never hits the network. The LLM is only used when you
explicitly ask for it (the review card's “Improve”, or the selection
bubble below).

## Features

- **Tone rewrite** — highlight any text in an editable field (errors or
  not) and a pen appears; or, when the field has nothing to fix, click the
  OGrammar badge to rewrite the whole message. Pick **Polish / Formal /
  Casual** and it shows a **preview you must Apply or Cancel** (nothing
  changes until you confirm; pick another tone to re-preview).
- **Sentence review card** — click an inline issue for the corrected
  version with the same Improve preview/confirm flow.
- **Direct multi-provider LLM** — OpenAI · OpenRouter · Groq · Together AI ·
  Abacus RouteLLM · Ollama (local) · any custom OpenAI-compatible endpoint.
  Provider, model and key are set in the popup.
- **Ollama support** — model list is read live from the server
  (`/api/tags`); switching models unloads the old one and shows
  load progress; idle keep-alive control and a manual **Unload now**
  button to free VRAM (e.g. before gaming). An in-app **GPU guide**
  (Options) recommends a model for your card, GTX-10 → RTX-50 series.
- **Page-aware autocomplete (opt-in, off by default)** — when enabled,
  next-phrase completions are grounded in the page you're viewing
  (title + URL + main visible text is sent to your provider).
- **Debug & Tuning (Options, off by default)** — capture recent
  corrections/rewrites locally and copy a compact log to share for
  tuning. Nothing leaves the device unless you copy it.
- **Enable toggle** lives in the popup (the main extension click).

Removed in 0.9: the self-hosted backend dependency, the right-click
context menu, the separate Rephrase and Stats pages/shortcuts, and the
"Check as you type" / "Show notifications" toggles (inline is always on;
toasts are gone). Usage analytics are still viewable in Options.

## Install (unpacked)

```bash
cd extension
npm install
npm run build
```

Chrome → `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `extension/dist`. Open the popup, set your provider +
API key (or Ollama). No backend URL — there isn't one.

### Local Ollama note

Two things to know when pointing OGrammar at a local Ollama:

**1. Allow the extension's origin (required).** Ollama checks the
`Origin` header on every non-GET request and rejects anything not on its
allowlist with HTTP 403. The extension's origin
(`chrome-extension://<id>`) is never on the default list, so you must
opt it in via `OLLAMA_ORIGINS`. Symptom if you skip this: the model
dropdown populates fine, but the status pill stays on "Online · model
not loaded" and no rewrite/correction ever succeeds.

- **Linux / WSL (systemd):**
  ```bash
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
  [Service]
  Environment="OLLAMA_ORIGINS=chrome-extension://*"
  EOF
  sudo systemctl daemon-reload
  sudo systemctl restart ollama
  ```
- **macOS** (Ollama.app): `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"`, then quit and restart the Ollama menu-bar app.
- **Windows** (Ollama desktop): set the user env var
  `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama.
- **Foreground / debugging**: `OLLAMA_ORIGINS='chrome-extension://*' ollama serve`.

**2. LAN reachability.** Browsers block plain-HTTP requests from an
extension to a private LAN IP. Run Ollama on the same machine, or
expose it at `http://localhost:11434` via an SSH local forward and set
that as the Ollama URL in the popup:

```bash
ssh -L 11434:localhost:11434 your-ollama-host
```

Cloud providers need none of this (they're public HTTPS and don't have
Ollama's origin restriction).

## Privacy

- Inline mechanical checks are 100% local — text never leaves the device.
- Grammar/Tone and (opt-in) autocomplete send text — and, for
  autocomplete, page context — only to the LLM provider you chose.
- API keys are encrypted at rest and never synced.
- Google Docs is intentionally out of scope (canvas-rendered).

## Attribution

OGrammar is a derivative work of OpenGrammar by Swadhin Biswas, used
under the Apache License 2.0, and bundles the Automattic Harper engine
(Apache-2.0). Significant changes are summarized in [`NOTICE`](NOTICE).
Retain `LICENSE` and `NOTICE` when redistributing.
