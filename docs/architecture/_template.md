# Module name

Use this template for a new module map. Replace the prompts with current behavior and repository-relative links; do not leave empty sections or copy these instructions into the finished document. See the [filing guide](../guides/documentation.md).

## Purpose and boundary

State the responsibility this module owns, its callers and the neighboring responsibilities it delegates to. Describe implemented behavior; put proposed changes in a linked proposal.

## Module map

| Code or interface | Owns | Boundary |
| --- | --- | --- |
| Linked entry point | The decision or operation it owns | What calls it and what it returns, persists or invokes |
| Linked state owner | Creation, updates and disposal | Who may read or change the state |

Include the few files or areas needed to navigate the responsibility, rather than every file. Link existing types and configuration instead of copying them.

## Flow and lifecycle

Trace a normal input through decisions, effects and output. Explain startup, shutdown, restart or state lifetime where material. Use a short sequence or diagram when it helps. Detailed subsections can retain important rationale.

## Contracts and failure behavior

Explain the invariants a change must preserve, trust and approval boundaries, and meaningful failures or recovery. State why surprising constraints exist. Link contracts owned by other modules instead of defining them twice.

## Change and verification

Point to where common changes belong and to focused tests or runnable checks. Distinguish suggested checks from executed evidence. Link operational guides, relevant decisions and known verification gaps. Do not put an undated test-pass or deployment claim here.
