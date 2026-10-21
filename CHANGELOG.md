# Changelog

Version history of the OGrammar browser extension. Each build also carries a **build
stamp** — the commit it was built from, plus "+ local changes" if it included edits that
weren't committed yet. You'll find it on the OGrammar card in `chrome://extensions` and in
Options → About.

Bump the middle number for new features, the last number for fixes only.

## [0.10.0] - 2026-10-21

- **Rephrase** now rewrites the whole sentence around the issue. It used to send only the
  underlined word, and "Use" pasted the result over that word.
- **Tone rewrite for the whole message:** when a text box has nothing to fix, click the
  OGrammar badge to rewrite all of it (Polish / Formal / Casual). Rewriting a selection
  keeps its spacing.
- **Fixes apply reliably in every kind of text box**, including Facebook and Messenger,
  where accepted fixes used to leave the original word behind. Multi-line rewrites work
  there too.
- Autocorrect now works past the first line; email fields no longer duplicate text;
  inserting a missing word now applies.
- Custom AI provider: pick the model from the provider's list.
- All AI instructions (proofreading, the three tones, Rephrase) live in one file,
  `opengrammar/extension/src/shared/prompts.json`.
- New OGrammar look and wording.
- The version now shows with its build stamp.
- Autocomplete removed.

## [0.9.0] - 2026-06-13
- First versioned release.
