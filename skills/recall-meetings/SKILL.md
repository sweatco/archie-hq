---
name: recall-meetings
description: Use any time a voice meeting touches this task — joining one, a live question from the voice agent mid-meeting, a meeting ending, or reading one that already has. Covers the tools that put Archie into a meeting and take it back out, how to answer a consult without turning it into an investigation, what a finished meeting owes the task (a short summary, written to a file, published as an artifact, delivered to the durable channel as a file, never pasted as a chat message), where a meeting's transcript, exchange log, chat log and metadata actually live, what the metadata's two participant rosters each mean and why they can disagree, how to read a long transcript without burning your own context on it, and why the record may not cover the whole meeting. Triggers on "join the meeting", "join this call", "leave the meeting", a wake-up saying the voice agent needs something from you, "the meeting ended", "the call is over", "what did we agree on that call", "summarize the meeting", "read the transcript", "who was on the call", or opening a recall/<sessionId>/ folder.
---

# Recall Meetings

A voice meeting is Archie attending as a participant — via Recall, into Zoom, Meet or Teams — not a channel where messages happen to pile up. This is the one place that teaches the whole occasion: the tools that put Archie into a meeting and take it back out, how to answer something the voice agent asks you mid-meeting, what a finished meeting owes the task, where its records live, and what those records do and don't tell you.

## Joining and leaving

`join_recall_meeting` takes a meeting URL and has Archie join it, bound to this task. It returns as soon as the join is under way, not once the bot has actually landed in the call — the meeting then runs itself, listening and speaking for its own turns, and a question it cannot answer alone arrives here later as a separate wake-up, answered through `post_to_user` targeted at the channel key that wake-up names. A task holds at most one live meeting at a time; joining a second one while the first is still live is refused, so there is never a question of which meeting an answer is meant for.

`leave_recall_meeting` takes no arguments — a task has at most one live meeting, so there's nothing to disambiguate — and ends it outright: Archie is gone with no farewell spoken, and by the time the tool answers, teardown has actually finished, the meeting's metadata is complete and its channel is marked ended. Reach for it when the meeting needs to end regardless of what's being said in the room right now — the conversation has moved on, or you were told directly to pull Archie out. When the room itself is winding down its conversation with Archie, the better path is usually no path at all: answer normally through `post_to_user` and let the meeting close itself the way a person would, saying goodbye once the conversation actually calls for it, rather than cutting it off from outside.

## Answering a consult while the meeting is live

A wake-up here means the voice agent hit a question it can't answer alone. The room is waiting on it, live, and every second you spend is dead air on a call. Answer exactly what was asked, the way you'd answer a colleague who caught you in a hallway: the fact itself, plainly, with no framing for an audience and no preamble. If it takes a lookup, do the lookup yourself rather than handing the question back.

Stop there. A correct answer isn't improved by an unrequested addendum about something else you happened to notice — a related incident, a system's history, a caveat nobody asked about. The room asked for one fact and is still waiting on it; anything appended afterward delays the thing that mattered and arrives as noise once it's finally through. Cooperating with a live meeting means giving it what it needs to keep moving, not opening an investigation nobody commissioned. What becomes of your answer, and in what words, is the voice agent's call to make, not yours — it's the one whose whole job is speaking to the room, and it may decide the moment for even a plain answer has already passed.

## When a meeting ends

Nothing you post now reaches that room — it has already dispersed. The wake-up that brought you here only hands you the transcript path, because that's the one fact about this particular occasion only it can tell you; what a finished meeting owes the task, and how to deliver it, is the rest of this section.

A short written summary, delivered to the task's own durable channel, is the reasonable default for what to do with a meeting that just ended. It's a summary, not the investigation the section above already isn't: what was decided, the action items and who took each one — named the way the roster or the transcript names them, since a self-reported display name is all either ever gives you — and anything left open that someone is waiting on. That's usually a paragraph or two.

Getting it there takes three steps, in an order that's forced rather than stylistic. Write the summary to a file in your own workspace first — the sandbox lets you read the task's shared folder but not write into it, so the file can't land directly in `recall/<sessionId>/` beside the records it's about. Call `share_artifact` on that file to publish an immutable copy into the task's shared artifacts folder. Then deliver that copy with `post_files_to_user` — as a file, not pasted into the thread as a chat message — which sends it with no text of its own, so pair it with a short `post_to_user` line if you want something said alongside it. Leave `channel` unset on both calls: a meeting never becomes this task's default channel, so the default is what sends the summary to the thread that asked for the meeting, rather than to the meeting's own channel, which is over and unreachable anyway.

Leave out more than you put in:

