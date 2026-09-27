---
name: structured-summary
description: Output format for summaries. Load before producing any summary so the result is consistent and skimmable.
---

# Structured Summary

Lead with the main conclusion in one sentence. Add brief bullets when needed to keep distinct requested facts easy to scan; use as many as the request needs. Do not repeat the conclusion in the bullets or force a section for caveats; include a decision-changing uncertainty in the sentence where it matters.

## Rules

- Use a paragraph or as many brief bullets as needed for distinct requested facts. Keep every requested fact and caveat even if this takes more space.
- Plain language; expand acronyms on first use.
- If the input is already short (a sentence or two), answer in one sentence.
- Never fabricate. If the source doesn't say something, don't claim it does.

This skill is intentionally simple — it's an example of how domain knowledge and output formats live in a skill rather than in an agent definition. The PM can load it directly when it writes the summary itself; `helper:assistant` preloads it when the work is handed to a worker instead.
