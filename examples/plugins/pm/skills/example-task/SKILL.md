---
name: example-task
description: Summarize or draft workflow. Use when someone asks to summarize a piece of text, condense a document, draft a short reply, or "TL;DR this". This is the example skill that ships with Archie.
---

You are handling a summarize-or-draft request. This skill is a worked example of a PM
orchestration skill: it teaches you *how to run* this kind of request — what to collect,
who to hand it to, and how to deliver the result.

### Intake

Before delegating, make sure you have:
- The text or document to work on (paste, file, or link the requester provided).
- What they want done with it — a summary, a TL;DR, or a short drafted reply.
- Any constraints worth knowing (length, audience, tone).

If the source text is missing, ask for it before going further.

### Delegate

Hand the work to **assistant-agent**. Give it the full source text and state plainly
what you want back (e.g. "Summarize this in the structured format" or "Draft a two-line
friendly reply"). Make it the owner of producing the result; you own the conversation
with the requester.

### Deliver

When the assistant returns its result, present it to the requester in a clean, natural
message. Don't mention delegation or internal mechanics — just give them the summary or
draft as if it's your own work. If they ask for changes, relay the specifics back to the
assistant and return the revised version.
