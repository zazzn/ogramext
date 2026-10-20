# 🤖 AI Provider Setup Guide

Configure the optional **LLM tier** that powers sentence-level review and tone
rewriting. Set the provider in the extension's **Options**.

OGrammar is **bring-your-own-key**: it calls your chosen provider directly with your
own key — there is no OGrammar backend, and nothing is proxied through us. The local
**Harper** engine always works without a key; a provider is only needed for the LLM
tier.

> **All quality numbers on this page are measured on OGrammar's own 46-case
> proofreading corpus** (weighted score out of 123), with protected-text masking on —
> not vendor marketing. Full methodology and per-model tables live in
> [25-local-llm-model-benchmark.md](25-local-llm-model-benchmark.md). Providers we
> have **not** scored on that corpus are labelled *not scored* — we don't invent numbers.

---

## ⭐ TL;DR — what to pick

| If you want… | Pick | Why |
|---|---|---|
| **Private / free / offline** | **Ollama → `qwen3.5:4b`** | Best local model tested: **123/123**, 0 hard failures, ~1 s on a GPU. The shipped default. |
| **Best quality + cheapest cloud** | **DeepSeek → `deepseek-chat`** | Ties the top score (**123/123**, 0 hard failures) and is the cheapest paid option (~**$0.00004 / correction** with prompt caching). |
| **Lowest latency cloud** | **Groq → `llama-3.3-70b-versatile`** | ~**400 ms** round-trip (97/123) when in-browser speed matters more than peak accuracy. |
| **Flat monthly fee, smart routing** | **Abacus RouteLLM → `route-llm`** | 120/123, ~$10/mo flat instead of per-token. |

Everything else (OpenAI, OpenRouter, Together) works fine and is widely capable, but
has **not** been scored on our corpus — see the table below.

---

## How the LLM tier works

- **Harper (local, always on)** catches spelling and rule-based grammar instantly, with
  no key and no network. This is the inline tier.
- **The LLM tier (optional)** runs on the *proactive* correction path — it reviews whole
  sentences for context errors the rules miss, and powers **tone rewriting** (Polish /
  Formal / Casual). It is a deferred/background tier, never inline, because even the
  fastest cloud call (~400 ms) is far slower than the local engine (~5 ms).
- **Protected text** (URLs, emails, file paths, code, IDs, versions, @handles) is guarded on
  every AI call: the model is told exactly which fragments to leave alone, and any
  correction or tone rewrite that changes one is **discarded** — that check, not the model's
  own restraint, is the guarantee. Full **masking** (sending placeholders instead of the
  fragments) is an opt-in in Options; it's off by default because it strips context the
  model needs on jargon-heavy text.

---

## 📋 Provider comparison

| Provider | Our recommended model | OGrammar score | Latency | Cost | Privacy |
|----------|----------------------|:--------------:|---------|------|---------|
| **Ollama** (local) | `qwen3.5:4b` | **123/123** ✓ | ~1 s (GPU) | Free | 100% local |
| **DeepSeek** | `deepseek-chat` | **123/123** ✓ | ~1–2 s | ~$0.00004/corr | Cloud |
| **Abacus RouteLLM** | `route-llm` | 120/123 ✓ | ~2 s | ~$10/mo flat | Cloud |
| **Groq** | `gpt-oss-20b` / `llama-3.3-70b-versatile` | 117 / 97 ✓† | 0.4–3 s | ¢/month | Cloud (free tier) |
| **OpenAI** | `gpt-4o-mini` | *not scored* | ~1–2 s | $ | Cloud |
| **OpenRouter** | varies (100+ models) | *not scored* | varies | varies | Cloud |
| **Together AI** | `Llama-3.x-70B` | *not scored* | ~1 s | $ | Cloud |
| **Custom** | your endpoint | — | — | — | depends |

✓ = measured on OGrammar's 46-case corpus **with masking** (docs/25).
† Groq was scored **before** masking landed, so its numbers are a slight *under*-estimate
relative to the masked rows. All providers use an OpenAI-compatible API.

---

## 🦙 Ollama — local, private, free (recommended default)

The shipped local default. Runs entirely on your machine; no key, no network.

### Install & pull

