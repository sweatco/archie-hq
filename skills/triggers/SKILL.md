---
name: triggers
description: Set up, list, or manage triggers — persistent "do Y when X happens" rules. Use when someone asks Archie to do something on a schedule ("every weekday at 9am…", "every morning post…", "remind the channel weekly…"), to react to new messages in a channel ("whenever someone posts X in #support, …"), or to list/pause/stop an automation they set up earlier. Also covers one-off future actions ("at 5pm today, summarise…").
---

# Triggers

You are setting up or managing a **trigger** — a persistent rule that makes Archie act on its own when a condition fires, instead of only when someone messages it. This is the one place Archie initiates work, so every new trigger goes through an explicit approval step before it runs.

### Two kinds of trigger

- **Schedule** — fires on a repeating cadence (hourly, daily, weekdays, weekly at a time) or **once** at a future moment.
- **Channel-message** — fires when a new top-level message is posted in a watched channel, optionally only when the message contains some text or comes from a specific person.

Each trigger **delivers** its result to one place: a **channel** (Archie posts a thread there) or a **person** (Archie DMs them).

### Don't confuse this with a reminder

A reminder ("remind me in 10 minutes") wakes the *current* conversation later and is a one-shot — keep using that for short, in-conversation nudges. A trigger spawns a *fresh* task every time it fires and persists until paused or deleted. Recurring schedules can fire at most **once per hour** — if someone asks for "every 5 minutes", explain that and offer hourly (one-off and reminders have no such floor).

### Intake — gather before proposing

Don't propose a trigger until you have:

1. **What to do when it fires** — the concrete action, in enough detail that a fresh task with no prior context could carry it out (it genuinely starts clean each time).
2. **When / what to watch** —
   - Schedule: the cadence or the one-off time, **and the timezone** (confirm it if you're not sure — "9am" is meaningless without one).
   - Channel-message: which channel, and any filter (a keyword, a specific sender).
3. **Where to deliver** — which channel, or which person's DM. Default to the channel you're already talking in unless they say otherwise.

If anything is missing or ambiguous, ask in Slack before proposing.

### Propose, then let the user approve

When you have the details, propose the trigger. This posts an **Approve / Deny** prompt to the user — the trigger does **not** run until they approve (in Slack they click a button; in the CLI they press y). You don't need to stop the conversation while it's pending; just make clear you've put it up for approval.

Never describe a trigger as "set up" or "running" until it has actually been approved.

### Visibility & privacy — what you can see and manage

You can only see and manage triggers that belong to the space the user is talking to you from:

- From a **public channel**: every public-channel trigger.
- From a **private channel**: that channel's triggers, plus public ones.
- From a **DM**: that person's own DM triggers, plus public ones.

A private channel's or a DM's triggers are never visible from anywhere else. When someone asks "what's set up here", list everything you can see and narrow it conversationally if they want just one channel or just the schedules. When they ask to pause, resume, edit, or delete one, do it by its id — anything you can see, you can manage.

### Changes are announced; firing is not

Whenever a trigger is created, edited, paused, resumed, or deleted, Archie automatically posts a one-line notice to the channel that trigger is bound to — so a channel always knows what automation runs in it, even if the change was made from a DM. You don't need to post that notice yourself.

When a trigger **fires**, the spawned task just does the work and posts the result normally — there's no "I was triggered" preamble, and you don't add one.

### A few hard rules

- A task that was itself started by a trigger cannot create new triggers — if you find yourself in one, tell the user to set it up from a normal conversation.
- Fired tasks are read-only like any task; if the work needs code changes, the usual edit-mode approval still applies in the moment.
- There are caps on how many active triggers a channel or person can have. If you hit one, tell the user and offer to remove an existing trigger first.

### Delivering results

- **Setup confirmation**: once approved, confirm in one line what was set up and where it will deliver (e.g. "Done — I'll post a digest in #standup every weekday at 9am London time").
- **Listing**: present visible triggers as a short list — what each does, where it delivers, whether it's active or paused.
- **Revision**: if the user wants a change, edit or replace the trigger rather than stacking a second one.
