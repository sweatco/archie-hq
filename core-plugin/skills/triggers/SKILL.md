---
name: triggers
description: Set up, list, or manage triggers — persistent "do Y when X happens" rules. Use when someone asks Archie to do something on a schedule ("every weekday at 9am…", "every morning post…", "remind the channel weekly…"), to react to new messages in a channel ("whenever someone posts X in #support, …"), or to list/pause/stop an automation they set up earlier. Also covers one-off future actions ("at 5pm today, summarise…").
---

# Triggers

You are setting up or managing a **trigger** — a persistent rule that makes Archie act on its own when a condition fires, instead of only when someone messages it. This is the one place Archie initiates work, so every new trigger goes through an explicit approval step before it runs.

### Two kinds of trigger

- **Schedule** — fires on a repeating cadence (hourly, daily, weekdays, weekly at a time) or **once** at a future moment.
- **Channel-message** — fires when a new top-level message is posted in a watched channel, optionally only when the message contains some text or comes from a specific author.

### Where a trigger delivers

Each trigger **delivers** its result either to a **channel** or to a **DM**.

A DM trigger has three rules, and they are not negotiable — the tool enforces all three, so proposing something that breaks one just wastes a turn:

1. **It can only be set up from that person's own DM with you.** If someone in a channel asks you to DM them (or to DM somebody else) on a schedule, you cannot do it from there. Say so and offer the two things that do work: they set it up in their own DM with you, or the trigger posts in this channel.
2. **It always delivers to the person you are talking to.** There is no way to aim a DM trigger at anyone else — the delivery target comes from the conversation itself, not from anything you pass. Never offer to set one up "for" a third person.
3. **It can only run on a schedule.** A DM trigger cannot watch a channel for messages. If someone in their DM asks "message me whenever X is posted in #support", explain that a message-watch trigger delivers into the channel it watches, so it has to be set up in that channel; offer that, or a scheduled check here instead.

### Don't confuse this with a reminder

A reminder wakes the current task later and never starts a new one. A trigger starts a fresh task on every run, on a schedule or when a matching Slack message arrives, and its runs share memory rather than a conversation. Recurring schedules can fire at most **once per hour** — if someone asks for "every 5 minutes", explain that and offer hourly. This floor applies to recurring reminders too; only one-off triggers and one-off reminders are exempt.

### Intake — gather before proposing

Don't propose a trigger until you have:

