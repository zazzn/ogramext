# OGrammar - Chrome Web Store submission packet

Everything needed to publish, ready to paste into the Web Store developer dashboard.
The only steps that require you: create the developer account ($5 one-time), enable
GitHub Pages, upload the packaged zip + screenshots, paste the fields below, submit.

## Identity
- **Name:** OGrammar
- **Category:** Productivity
- **Language:** English (US) - note other locales as future work
- **Privacy policy URL:** `https://zazzn.github.io/ogramext/privacy.html`
  (live once GitHub Pages is enabled: repo Settings -> Pages -> Source = "GitHub Actions";
  the `deploy-pages.yml` workflow publishes `privacy.html` on every push to `main`.)

## Summary (132 char max)
> Private, local-first grammar, spelling and style checking everywhere you type. Free, open-source, bring your own AI key.

## Detailed description
(Revised 2026-06-20 to clear the "Yellow Nickel" keyword-spam rejection. Rule: list no more than 5 supported brands/sites in the description and don't repeat any keyword 5+ times. The old copy named 7 brands (OpenAI, OpenRouter, Groq, Together, Ollama, Gmail, Google Docs); this names only Gmail + Google Docs. Do NOT re-add the provider brand list - point users to the options screen or a screenshot instead.)
> OGrammar is a privacy-first writing assistant. Its grammar, spelling, and style checking runs entirely on your device, so your text is never sent to a server.
>
> - Checks the text you type in editable fields on any website, with inline underlines and a writing score.
> - An optional AI mode (advanced rewrites, tone changes, and autocomplete) is off by default. It uses an API key you provide and sends text only to the provider you choose, or to a model you run locally.
> - Works in Gmail and Google Docs.
> - No account, no subscription, no ads, and no tracking. Any API key you add is encrypted on your device.
> - Free and open source under the Apache 2.0 license.
>
> Writing help that never leaves your machine.

## Single-purpose statement
> OGrammar has one purpose: to detect and help correct writing issues (grammar, spelling, and style) in the editable text fields the user types into on the web.

## Permission justifications (paste each into the dashboard)
- **`host_permissions: <all_urls>` / content scripts on all sites:** The extension checks the text the user types into editable fields, and users write on any website (mail, docs, forms, social, support tools). It cannot know in advance which sites the user will type on, so it needs to run on all of them. It takes no action until the user focuses a text field, and it never reads page content for any other purpose.
- **`storage`:** Stores the user's settings, custom dictionary, ignored suggestions, and per-site preferences in the browser's own storage.
- **`activeTab` + `scripting`:** Used to inject the checking UI (underlines, suggestion card) into the field the user is editing in the active tab.
- **Content Security Policy `wasm-unsafe-eval`:** The on-device grammar engine (Automattic Harper) is compiled to WebAssembly; instantiating it requires the `wasm-unsafe-eval` source. No remote code is loaded or executed - all WASM ships inside the package.
- **`web_accessible_resources` (WASM + n-gram model + dictionary):** These are the local engine's data files, loaded by the content script so checking can run on-device. They are static assets bundled in the extension; nothing is fetched from a remote server at runtime.

## Data-use disclosures (the dashboard form)
- **Does the extension collect user data?** It does not collect or transmit user data to the developer. All processing is local; the only egress is the optional AI tier, which sends text directly from the user's device to a third-party AI provider the user explicitly configures, under the user's own account.
- **Categories:** "Website content" is processed locally for the single purpose above and is sent to a third-party provider ONLY when the user enables AI and triggers an action. No personally identifiable information, financial info, health info, location, or web-history is collected.
- **Certifications (all true):** not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.
- **Remote code:** None. No `eval`, no remotely hosted scripts; `wasm-unsafe-eval` is only for the bundled local WASM engine.

## Visual assets needed (sizes are exact)
- [ ] Store icon: 128x128 PNG - use `opengrammar/extension/public/icon-128.png` (already the new green mark).
- [ ] Screenshots: 5 at 1280x800 (or 640x400). Capture from the REAL built extension (`opengrammar/extension/dist` loaded unpacked), never mockups:
  1. The popup writing-score + issue chips (green).
  2. An inline correction on a real site (red underline -> clean text).
  3. Tone rewrite / rephrase.
  4. Provider + local-Ollama settings.
  5. Gmail or Google Docs integration.
- [ ] Small promo tile: 440x280 PNG.
- [ ] Marquee promo (optional): 1400x560 PNG.
  (Promo tiles can be rendered from the brand mark; screenshots must be live captures.)

## Packaging
- Build: `cd opengrammar/extension && npm run build`
- Zip the `dist/` directory contents (not the folder) for upload.
- Confirm no source maps or secrets are bundled before upload.

## Rollout
1. Submit as **Unlisted** first; smoke-test the published build on a real site + Gmail + Docs; confirm zero network calls with no provider configured.
2. Promote to **Public** with a staged percentage rollout; keep one resubmission cycle of buffer for review feedback.