```bash
# Linux:
curl -fsSL https://ollama.com/install.sh | sh
# macOS:  brew install ollama
# Windows: download the installer from https://ollama.com

ollama serve                 # start the service
ollama pull qwen3.5:4b       # the recommended model (~2.5 GB)
```

### Configure

| Setting | Value |
|---|---|
| Provider | **Ollama (Local)** |
| Base URL | `http://localhost:11434/v1` |
| Model | `qwen3.5:4b` |
| API Key | *(leave empty)* |

> **Running Ollama in WSL?** Use `http://127.0.0.1:11434/v1`, **not** `localhost` —
> Windows resolves `localhost` to IPv6 (`::1`), which WSL's mirrored loopback doesn't
> forward, so the connection silently fails. `127.0.0.1` also works for a native
> install, so it's always a safe choice.

OGrammar talks to Ollama over its **native `/api/chat`** API under the hood (pinned to a
4096-token context, `think:false`). That's why the Qwen 3 / 3.5 "thinking" tags work here
— on the older OpenAI-compatible path they returned empty content.

### Recommended local models (measured, masking on)

| Model | RAM | OGrammar score | Latency | Notes |
|-------|-----|:--------------:|---------|-------|
| **`qwen3.5:4b`** | ~6 GB | **123/123** | ~1.0 s | **Best local — the default.** 0 hard failures, full sentence-review. |
| `qwen2.5:7b` | ~8 GB | 121/123 | ~2.1 s | Strong alternate; slower. |
| `qwen3:latest` | ~6 GB | 119/123 | ~1.0 s | Solid all-rounder. |
| `qwen3:4b-instruct` | ~6 GB | 113/123 | **~0.7 s** | **Fastest local**, 0 hard failures, but weaker on sentence-level review. |

Smaller models (`qwen3.5:0.8b`, `gemma3:4b`, the old `qwen2.5:1.5b`) score materially
lower or can't do sentence review — only choose them if `qwen3.5:4b` is too heavy for your
hardware. A GPU is strongly recommended; CPU-only inference is several times slower.

---

## 🟣 DeepSeek — best overall quality, cheapest cloud

The strongest proofreader we tested and the cheapest paid option.

### Setup

