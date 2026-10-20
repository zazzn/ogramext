# 🎨 Tone Rewriting

OGrammar can rewrite your text in a different tone — fixing its spelling and grammar along
the way — without changing what you mean. You always see a preview first; nothing changes
until you click **Apply**.

Tone rewriting uses your AI provider — set one up in **Options** first
([07-ai-providers.md](07-ai-providers.md)).

---

## The three tones

| Tone | What it does | Good for |
|------|--------------|----------|
| **Polish** | Fixes spelling, grammar, and awkward phrasing; keeps your tone and length. | Anything you're about to send |
| **Formal** | Professional and business-appropriate; no slang or contractions. | Work email, proposals, official messages |
| **Casual** | Relaxed and friendly, like a message to a friend. | Chat, social posts, quick notes |

Every tone keeps URLs, email addresses, file paths, code, @mentions, #hashtags, IDs and
version numbers exactly as you wrote them — a rewrite that would change one is discarded.
The instructions live in one file, `opengrammar/extension/src/shared/prompts.json`.

---

## How to use it

- **Part of your text:** select it → click the green **pen** that appears → pick a tone.
- **The whole message:** when the field has nothing to fix, click the OGrammar **badge** in
  the field's corner → pick a tone. (The same menu offers **Check the whole text with AI**
  for a sentence-level review instead.)
- **One sentence under review:** in the sentence-review card, open **Improve** → pick a tone.

Read the preview, then **Apply** or **Cancel** — pick another tone to re-preview. Ctrl+Z
undoes an applied rewrite.

---

## Troubleshooting

- **"No change suggested"** — the text already reads well in that tone; try another one.
- **"Rewrite failed — check provider/API key"** — open Options and test your provider.
- **Slow** — a local model (Ollama) can take several seconds on first use; cloud providers
  are faster.
- **"Could not apply here"** — the text changed after the preview was made; pick the tone
  again.

---

## Related

- [Using OGrammar](09-using-opengrammar.md)
- [AI Providers](07-ai-providers.md)
