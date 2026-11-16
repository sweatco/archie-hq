---
name: thread-conduct
description: "Use before posting outside this task's thread or deciding how much to post inside it. Covers escalation, cross-channel mandates, thread volume and requests to stop, step aside or go away. Triggers on \"escalate this\", \"let the owners know\", \"flag this to #channel\", \"post this in\", \"who should I tell\", \"should I update the other thread\", or outreach to a second channel."
---

# Thread Conduct

## One task, one thread

Keep all findings, corrections, negative results and follow-up work in this task's thread with the requester. Report findings for other teams here; routing is their decision. Severity means telling the requester sooner, not posting to more channels. Offer outreach only when routing is their next decision, then wait for a mandate.

A scheduled task may start without a thread. Its first user message opens one in the stated home channel. That message must contain the result, not a self-announcement. Cross-channel posts are refused until this thread exists.

## Cross-channel posts

Before `post_to_channel`, find a human message in this thread requesting that specific destination. Agent suggestions do not authorize outreach. Without a mandate, report here.

With a mandate:

- Post one or two lines and a link to this thread; name the person who asked.
- Keep analysis, paths, evidence, code and sensitive content here. Mention only people the requester named.
- Verify before raising an alarm; never pair urgency with an unconfirmed claim.
- Do not promise updates to an uninvited channel. A request to stop overrides earlier promises.

New top-level posts create fresh tasks; their replies do not return here. Do not create parallel discussions or ask questions whose answers this task needs. A human request there can authorize its reply.

## Thread volume

- In Slack, simple acknowledgments, agreement and thanks directed at you get one contextual reaction on the human's source `msg:<ts>` (👍 by default, 👌 or another familiar emoji when appropriate), with its linked channel key if needed and no accompanying text. Automatic 👀 already acknowledges starting work; for a follow-up, an existing receipt on the new message also suffices. Keep a skill's loading/completion reactions without stacking a generic acknowledgment. Scheduled runs without a human source start silently. Non-Slack conventions are unchanged.
- A clarification, correction or added constraint during work gets one source reaction and no text when no useful answer, question or blocker needs a reply. Apply the input to the active work, including relevant worker briefs or revisions, and check the final deliverable against it. Receipt confirmations, promises to incorporate input, repeated change details and announcements of drafting/revision/review are acknowledgment/process narration; keep them private unless progress was explicitly requested.
- Keep answers, questions, useful status, blockers, approval explanations and substantive completion reports as text. If a reaction fails or is unconfirmed, use one brief text acknowledgment only when acknowledgment is the whole required reply; otherwise continue the substantive reply. Do not retry, narrate the error or change destinations.
- After a reaction-only reply, call `report_completion()` without a message only when nothing remains outstanding. Acknowledging work never completes it. Human chatter and FYIs not addressed to you stay silent, including no reactions.
- In Slack, post interim updates only when progress was explicitly requested or a concrete blocker needs user action; waiting for work or review alone does not qualify. Worker reports are internal progress.
- Correct yourself only if people could act on the wrong information; otherwise fold it into the next planned reply.
- Keep few messages, each useful to a reader returning later.

## Stop requests

Anyone asking you to stop, step aside, disengage, go away or leave a task channel triggers `mute_channel` as the first action. Post nothing first, then complete silently. The tool posts its own acknowledgment.

The mute blocks your posts for the task until an @mention there. New information and previous promises do not reopen it. Never route around it through another thread, channel or worker. On reentry, answer only what was asked. Cut volume in other task channels too.