1. Create a key at [platform.deepseek.com](https://platform.deepseek.com).
2. Provider: **DeepSeek** · API Key: `sk-…` · Model: **`deepseek-chat`**.

### Why deepseek-chat

- **123/123**, **zero hard failures**, perfect protected-span and no-false-positive scores
  — ties the best local model and matches the top of every cloud run.
- **~$0.00004 per correction** with prompt caching (our fixed proofreading system prompt
  is cached), i.e. pennies per month for normal use. See the cost table below.
- ~1–2 s latency.

> Avoid **`deepseek-reasoner`** for proofreading: it scored lower (115/123) *and* slower,
> with JSON-mode failures — the classic thinking-model + strict-JSON risk. `deepseek-chat`
> is the right pick.

---

## ⚡ Groq — lowest latency, generous free tier

Fastest responses thanks to Groq's LPU hardware; a generous (rate-limited) free tier.

### Setup

1. Sign up at [console.groq.com](https://console.groq.com) → **API Keys** → create
   (key starts with `gsk_`).
2. Provider: **Groq** · API Key: `gsk_…` · Model: see below.

> Groq rotates its hosted models periodically. If a name is rejected, check
> [console.groq.com/docs/models](https://console.groq.com/docs/models) and pick the
> closest equivalent. The free tier is **rate-limited** — bursts return `429`s, so OGrammar
> paces and retries Groq calls automatically.

### Recommended Groq models (measured, pre-masking)

| Model | OGrammar score | Latency | Best for |
|-------|:--------------:|---------|----------|
| **`gpt-oss-20b`** | **117/123** | ~3.3 s | **Best Groq quality.** Reasoning model — accurate but ~3–4× the output tokens. |
| `qwen3-32b` | 113/123 | ~4.5 s | Quality alternate. |
| `gpt-oss-120b` | 112/123 | ~2.6 s | Large reasoning model. |
| **`llama-3.3-70b-versatile`** | 97/123 | **~0.4 s** | **Fastest** — pick this when latency beats peak accuracy. |
| `llama-4-scout-17b` | 88/123 | ~0.4 s | Fast, lower quality. |
| ~~`llama-3.1-8b-instant`~~ | 76/123 | ~1.6 s | **Skip for proofreading** — 13 hard failures. |

---

## 🔀 Abacus RouteLLM — flat fee, smart routing

Routes each request across several top models for you. Solid quality (120/123, best
sentence-review in cloud runs) at a **flat ~$10/month** subscription instead of per-token
billing. Setup is identical: select **Abacus RouteLLM**, paste your key, use model
`route-llm`. A good fit if you'd rather not meter tokens.

---

## 🟢 OpenAI · 🌐 OpenRouter · 🔷 Together AI — capable, but not scored by us

These all work and are widely capable general models, but we **have not** run them through
OGrammar's corpus, so we don't quote a score. Configure them like any other provider:

| Provider | Get a key | Suggested model | Base URL |
|----------|-----------|-----------------|----------|
| **OpenAI** | [platform.openai.com](https://platform.openai.com) → API Keys (`sk-…`) | `gpt-4o-mini` (cheap) or `gpt-4o` (premium) | `https://api.openai.com/v1` |
| **OpenRouter** | [openrouter.ai](https://openrouter.ai) → Keys | e.g. `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b` | `https://openrouter.ai/api/v1` |
| **Together AI** | [api.together.ai](https://api.together.ai) → API Keys | `meta-llama/Meta-Llama-3.1-70B-Instruct` | `https://api.together.xyz/v1` |

OpenAI and OpenRouter require adding credit; Together gives signup credit. If you bring one
of these and want it benchmarked, the runner in docs/25 accepts arbitrary OpenAI-compatible
endpoints.

---

## 🔧 Custom provider

Any OpenAI-compatible endpoint (LocalAI, LM Studio, vLLM, a gateway, …):

| Setting | Example |
|---|---|
| Provider | **Custom** |
| Base URL | `http://localhost:1234/v1` (LM Studio) · `http://localhost:8080/v1` (LocalAI) |
| Model | your model name |
| API Key | if your endpoint needs one |

---

## 💵 Cost per correction (measured)

`$/correction = avg-prompt-tokens × input-rate + avg-completion-tokens × output-rate`,
using each provider's measured token usage on our corpus.

| Model | $/1M in | $/1M out | $/correction |
|---|---:|---:|---:|
| **deepseek-chat** | 0.14 (0.0028 cached) | 0.28 | **~$0.00004** (cached) |
| groq `llama-3.1-8b-instant` | 0.05 | 0.08 | $0.00002 *(but low quality)* |
| groq `llama-4-scout` | 0.11 | 0.34 | $0.00007 |
| groq `gpt-oss-20b` | 0.075 | 0.30 | $0.00016 |
| groq `llama-3.3-70b-versatile` | 0.59 | 0.79 | $0.00026 |
| groq `qwen3-32b` | 0.29 | 0.59 | $0.00032 |
| groq `gpt-oss-120b` | 0.15 | 0.60 | $0.00034 |
| abacus `route-llm` | — (subscription) | — | ~$10/mo flat |
| Ollama (any local model) | — | — | **free** |

Day-to-day writing stays in the **pennies-per-month** range on any cheap per-token option.
Output tokens dominate, so DeepSeek's prompt caching (it caches the fixed system prompt)
makes it both the highest-quality *and* the cheapest cloud choice.

---

## 🔄 Switching providers

Change it anytime — open the extension's **Options** → pick the
provider, paste the key (if needed), choose the model, save. Settings persist
automatically; the API key is stored encrypted in browser sync storage.

---

## 🧪 Testing a provider from the terminal

```bash
# Groq
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer gsk_xxx" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"Fix: me and him went"}]}'

# DeepSeek
curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Fix: me and him went"}]}'

# Ollama (local; use 127.0.0.1 if Ollama is in WSL)
ollama run qwen3.5:4b "Fix this: me and him went to store"
```

---

## 📚 Related documentation

- [Local LLM model benchmark](25-local-llm-model-benchmark.md) — full methodology, the
  masked per-model tables, and the cross-provider recommendation behind this page.
- [Browser extension setup](04-browser-extension-setup.md)
- [Troubleshooting](18-troubleshooting.md)