1. **What to do when it fires** — the concrete action, in enough detail that a fresh task with no prior conversation could carry it out (every fire starts a new task that cannot see this one). A trigger does keep one directory across its fires, though, so the action may legitimately tell the agent to build on what an earlier fire left there — just never on a conversation. Also give it a **short, friendly name** — a few words, a noun phrase, not a full sentence and not ending in a period (e.g. "Daily #bot-test summary", "Reply to messages mentioning Archie"). That name is what the user sees in the approval card and the channel notices, so it must describe **what the automation produces/does** — not restate the schedule (the cadence is rendered automatically) and, for a message-watch trigger, not restate the triggering condition ("A new message was posted…"). Keep the detailed instruction in the action prompt, behind the scenes.
2. **When / what to watch** —
   - Schedule: the cadence or the one-off time, **and the timezone** (confirm it if you're not sure — "9am" is meaningless without one).
   - Channel-message: which channel, and any filter (a keyword, a specific sender).

     A sender filter is an **id**, never a name or an @handle. Most watches worth setting up are on a report an app posts — a monitoring alert, a nightly report, an incoming webhook — and an app's author id is a **bot id** (`B…`), not a user id. Both forms work; use whichever the message's author actually is. You can read the id straight off the author of the message you want to watch for: it is what `read_channel_history` and the knowledge log print in `<@…:Name>`. If you cannot find an id, leave the sender filter off and let the keyword do the work rather than guessing — a filter naming nobody would make the trigger fire on nothing, silently.
3. **Where to deliver** — a trigger delivers to the conversation it is set up in. In a channel that is the channel; **in a DM it is the DM** (propose it with binding type `user` and pass no channel id — the DM is taken from the conversation). If someone wants the result somewhere else, they set the trigger up there.

If anything is missing or ambiguous, ask in Slack before proposing.

### Propose, then let the user approve

When you have the details, propose the trigger. This posts an **Approve / Deny** prompt to the user — the trigger does **not** run until they approve (in Slack they click a button; in the CLI they press y). You don't need to stop the conversation while it's pending; just make clear you've put it up for approval.

Never describe a trigger as "set up" or "running" until it has actually been approved.

**A proposal awaiting approval is still yours to manage — if this conversation made it.** It shows up in `list_triggers` marked *awaiting approval — not running*, and if the user asks for a change before they've clicked anything, **edit that proposal** (`update_trigger`) rather than proposing a second one. Editing re-posts a fresh Approve/Deny card with the new details. If they've changed their mind entirely, `delete_trigger` withdraws it. Only `status` is off-limits while pending, because approval is the user's call alone — and a call that passes `status` changes *nothing at all*, so send the details on their own.

Two proposals you can see but not edit. One made in **another conversation** can't be managed from here at all. And an **older proposal with no owner recorded** — one that predates this being possible — you can list and withdraw, but not edit: the person who asked for it is still looking at its original card, and rewriting it behind them would have them approve wording they never saw. Withdraw it and propose a fresh one instead, telling them that's what you did.

Editing leaves the **earlier card in the thread** — Slack cards aren't retracted, so say which one is current ("ignore the card above — here's the updated one"). Both cards point at the same trigger, so the outcome is the same whichever they click, and neither can create a duplicate or revive the old details: approving twice is a no-op the second time, and a Deny that lands after approval is refused rather than tearing down a running automation. Withdrawing a proposal likewise leaves its buttons inert. If the user approves while you are mid-edit, the edit is abandoned and the tool tells you so — pass that on rather than re-sending it, because by then it's a live automation and `update_trigger` on it will announce the change to the channel.

One approval failure is worth recognising, because it is recoverable and reads like a dead end: if the **active-trigger limit** was reached, the card says so and *keeps its buttons*. The proposal is still there. Tell the user to remove or pause another automation and click Approve again — don't re-propose.

### Visibility & privacy — what you can see and manage

You can only see and manage triggers that belong to the space the user is talking to you from:

- From a **public channel**: every public-channel trigger.
- From a **private channel**: that channel's triggers, plus public ones.
- From a **DM**: that person's own DM triggers, plus public ones.

A private channel's or a DM's triggers are never visible from anywhere else. When someone asks "what's set up here", list everything you can see and narrow it conversationally if they want just one channel or just the schedules. When they ask to pause, resume, edit, or delete one, do it by its id — anything you can see, you can manage.

**Listing gives you one summary line per trigger; `get_trigger` gives you the rule.** Read the trigger before you answer a question about what it watches, and always before you edit one. Two reasons, both of which have bitten: the summary says a sender is filtered without saying who, so answering from it means telling the user you cannot see something you can; and an edit that passes `conditions` **replaces the whole list**, so anything you did not restate — a keyword, a sender — is dropped without a word. Read first, then restate everything you mean to keep. One warning worth giving before you delete: a trigger keeps a directory that its runs use to carry work forward, and deleting the trigger deletes that too. If the automation has been running a while, say so and offer to pause it instead.

### Changes are announced; firing is not

Whenever a **channel** trigger is created, edited, paused, resumed, or deleted, Archie automatically posts a one-line notice to the channel that trigger is bound to — so a channel always knows what automation runs in it, even if the change was made from a DM. You don't need to post that notice yourself. A **DM** trigger announces nothing: the only person who would see the notice is the one who just asked for the change, so telling them again in the same conversation is noise. Confirm it yourself in your reply, as you would any other change.

When a trigger **fires**, the spawned task just does the work and posts the result normally — there's no "I was triggered" preamble, and you don't add one.

Where that result lands depends on what fired it, and the fired task is told which. A message-watch fire replies in the thread of the message that matched, and that message is in its knowledge log. A scheduled fire has no thread yet: its first message to the user **opens the task's own thread** in the conversation the trigger delivers to — a channel, or the person's DM — and everything after that goes into the same thread, so when someone replies there it comes back to the run that posted rather than starting a new one. A DM trigger's result therefore arrives as a new message in the DM, not as a reply inside whatever thread was there before.

### A few hard rules

- You can set up a trigger even from a task that was itself started by a trigger — it still requires the user's Approve/Deny, so there's no runaway risk.
- Fired tasks are read-only like any task; if the work needs code changes, the usual edit-mode approval still applies in the moment.
- There are caps on how many active triggers a channel or person can have. If you hit one, tell the user and offer to remove an existing trigger first.

### Delivering results

- **Setup confirmation**: once approved, confirm in one line what was set up and where it will deliver (e.g. "Done — I'll post a digest in #standup every weekday at 9am London time").
- **Listing**: present visible triggers as a short list — what each does, where it delivers, whether it's active or paused.
- **Revision**: if the user wants a change, edit the existing trigger rather than stacking a second one — this holds whether it's live or still awaiting approval. Rescheduling a trigger that had been paused (including a one-off that already fired) automatically re-enables it — the update tool tells you when that happened, so pass that on to the user ("done — rescheduled and back on for 4pm") rather than leaving them to wonder whether it's live.
