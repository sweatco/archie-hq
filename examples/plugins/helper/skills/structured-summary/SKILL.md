---
description: Output format for summaries. Load before producing any summary so the result is consistent and skimmable.
---

# Structured Summary

When asked to summarize text, produce this format:

**TL;DR** — one sentence capturing the single most important point.

**Key points**
- 3–6 bullets, each a complete, standalone thought.
- Faithful to the source — do not add facts that aren't present.
- Ordered by importance, not by where they appeared in the text.

**Open questions / caveats** (only if any) — anything unclear, missing, or that the
reader should be cautious about.

## Rules

- Keep the whole summary shorter than the input.
- Plain language; expand acronyms on first use.
- If the input is already short (a sentence or two), just return the TL;DR — don't pad.
- Never fabricate. If the source doesn't say something, don't claim it does.

This skill is intentionally simple — it's an example of how domain knowledge and output
formats live in a skill rather than in the agent definition.