- No play-by-play. `transcript.log` already is the blow-by-blow record; retelling it in order is not synthesis.
- No strung-together quotes standing in for analysis. Quoting a line isn't synthesizing it.
- No small talk, no technical hiccups, no noting who joined late, unless one of those is itself the news — texture isn't what the task is waiting on.
- Nothing from `exchange.log` presented as something the room decided. A question you fielded mid-meeting was your own exchange with the voice agent, not a decision the room reached, and folding the two together misattributes it.
- Nothing from `chat.log` described as something Archie said. Those lines were written into the meeting chat, not spoken, and whether anyone read them is not recorded anywhere.
- Nothing implying more coverage than the files actually give you — see below.

## The files a meeting leaves behind

A meeting's records live in the task's shared folder, under `recall/<sessionId>/` — the same `<sessionId>` that names the meeting's own `recall:<sessionId>` channel key, so the folder and the channel describe the same meeting without a lookup. A task that has hosted several meetings has one such folder per meeting, never one file they all write into. If a wake-up already handed you a transcript path, the rest sit right beside it in the same folder — there is nowhere else to look.

- `transcript.log` — what the room heard, one line per finalized utterance, in the same `[ISO] [speaker] message` shape as `knowledge.log`. Archie's own spoken turns are in it too, attributed like any other speaker.
- `exchange.log` — what Archie's voice and the PM said to each other about the meeting while it was live: a question line when the voice agent asked you something, an answer line when you replied.
- `chat.log` — what Archie posted into the meeting's own chat rather than saying aloud: the detail an answer deliberately keeps out of speech, like an exact figure, a hash or a path. Present only if there was any. Nothing anyone else typed in the meeting chat is in it — Archie cannot read the room's chat, only write to it — so read it as one side of a channel, not a conversation.
- `metadata.json` — facts about the occasion rather than what was said in it: the platform, the meeting's own title wherever the platform supplies one, when Archie joined, when the meeting ended and for how long, and two separate rosters of who was there.

Those two rosters answer different questions, and they're allowed to disagree. `participants` is Recall's own view: deduplicated, final, populated once after the meeting is over, with no timestamps at all — and left `null` rather than empty for as long as that fetch hasn't run, has failed, or Recall simply hasn't produced one yet. `live_participants` is this connector's own record, built live off the same join and leave events the realtime audio socket already carries, present from the moment the first participant arrives rather than only at the end; someone who leaves part-way through keeps their row, closed with a `left_at` rather than deleted, and a later rejoin gets its own new entry rather than resuming the old one. Reconciling the two into one list would mean picking a winner whenever they disagree — a network blip, say, that this connector sees as two short visits but Recall's own dedup folds into one — so neither is: check `participants` for who Recall is confident was there, and `live_participants` for when. Archie itself never appears in either roster — it already has its own `archie_joined_at`, and it isn't a fact about who else was in the room.

`archie_joined_at` names exactly what it records — when the bot joined, never when the meeting started, since Recall has no record of the latter. A `null` anywhere in this file means the same thing everywhere in it: not known, whether that's because a fetch hasn't run yet, it failed, or the platform simply never supplies that fact at all — Zoom always gives a title, Meet only when the bot joined signed in, and Teams and Webex never do. None of those three reasons is more alarming than the others, and neither should your reading of it be.

## Don't read it all yourself

An hour of conversation is a long file, and reading all of it just to write a couple of paragraphs is a bad trade against your own context. The `Agent` tool exists for exactly this: it spins up a disposable subagent that reads a file in its own context and reports back, without any of it landing in yours. Ask for a general-purpose one, give it the transcript path (and `exchange.log` too, if the question needs it), and say what you're actually after — the decisions, the action items and their owners, whatever a later question is asking — so it comes back with a few lines instead of a transcript. That's a different tool from `spawn_repo_agent`, which clones a GitHub repository and adds a permanent teammate to the task and is built for ongoing engineering work, not a single read of a text file. If this task already has a teammate on it — a repo or plugin specialist already on the team — the shared folder is readable to them too, so `send_message_to_agent` to them works just as well.

## The record is not the whole meeting

Archie may have joined after the meeting was already underway, so `transcript.log` can open mid-conversation with nothing marking what came before it. `metadata.json` records when Archie joined, and that is not the same fact as when the meeting began — don't treat the two as interchangeable, and don't write a summary that implies you saw the opening of a meeting you may have only joined partway through.

The roster in `metadata.json` lists everyone the platform reported as present, and some of them may never say a word in `transcript.log` — attending is not the same as speaking. Don't credit a silent participant with agreeing to anything, and don't write "everyone agreed" when "everyone" includes people the transcript never heard from.

**A summary should read like what it is: an account of what the record actually captured, not a claim to have witnessed the whole occasion.**
