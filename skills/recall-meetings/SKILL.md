---
name: recall-meetings
description: Use any time a voice meeting touches this task — joining one, a live question from the voice agent mid-meeting, a meeting ending, or reading one that already has. Covers the tools that put Archie into a meeting and take it back out, how to answer a consult without turning it into an investigation, what a finished meeting owes the task (a short summary, written to a file, published as an artifact, delivered to the durable channel as a file, never pasted as a chat message), where a meeting's record actually lives and what each kind of row in it holds, how to get the transcript and the roster back out of it, how to read a long meeting without burning your own context on it, and why the record may not cover the whole meeting. Triggers on "join the meeting", "join this call", "leave the meeting", a wake-up saying the voice agent needs something from you, "the meeting ended", "the call is over", "what did we agree on that call", "summarize the meeting", "read the transcript", "who was on the call", or opening a recall/<sessionId>/ folder.
---

# Recall Meetings

A voice meeting is Archie attending as a participant — via Recall, into Zoom, Meet or Teams — not a channel where messages happen to pile up. This is the one place that teaches the whole occasion: the tools that put Archie into a meeting and take it back out, how to answer something the voice agent asks you mid-meeting, what a finished meeting owes the task, where its record lives, and what that record does and doesn't tell you.

## Joining and leaving

`join_recall_meeting` takes a meeting URL and has Archie join it, bound to this task. It returns as soon as the join is under way, not once the bot has actually landed in the call — the meeting then runs itself, listening and speaking for its own turns, and a question it cannot answer alone arrives here later as a separate wake-up, answered through `post_to_user` targeted at the channel key that wake-up names. A task holds at most one live meeting at a time; joining a second one while the first is still live is refused, so there is never a question of which meeting an answer is meant for.

`leave_recall_meeting` takes no arguments — a task has at most one live meeting, so there's nothing to disambiguate — and ends it outright: Archie is gone with no farewell spoken, and by the time the tool answers, teardown has actually finished, the meeting's record is closed and its channel is marked ended. Reach for it when the meeting needs to end regardless of what's being said in the room right now — the conversation has moved on, or you were told directly to pull Archie out. When the room itself is winding down its conversation with Archie, the better path is usually no path at all: answer normally through `post_to_user` and let the meeting close itself the way a person would, saying goodbye once the conversation actually calls for it, rather than cutting it off from outside.

## Answering a consult while the meeting is live

A wake-up here means the voice agent hit a question it can't answer alone. The room is waiting on it, live, and every second you spend is dead air on a call. Answer exactly what was asked, the way you'd answer a colleague who caught you in a hallway: the fact itself, plainly, with no framing for an audience and no preamble. If it takes a lookup, do the lookup yourself rather than handing the question back.

Stop there. A correct answer isn't improved by an unrequested addendum about something else you happened to notice — a related incident, a system's history, a caveat nobody asked about. The room asked for one fact and is still waiting on it; anything appended afterward delays the thing that mattered and arrives as noise once it's finally through. Cooperating with a live meeting means giving it what it needs to keep moving, not opening an investigation nobody commissioned. What becomes of your answer, and in what words, is the voice agent's call to make, not yours — it's the one whose whole job is speaking to the room, and it may decide the moment for even a plain answer has already passed.

## When a meeting ends

Nothing you post now reaches that room — it has already dispersed. The wake-up that brought you here only hands you the path to that meeting's record, because that's the one fact about this particular occasion only it can tell you; what a finished meeting owes the task, and how to deliver it, is the rest of this section.

A short written summary, delivered to the task's own durable channel, is the reasonable default for what to do with a meeting that just ended. It's a summary, not the investigation the section above already isn't: what was decided, the action items and who took each one — named the way the roster or the transcript names them, since a self-reported display name is all either ever gives you — and anything left open that someone is waiting on. That's usually a paragraph or two.

Getting it there takes three steps, in an order that's forced rather than stylistic. Write the summary to a file in your own workspace first — the sandbox lets you read the task's shared folder but not write into it, so the file can't land directly in `recall/<sessionId>/` beside the record it's about. Call `share_artifact` on that file to publish an immutable copy into the task's shared artifacts folder. Then deliver that copy with `post_files_to_user` — as a file, not pasted into the thread as a chat message — which sends it with no text of its own, so pair it with a short `post_to_user` line if you want something said alongside it. Leave `channel` unset on both calls: a meeting never becomes this task's default channel, so the default is what sends the summary to the thread that asked for the meeting, rather than to the meeting's own channel, which is over and unreachable anyway.

Leave out more than you put in:

