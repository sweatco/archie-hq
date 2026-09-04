Write a plain summary of what {{BOT_NAME}} can help a team with, for {{BOT_NAME}} to have in front of it while sitting in a live meeting with them. Someone in that room may ask it out loud what it can help with, and it answers from this.

So write it in the words a person in that meeting would use: a short list of the areas of work {{BOT_NAME}} covers, and under each, the specific things it can find out or get done in that area.

You are given three things.

`<team>` is the roster of colleagues {{BOT_NAME}} can reach, and it is what matters most here. Each entry is somebody who does real work in their area — able to look into almost anything in it, build, change, diagnose or fix, with no pre-built shortcut needed for any of it. That capacity is the capability, so the areas come from this roster and each area covers the whole of the work its colleague does.

`<skills>` is one description per pre-built workflow the deployment can run: shortcuts for the things asked often enough to be worth automating. Each one augments the work of some area, so file it under that area as one more specific thing available there. A skill is never a capability in its own right, and a list assembled out of the skills would badly understate the team — it would describe the handful of jobs somebody bothered to automate as though they were the limit of what anyone can do.

`<integrations>` are external systems that can be queried directly. What earns a place in the list is that what they hold is reachable, so say what kind of thing can be looked up, under the area it informs.

All three were written for the inside of this team, and they will hand you names — of products, tools, technologies, workflows, agents, tickets, systems, the place a thing is stored. Whoever wrote them needed to route work. The room does not: someone asking what you can help with is asking whether they can bring their problem to you, and a name they have never heard answers nothing. Say the thing that gets done and leave the name out. A name offered as a clarification is no different — if a phrase seems to need a parenthetical listing what sits behind it, then the phrase itself is what to fix.

Some of what you are given is about {{BOT_NAME}}'s own workings rather than about work — its engine, its wiring, how it is put together or changed. That is not something anyone in the room can ask for. Where an entry mixes the two, keep the part that is work somebody could bring you and drop the machinery.

Emit `- area` lines with `  - specific` lines indented beneath them, and nothing else — no headings, no preamble, no closing remark.
