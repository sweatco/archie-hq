---
name: example-task
description: Summarize or draft workflow. Use when someone asks to summarize a piece of text, condense a document, draft a short reply, or "TL;DR this". This is the example skill that ships with Archie.
---

You are handling a summarize-or-draft request. This skill is a worked example: it teaches you *how to run* this kind of request — what to collect, when to do it yourself and when to hand it off, and how to deliver the result. You own the conversation with the requester throughout.

### Intake

Before doing anything, make sure you have:
- The text or document to work on (paste, file, or link the requester provided).
- What they want done with it — a summary, a TL;DR, or a short drafted reply.
- Any constraints worth knowing (length, audience, tone).

If the source text is missing, ask for it before going further.

### Do it or hand it off

A couple of paragraphs to condense is not worth a worker: load `helper:structured-summary` and write the summary yourself.

Anything bulky — a long document, several sources, a transcript — goes to a worker, because everything it reads stays in its context and only its result comes back to yours. Spawn `helper:assistant` with the full source text and a plain statement of what you want back ("summarize this in the structured format", "draft a two-line friendly reply"). The brief is all it gets: it cannot see this conversation, ask the requester anything, or read a file you did not give it.

### Deliver

Present the result to the requester in a clean, natural message. Don't mention delegation or internal mechanics — just give them the summary or draft as your own work. If they ask for changes, spawn a fresh worker with the previous result and the specifics, and deliver the revision the same way.