- No play-by-play. The `utterance` rows already are the blow-by-blow record; retelling them in order is not synthesis.
- No strung-together quotes standing in for analysis. Quoting a line isn't synthesizing it.
- No small talk, no technical hiccups, no noting who joined late, unless one of those is itself the news — texture isn't what the task is waiting on.
- Nothing from a `consult`/`answer` pair presented as something the room decided. A question you fielded mid-meeting was your own exchange with the voice agent, not a decision the room reached, and folding the two together misattributes it.
- Nothing from a `chat` row described as something Archie said. Those lines were written into the meeting chat, not spoken, and whether anyone read them is not recorded anywhere.
- Nothing implying more coverage than the record actually gives you — see below.

## The file a meeting leaves behind

A meeting leaves exactly one file: `meeting.jsonl`, in the task's shared folder under `recall/<sessionId>/` — the same `<sessionId>` that names the meeting's own `recall:<sessionId>` channel key, so the folder and the channel describe the same meeting without a lookup. A task that has hosted several meetings has one such folder per meeting, never one file they all write into.

It is append-only, one JSON object per line, in the order things settled. Every row carries `at` (an ISO timestamp) and `type`; the rest depends on the type. A field that isn't there was never known — nothing in this file is guessed to fill a gap.

- `started` — `url` and `bot_id`: the meeting Archie was sent to. Always the first row.
- `details` — `platform` and `title`, as Recall reports them. Recall produces a title asynchronously once the bot is in the call, so there can be more than one of these; the last one is the current answer. No `details` row at all means Recall never supplied either.
- `capabilities` — `text`: the block of what Archie could go and find out, exactly as its model calls received it. Empty text means it ran without one.
- `join` / `leave` — `participant` (`id`, `name`, `is_host`): who came and went, from the realtime socket, including anyone who never unmuted. Archie itself is never in them.
- `utterance` — `speaker` and `text`: one finalized line of what the room heard. Archie's own spoken turns are in these too, attributed like any other speaker.
- `chat` — `speaker` and `text`: what Archie posted into the meeting's own chat rather than saying aloud, like an exact figure, a hash or a path. Nothing anyone else typed in the meeting chat is here — Archie cannot read the room's chat, only write to it — so read these as one side of a channel, not a conversation.
- `consult` / `answer` — a question the voice agent put to you (`id`, `question`) and what came back on it (`id`, `text`, and `from`: `pm-agent` for your own answer, `system` for the placeholder written when you couldn't be reached at all).
- `gate` — how one candidate turn was judged: who spoke, what they said, which tier decided, and whether it counted as addressed. Machinery, not meeting content.
- `turn` — how one speaking decision settled: what Archie decided to say, what the room is confirmed to have heard, and what it cost. Machinery too.
- `ended` — `call_ended_at`, Recall's own time for the end of the call, or `null` when the meeting was ended without asking Recall.

**The transcript is the `utterance` rows.** `jq -r 'select(.type=="utterance") | "[\(.at)] [\(.speaker)] \(.text)"' meeting.jsonl` gives you it in the shape `knowledge.log` uses. The roster is the `join` and `leave` rows: someone who left part-way through has both, someone still there when Archie left has only a join, and a rejoin arrives under a fresh participant id as its own pair rather than resuming the old one — so `join` without a matching `leave` means "never seen to leave", not "stayed to the end". The consult trail is the `consult` and `answer` rows, paired by `id`. The occasion itself — what platform, what it was called, when it began and ended — is `started`, `details` and `ended`.

Nothing in the file says when the *meeting* started: `started` is when Archie was sent to it, which is a different fact, and Recall has no record of the other one.

## Don't read it all yourself

An hour of conversation is a long file, and reading all of it just to write a couple of paragraphs is a bad trade against your own context. The `Agent` tool exists for exactly this: it spins up a disposable subagent that reads a file in its own context and reports back, without any of it landing in yours. Ask for a general-purpose one, give it the record's path, and say what you're actually after — the decisions, the action items and their owners, whatever a later question is asking — so it comes back with a few lines instead of a transcript. That's a different tool from `spawn_repo_agent`, which clones a GitHub repository and adds a permanent teammate to the task and is built for ongoing engineering work, not a single read of a text file. If this task already has a teammate on it — a repo or plugin specialist already on the team — the shared folder is readable to them too, so `send_message_to_agent` to them works just as well.

## The record is not the whole meeting

Archie may have joined after the meeting was already underway, so the `utterance` rows can open mid-conversation with nothing marking what came before them. The `started` row records when Archie joined, and that is not the same fact as when the meeting began — don't treat the two as interchangeable, and don't write a summary that implies you saw the opening of a meeting you may have only joined partway through.

The `join` rows list everyone the platform reported as arriving, and some of them may never say a word in an `utterance` row — attending is not the same as speaking. Don't credit a silent participant with agreeing to anything, and don't write "everyone agreed" when "everyone" includes people the transcript never heard from.

**A summary should read like what it is: an account of what the record actually captured, not a claim to have witnessed the whole occasion.**
