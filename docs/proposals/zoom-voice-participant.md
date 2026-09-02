# Zoom Voice Participant (draft proposal)

Status: **Superseded.** The MVP below shipped, and so did the task-binding and PM-consult work this proposal deliberately left out of scope — see `docs/architecture/voice.md` for the current, accurate description of the system. This document remains the record of the research behind the MVP: the wake-word investigation, the transport decision, and the latency probe below, none of which the architecture doc restates. As of this document's own last update, the connector typechecked clean and the trigger matcher had tests, but not one line of it had been exercised against a real meeting, a real Deepgram socket or a real Voice Agent session beyond Probe 1. Everything in "Component choices" below is doc-verified, not wire-verified. Original framing: Tracks issue [#151](https://github.com/sweatco/archie-hq/issues/151). Related: [#149](https://github.com/sweatco/archie-hq/issues/149) (calendar invite entry point), [#203](https://github.com/sweatco/archie-hq/issues/203) (engine emits semantic events, connectors subscribe).

## Goal

Archie joins a Zoom meeting as a **virtual employee**, not a notetaker bot. It sits muted and listens, and when somebody addresses it by name it speaks — answering from the meeting's own context, asking clarifying questions, and escalating real work to the PM when it needs to. Then it goes quiet again.

The distinction from a notetaker is not cosmetic. A notetaker is a name in the participant list that produces an artifact afterwards. An employee has a face, unmutes to speak, addresses people by name, says "I don't know, let me check", and leaves when the meeting ends. That framing drives most of the design decisions below, and it rules out the transport paths that have no participant presence.

## The core constraint: two clocks

The voice loop must close in **under ~1.5s** or the interaction feels broken. Archie's brain — PM on Opus, possibly delegating to a repo agent — takes **20s to several minutes**. That gap is a permanent property, not an optimisation target.

So the architecture is an impedance matcher between a 1-second clock and a 1-minute clock, with two independent paths:

- **Reflex path (~1s)** — answers from the meeting transcript and from whatever the PM has already told it. Runs entirely in the voice layer.
- **Deliberation path (minutes)** — a normal Archie task. Fully async. The voice layer never blocks on it; it acks immediately ("let me check"), keeps participating, and speaks the answer when it arrives.

## Architecture

Three layers with very different duty cycles. This is the key simplification: the expensive voice runtime is **not** running for most of the meeting.

```
Zoom ──per-participant audio──► [ voice sidecar ]  ──POST /api/tasks──────►  Archie engine
     ◄──────── audio ────────── (always: STT + wake  ◄──SSE message event──   (PM → repo agents)
                                 on trigger: VA)
                                        │
                             rolling attributed transcript
                                        └──batched──► meeting task knowledge.log
```

| Layer | Duty cycle | Cost |
|---|---|---|
| Per-participant STT → rolling attributed transcript | always on | ~$0.15–0.40/hr |
| Wake-word detector per participant stream | always on | ~free (on-device ONNX) |
| Voice session (turn-taking, TTS, reply LLM) | only while triggered | per-minute, minutes per meeting |

The transcript stays on always even though the voice session doesn't — otherwise Archie activates with no idea what the meeting has been about, which is the whole point.

The sidecar runs **out of process** and is not modelled as an Archie plugin agent. Plugin agents are turn-based SDK sessions; this needs continuous sub-second control loops and raw audio buffers. It is a connector that happens to speak.

### The engine seam already exists

No new engine surface is needed for the MVP. These were built for the CLI and are exactly what the sidecar needs:

- `POST /api/tasks` — create a task, returns `task_id` ([routes.ts:175](../../src/connectors/api/routes.ts))
- `POST /api/tasks/:id/message` — feed a running task ([routes.ts:197](../../src/connectors/api/routes.ts))
- `GET /api/events/stream` — SSE of all system events, filterable by `taskId` ([routes.ts:39](../../src/connectors/api/routes.ts))
- PM answers surface as `message` events with `to: 'user'` ([task.ts:607](../../src/tasks/task.ts))
- `task.linkCliChannel()` ([task.ts:442](../../src/tasks/task.ts)) is the precedent for a task whose user isn't in Slack; a `linkVoiceChannel()` is the eventual parallel

**One task per meeting**, not one per question. The transcript accumulates in a single task so Archie's other agents can act on the whole meeting. Serialisation of PM turns within one task is acceptable because the voice layer absorbs follow-ups locally and only escalates real work, so the PM queue is rarely contended.

### Sending the PM a brief, not a question

Never forward the raw utterance. The voice layer compiles: who is in the room, what has been discussed, the verbatim ask, the last ~2 minutes of transcript, and the output constraint — *"answer in ≤3 sentences, spoken register, no markdown."* The constraint is free (it is just text in the message) and it is the difference between sounding like a colleague and reading a Slack post aloud.

Preferred pattern: **speak the headline, post the detail.** "That job's been failing since Tuesday — it's the schema change, details are in the channel." Plays to what the engine is already good at and sidesteps ever speaking a code block.

## Trigger-activated, not always-listening

Reasoning and speech are gated on the trigger; the **connection is not**. The voice-runtime WebSocket is opened when the bot joins and held warm for the whole meeting, so a trigger never pays a handshake. Decided deliberately: latency at the moment of being addressed matters more than the connection-time billing.

1. Trigger detector runs continuously on each participant stream. Tuned permissive.
2. On fire, a **second-stage veto**: take the buffered utterance's transcript and let a fast model decide "was Archie actually addressed?" (see cascade rationale below).
3. On pass, ungate the warm session and hand it the last few minutes of attributed transcript.
4. Archie speaks, handles follow-ups locally, escalates if needed.
5. Exchange ends on self-reported completion, on dismissal, or after a **20–45s** silence timeout. Re-gate; the connection stays open.

What the trigger still buys, even with a warm socket, is that we do not *generate* speech or burn reasoning for 55 silent minutes — and it retires the "silent by default" problem that neither research pass found solved anywhere. Inside an active exchange, wanting to respond to every turn is *correct* runtime behaviour. The cost of the warm socket is real but bounded: Deepgram VA bills on connection time, so a 60-minute meeting is ~$4.50 rather than a few cents.

A ~30s rolling audio/transcript buffer is required: the trigger fires mid-sentence, so without the buffer the actual ask is lost and Archie has to say "sorry, what?".

## Multi-party attribution

The hardest part of the design, and the thing that makes a meeting categorically different from a phone call.

**The data exists at the transport layer.** Recall delivers per-participant audio streams with real `name` and `email` per packet (verified — see below), so per-stream STT yields `Anna: "daily"`, not "speaker 2". Archie can address people by name, which is a large part of not sounding like a kiosk.

**The problem is the runtime's worldview.** Every hosted voice-agent runtime models exactly one user. Pipe mixed meeting audio into Deepgram VA and it sees a single person who inexplicably changes voice, its turn-taking cannot distinguish "Anna replying to Archie" from "Anna interrupting Egor", and its internal transcript — the thing fed to the BYO-LLM — is flat and unattributed. Attribution is destroyed at the runtime boundary.

Three shapes, in increasing cost:

- **A — runtime as mouth only.** Own the transcript, own turn-end detection (Nova-3 endpointing per stream), own barge-in (VAD on any stream), use the runtime purely for streaming TTS. Most code, cleanest model.
- **B — VA with substituted context.** Keep VA for turn detection and TTS, but in the BYO-LLM endpoint **discard VA's transcript and substitute our own attributed one**, built from per-stream STT at that wall-clock moment. VA's turn signal becomes an event; our transcript is the actual context. The hack lives in one function.
- **C — Pipecat.** Construct context frames ourselves with attribution intact, keep the framework's interruption machinery. Costs a Python runtime.

**Decision: B for the MVP.** Least code, preserves the buy-not-build call, and C is the escalation with no wasted work — the attributed transcript layer is identical in all three.

### In-exchange behaviour

Not every utterance during an active exchange is for Archie; people keep talking to each other. The gate does not disappear on activation, it just gets much easier — with an attributed transcript, a known topic and a known addressee, one fast-model call per turn-end answers "addressed to me, part of my exchange, or between the humans?"

- **Default addressee** is whoever triggered it, by name.
- **Conflicting input takes the later instruction, out loud.** Anna says daily, Egor says both → "Egor says both, going with both." Surfacing the conflict is the human move and costs one sentence.
- **Exit generously.** Nothing outstanding and nobody addressing it for 20–45s, or a "thanks", or the topic visibly moving. Re-triggering is one word; lingering in an active session is how you get the embarrassing interruption.

## Interruption semantics

**Any human speech while Archie is talking → Archie stops mid-word, immediately.** Unconditional, no classification, no threshold. That single behaviour is most of what makes it read as a person rather than a kiosk.

Classify the interrupting utterance afterwards, four outcomes:

1. **Dismissal** — "thanks", "we'll come back to it", "Archie, shut up" → drop the remainder, go dormant.
2. **Correction / added context** — "no, the daily one" → discard the remainder, re-answer with the new information.
3. **Continue** — "sorry, go on" → resume from where it stopped.
4. **Not for Archie** — two humans started talking to each other → stay stopped and quiet.

Default when unsure is 4. Stopping first and deciding second means nothing has to be classified in real time.

## Wake word

The metric is **false accepts per hour (FPPH)**. Industry threshold for acceptable is **<0.5 FPPH with <5% false rejects**. That gives a testable target instead of a vibe.

**Approach: acoustic keyword spotting, not ASR string matching.** ASR + string match inherits every transcription failure ("Artie", "Archy", "RJ"). Keyterm boosting and phonetic fuzzy matching improve it enough to be a useful *secondary* path, but not the trigger.

**The cascade is how Siri and Alexa actually do it**, and the expensive stages are free for us. They run a tiny permissive always-on detector, then a larger verification model that can *retract*, then — in Amazon's case — post-ASR false-wake suppression, reported to improve wake detection by over 90%. We already transcribe everything continuously, so the ASR the suppression classifier needs already exists. And unlike Siri, which must light up in ~200ms, we can afford ~a second because Archie is going to say "let me check" anyway. So: permissive detector fires → buffered utterance's transcript → fast model vetoes or passes.

That inverts the difficulty. We do not need a great wake-word model; we need a permissive one plus a free second opinion.

**Tool: `livekit-wakeword`** (Apache 2.0). Verified: single YAML config with `target_phrases` (a **list** — multiple pronunciation variants in one model), `model.model_type: conv_attention`, `model.model_size`, and **`target_fp_per_hour` as an explicit training parameter**. Adversarial negatives are generated during synthesis. Exports ONNX (and openWakeWord-compatible TFLite). Published benchmark: **0.08 FPPH / 86.1% recall** on 25 hours (15k positive, 45k negative clips) — versus openWakeWord's 8.50 FPPH / 69%. That 100× gap is the difference between usable and unusable: 8.5 FPPH means Archie interrupts eight times an hour.

**One model, not two per language.** A speaker who pronounces "Archie" the same in Russian and English presents one phonetic target; splitting it halves the training data per model. If accent coverage turns out thin, the lever is **broader TTS voice mix in training** (Russian-locale and Russian-accented voices generating the same spelling), not a second model.

**The real Russian risk is collision, not pronunciation.** "архитектура" and "архив" begin with the same phoneme sequence as "Archie" — [arxi] — and are high-frequency words in exactly this team's vocabulary. Mitigations, both already chosen for other reasons:

- **Adversarial negatives**: архитектура, архив, архивный, архитектурный in the negative set. Supported by the pipeline; a config line.
- **A carrier phrase — "Hey Archie".** Nobody says "hey архитектура". More acoustic material, fewer collisions, and this kills the whole collision class. Strongest argument for the carrier.

## Transport

| Path | notice shown | can speak | per-participant audio |
|---|---|---|---|
| Meeting SDK / Recall.ai | **recording** consent + indicator | yes | yes |
| RTMS | "content shared with apps" + Active Apps Notifier, **no participant tile** | **no** | yes |
| SIP dial-in | **none on join** | yes | no — mixed mono |

There is **no silent path** through Zoom's supported APIs — every one surfaces something, by deliberate Zoom policy. So the choice is *which* disclosure, not whether.

**Decision: Recall.ai, accepting the recording notice.** Two things soften it: OAuth pre-authorisation means our own hosts approve once rather than per-meeting, and on accounts with **100+ licenses** admins can disable or customise the disclaimer for internal participants (guests always see it).

The virtual-employee framing independently settles this: a colleague needs to mute/unmute visibly and use chat, and RTMS has no participant tile at all. Two constraints agreeing is a good sign.

**Escape hatch if the recording notice ever becomes binding:** RTMS for ears + SIP dial-in for the mouth. RTMS gives per-participant transcripts with a benign app-sharing disclosure and can be auto-started at account level with no host action; SIP gives a real participant with `*6` self-mute visible to everyone and `*9` raise-hand, and no recording notice on join. Two integrations and opaque RTMS pricing — not an MVP, but a known shape.

## Component choices

| Role | Choice | Status |
|---|---|---|
| Transport | Recall.ai, `web_4_core` bot | verified; $0.60/hr |
| STT (always on) | Deepgram Nova-3 | **verified: Russian supported, real-time code-switching across 10 languages incl. EN+RU** |
| Wake word | `livekit-wakeword`, ONNX | verified (Apache 2.0) |
| Voice runtime | Deepgram Voice Agent API, BYO-LLM | verified: OpenAI chat/completions contract, `provider.type: anthropic` + custom `endpoint.url` |
| Reply LLM | Claude Haiku via the BYO-LLM endpoint | — |
| TTS | ElevenLabs Flash v2.5 | verified: ~75ms, 32 languages incl. Russian |
| Brain | existing Archie engine over REST + SSE | verified in-repo |

Deepgram Aura-2 was the earlier TTS pick and is **out** — narrower language coverage. ElevenLabs from the start avoids a vendor swap when Russian lands.

### Verified Recall mechanics

- **Per-participant realtime audio**: `recording_config.audio_separate_raw: {}` plus a WebSocket in `realtime_endpoints` receiving `audio_separate_raw.data`. Each packet carries participant `id`, `name`, `email`, `is_host`, `platform`, plus absolute (ISO8601) and relative timestamps. Audio is base64 **16 kHz mono S16LE**. **4-core bots mandatory** ("compute heavy"). Zoom/Teams/Meet supported; max 16 concurrent speakers; Webex and Slack Huddles unsupported. Real-time screenshare audio is not captured.
- **Bot's own audio is excluded by default** — no echo loop to engineer around.
- **Two output paths, and they are mutually exclusive.** *Output Media* is the streaming path: the bot runs a **headless browser on a webpage we control** and captures that page's audio output as its microphone, so we stream by pushing audio from the sidecar to the page over WebSocket and letting it play as it arrives. There is no REST endpoint that accepts a raw PCM stream — the page *is* the transport. In practice the page is not a UI: a WebSocket client feeding an AudioWorklet, plus whatever we render as the bot's video. *Output Audio* is a simpler on-demand endpoint taking base64 **MP3** clips with no webpage and no video tile, but it is clip-based. Output Video/Output Audio cannot be used while Output Media is active.
- **Barge-in is ours, not Recall's, on the Output Media path.** Because our page produces the audio, stopping mid-utterance is flushing our own buffer and cutting the feed — no Recall "stop" API is required. Expect a trailing tail of roughly 100–300ms already committed to the Zoom stream (browser capture, encode, transport); a lag, not a blocker, and comparable to human overlap. The interrupt problem *does* apply to the Output Audio clip endpoint, which is the main reason to prefer Output Media.
- **There are no participant-action endpoints.** The complete live-meeting control surface is: send chat message, output audio, output media, output video, and start/stop/pause/resume recording. **No self-mute, no raise hand, no reactions, no mid-meeting rename.** Recall reports participant mute events *inbound* but exposes no way for the bot to change its own state — and with Output Media the bot's microphone *is* our page, permanently occupied, so there is no mute state to toggle in the first place.
- **Chat is available and is the signalling channel.** On Zoom: recipients `everyone`, `host`, `everyone_except_host`, **plus DMs to a specific participant by participant ID**. 4,096 character limit. **Pinning is not supported on Zoom**, so no persistent banner.

### Verified Deepgram VA mechanics

`InjectAgentMessage` — `{ "type": "InjectAgentMessage", "message": "...", "behavior": "default|queue|interrupt" }`. The `behavior` semantics are almost exactly the meeting etiquette we specified independently:

- `default` — speaks **only during silence**; refuses if any turn is active (responds `InjectionRefused`)
- `queue` — appends after currently queued text without interrupting
- `interrupt` — always executes immediately

The server responds `AgentAudioDone` after injection completes, and user speech raises `UserStartedSpeaking`, which interrupts the agent back. This is the async-answer delivery primitive and it is native.

## Signalling readiness without a raised hand

When a PM answer lands minutes later, Archie must announce it without barging in. Recall exposes no raise-hand, so a graduated ladder replaces it — and every rung carries more information than a raised hand would, because it names the topic:

1. **Tile + DM.** The bot's video tile (which we render anyway) goes amber with `✋ answer ready: <topic>`, and a Zoom **DM to whoever asked** — "Got your answer on the retention job, say the word." Reaches exactly the person waiting, interrupts nobody, and leaves the timing to the human who asked.
2. **Gap speech** after ~60–90s unacknowledged. One short sentence via `InjectAgentMessage` with `behavior: "default"`, which speaks only during genuine silence and refuses while any turn is active. This is what a human does in a small meeting — nobody raises a hand in a standup.
3. **Let it die.** Keep the tile flagged and stay quiet. Archie does not nag.

Caveat on the tile: it is not in Zoom's raise-hand *queue*, so the host's hand list will not include Archie and the participant panel will not reorder. In gallery view it sits among the faces; in speaker view it may be off screen entirely.

## Open questions

Ordered by how much damage a bad answer does.

1. ~~End-to-end output latency.~~ **Resolved: 140ms round trip through Zoom** (see Probe 1 results). Comfortably inside budget.
2. ~~Can the bot mute/unmute itself via API? Can it raise a hand?~~ **Resolved: no, neither, and no workaround exists on Recall.** See the signalling ladder below. Both capabilities *do* exist in a self-operated Meeting SDK bot, which makes them the two concrete things being traded away by buying the transport.
3. ~~Output Media vs Output Audio for the MVP.~~ **Resolved: Output Media.** It is the only streaming path, and the path where interruption is under our own control rather than Recall's. The video tile is unavoidable there, and becomes the Archie card.
4. **`livekit-wakeword` has Python, Rust and Swift SDKs — no Node.** Either run the detector as a small Python process, or run the exported ONNX under `onnxruntime-node` and port the audio-embedding preprocessing. A ~50-line Python sidecar is not the same commitment as Pipecat, but it is worth knowing we may not stay single-language.
5. **Multilingual wake-word accuracy.** The project states plainly that multilingual models achieve lower accuracy than English ones, and non-English requires switching the TTS backend from Piper to VoxCPM2. Measure before assuming Russian parity.
6. **Zoom license count** — decides whether the internal recording disclaimer can be disabled, which decides whether open question 7 matters at all.
7. **Consent posture.** Meeting audio flows to Recall and Deepgram. Given the repo's existing sandbox/vault posture this deserves a deliberate decision, and consent should be built into the invite flow rather than treated as an afterthought.
8. **Consent behaviour with a non-host participant.** The single most valuable remaining unknown, and now the top of this list. Probe 1 saw no consent prompt and no recording indicator, but with only the host present. Needs one run with a colleague, and one with an external guest.
9. **Platform ToS drift.** Teams now labels third-party bots "Unverified" and requires organiser admission (MC1251206); Google Meet added a risk-based join queue; there is live privacy litigation. Zoom is the friendliest of the three today but the direction of travel across all conferencing platforms is against speaking bots. **Zoom account admission confirmed working — a bot joined and recorded without friction.**

## Implementation status (2026-08-27)

Built as an optional connector, mounted config-gated in `src/index.ts` in the same style as Slack and GitHub — with `RECALL_API_KEY`, `DEEPGRAM_API_KEY` and `ARCHIE_PUBLIC_URL` unset it does not initialise, open a socket, or cost anything. Verified by audit: import-time side effects across all six modules are constants and two empty collections.

| module | role |
|---|---|
| `types.ts` | the contract between modules |
| `recall.ts` | Recall REST client |
| `audio-out.ts` | Output Media page, plus the two-stage audio gate into the meeting |
| `deepgram.ts` | Nova-3 per-participant STT and the Voice Agent session |
| `meeting.ts` | transcript, trigger, veto, exchange orchestration |
| `llm.ts` | the BYO-LLM endpoint, where attribution is restored |
| `index.ts` | mount, routes, meeting lifecycle |

Entry point is `POST /api/voice/meetings { meeting_url }` — manual, per the MVP scope, and still the only way in: there is still no calendar integration. A PM/Archie task connection, absent when this was written, has since been added on top of this — see `docs/architecture/voice.md`.

### Design decisions that came out of building it

**Two gates in series, not one.** The input gate stops the Voice Agent hearing the room outside an exchange; the output gate stops audio reaching the room even if the agent decides to speak anyway. Deepgram's own guidance is that prompting an agent into silence is unreliable and that anything reliability-critical needs a server-side gate dropping audio bytes — so the byte-dropping gate is the control and a quiet reply from `llm.ts` is defence in depth. The output gate defaults closed, so a sink nobody opened plays nothing.

**The opening ask is injected, not overheard.** The original design had the gate open on a confirmed trigger and let the agent take a turn naturally. That fails in the exact case that matters: ask a question, stop talking, and the gate opens onto silence with no turn ever detected. `InjectUserMessage` makes it deterministic. Deepgram's message-flow diagram presents text injection as an alternative to audio rather than a supplement, and unlike `InjectAgentMessage` it has no documented refusal path.

**An exchange is bounded three ways.** A two-minute hard cap enforced in one place (each window clamped to `min(30s, remaining)`, so no timer can fire past the cap); refresh eligibility limited to the opener, anyone after the agent has actually replied, or anyone saying the name again; and VAD-only speech events excluded from refreshing at all. Without these, one legitimate mention un-gated the agent for the rest of the meeting — proven by execution, with the agent generating a real answer to an unrelated conversation ten minutes later.

**No trained wake word.** A transcript trigger (Nova-3 keyterm prompting plus whole-token matching) instead. `matchTrigger` tokenizes on a Unicode-aware separator class and compares whole tokens, which makes substring false positives structurally impossible rather than blacklisted — necessary because JavaScript's `\b` is ASCII-only, so `/\bарчи\b/u` matches nothing at all. 37 tests in `src/voice/__tests__/match-trigger.test.ts` pin the behaviour, including the `архитектура` / `архив` / `archive` collision class.

**Model-improvement opt-out on all three Deepgram surfaces.** Not uniform: a query parameter on STT and TTS, a `Settings` field on the Voice Agent. This bot captures colleagues who never agreed to anything with Deepgram, so opting out is not a default to accept on their behalf.

### Known residuals

- While an exchange is legitimately open, the agent hears whoever is in the room for up to 30s after the last eligible turn. Inherent to gating on Recall's mixed stream; bounded by the window, the cap and the output gate.
- A name split across two STT finals is recovered by holding the row for 6s and re-judging with the next final from the same speaker. The hold window is a guess that real transcripts should correct.
- `arche` and `rj` are the weakest trigger variants; the veto is their backstop and the activation log will show whether they earn their place.
- `POST /api/voice/meetings` is unauthenticated, matching the existing `/api` routes — but it is the first route whose per-request cost is metered at three vendors.
- Credential redaction matches exact key strings only; a body echoing a truncated prefix or a re-encoded form would still leak.
- `npm run lint` is broken repo-wide (no eslint config, eslint not installed), so no lint rule gates any of this. Tracked separately.

## Plan to MVP

### Gate — Zoom account will admit a bot, local recording enabled at account level

**Confirmed by the account owner.** Local recording must be on at account level or the Meeting SDK permission prompt never appears. This was the only check that could invalidate the whole plan.

### Probe 1 — DONE (2026-08-27). Latency measured; consent behaviour unexpected.

Method: tone loopback on a single clock. A bot with `audio_separate_raw` and `include_bot_in_recording.audio: true` streams its own audio back to us, so a chirp pushed at T0 is detected returning at T1 with no clock-sync problem. Two variants were run — chirps on a timer (`probe1/probe.mjs`), then chirps triggered by a human's speech onset so the human's own action is the reference (`probe1/echo.mjs`).

**Results (n=15, spoken trigger, tight distribution 407–437ms):**

| leg | median |
|---|---|
| our HTTP POST to Recall's API (Frankfurt) | 295ms |
| **audio round trip through Zoom** (our dispatch → audible → back at our socket) | **140ms** |
| full perceived loop, speech onset at our socket → chirp back | 431ms |

**The 140ms is the load-bearing number.** It is a *round trip* covering our page → Zoom → back down → Recall → us, which bounds the outbound leg at under 140ms. Recall's published ~200ms input figure is evidently conservative. An earlier reading of 300–500ms was an artefact of an RMS threshold catching the chirp's body rather than its leading edge; at a lower threshold the true figure appears.

**The 295ms POST is an artefact of the probe, not the design.** The real path streams over the persistent Output Media WebSocket with no per-utterance API call, so that component largely disappears.

Revised reflex-path budget, with the measured leg substituted in: speech → our socket ≤140ms, Nova-3 final 150–300ms, trigger + veto 200–400ms, TTS TTFB 150–250ms, our stream → audible ≤140ms. **Total roughly 0.65–1.25s**, inside the 1.5s target with room.

Byproducts, all verified live rather than from documentation:

- **The bot's own audio does arrive on the realtime stream.** `include_bot_in_recording.audio: true` applies to realtime, not only the stored recording — the loopback method is valid and the two-bot fallback is unnecessary.
- **Per-participant attribution works with real display names** — the stream cleanly separated `Archie (probe)` from `Egor Khmelev`. The foundation of the attribution design, confirmed.
- **Bot join → audio flowing: 4.5s.** Fast enough to join on demand mid-meeting.
- **Cost: ~1.5 bot-minutes per 90-second run**, well under a cent per probe.

### Probe 1's surprise: no consent prompt and no recording indicator

Nothing was shown to the host, and the bot record explains why it cannot have been approved by a human:

```
joining_call          11:45:29.787
in_call_not_recording 11:45:31.822
in_call_recording     11:45:32.110   <- 288ms later
variant: { zoom: "web_4_core" }
```

**288ms from in-call to recording means no consent was ever requested.** The likely cause is the variant: `web_4_core` is Recall's *web* family, i.e. joining through the Zoom Web Client rather than the native Meeting SDK — a path that never asks for the local-recording privilege. This also explains why per-participant audio requires 4-core bots and is described as "compute heavy": Recall is separating streams itself inside a browser rather than receiving them pre-separated from the SDK.

If this holds it collapses the central tension in this proposal — **per-participant audio *and* no recording notice**, the combination both research passes concluded was impossible on Zoom — and the RTMS-plus-SIP escape hatch becomes unnecessary.

**Not yet safe to bank, for one specific reason.** The test had a single human who was also the host, which is the one case Zoom documents as showing nothing ("the host who initiates the recording will not see the prompt, but all other participants will"). A second candidate explanation also fits: `sweatcoin.zoom.us` is a business account, and at 100+ licenses admins can disable the disclaimer for internal participants. **The distinguishing test is a run with a second participant, and ideally once with an external guest, since guests are always notified regardless of account settings.**

### Probe 1's other finding: Zoom noise suppression is upstream of us

Hand claps as a test signal were suppressed by Zoom before Recall ever saw them. Beyond invalidating claps as a stimulus, this has a design consequence: **the wake-word detector will only ever see Zoom-processed audio.** Suppression runs before capture, so training and evaluation should use Zoom-processed samples rather than clean recordings — which is a further argument for deferring the trained detector until the MVP has captured a real corpus, since that corpus is Zoom-processed by construction.

Infrastructure prerequisite, easy to overlook: **two publicly reachable URLs.** Recall pushes realtime audio to a `wss://` endpoint and its headless browser *loads* the Output Media page over `https://`. Neither can be localhost — a tunnel or public host is required.

### Probe 2 — acoustic wake word (deferred, not blocking)

Deferred deliberately. The MVP uses a **transcript trigger** instead: Nova-3 with keyterm prompting on "Archie" plus phonetic fuzzy matching, which is free because we already transcribe continuously. That is roughly twenty lines and it exercises the whole loop.

The MVP then *generates* what this probe wanted — every trigger and near-trigger, with audio, from real meetings — so the acoustic detector gets evaluated against a real corpus instead of a guessed training config. Training moves from prerequisite to measured upgrade, which also removes the multilingual-accuracy and Node-vs-Python questions from the critical path.

### MVP

1. Bot joins a Zoom meeting from a manually supplied URL.
2. Always-on per-participant STT builds an attributed rolling transcript.
3. Transcript trigger fires; second-stage veto confirms.
4. Archie answers from meeting context, in a spoken register, in three sentences or fewer.
5. Archie re-gates and goes quiet when done (there is no mute to toggle).

Acceptance criteria beyond the happy path:

- **Barge-in.** Interrupt it mid-sentence and it stops mid-word. This is the test that discriminates between runtimes; without it we would pick the voice stack on a criterion we never exercised.
- **Attribution.** Archie asks a clarifying question, a *second* participant answers, and Archie responds to that person by name. Two minutes to test, and it exercises attribution, the in-exchange gate and the runtime seam at once.
- **Every activation logged**, including ones the second-stage veto suppressed — timestamp, speaker, buffered transcript, verdict. One real meeting then yields a measured FPPH and a list of near-misses instead of an anecdote.

### Deliberately not in the MVP

- Any Archie/PM connection. That half is already built and is the known quantity.
- Calendar/invite joining (#149) — manual join URL.
- Semantic addressee detection. Trigger plus veto only.
- The trained acoustic wake word — transcript trigger instead (see Probe 2).
- Self-operated Meeting SDK transport. Recall for now, behind a `join/leave/onAudio/sendAudio/sendChat` interface so it stays swappable. Worth filing the Zoom raw-data entitlement request early regardless, since it is the only item with external lead time.
- Russian *output*. Speak English; ElevenLabs is chosen so this is a config change later.
- Answer-quality tuning. Wire the transcript to Haiku with a spoken-register instruction and stop. Answer quality is the part we know works; polishing it is the trap.

### Cost

About **$1–2 per meeting** for transport and STT, plus ~$4.50/hr for the warm Deepgram VA connection. Roughly **$6 for a one-hour meeting**. Not a design constraint at experiment scale; the warm socket is the largest line item and the first thing to revisit if it ever matters.

## Sources

Zoom transport and consent: Zoom Meeting SDK / RTMS documentation, Recall.ai comparison write-ups. Voice stack: [Deepgram BYO-LLM](https://developers.deepgram.com/docs/voice-agent-llm-models), [InjectAgentMessage](https://developers.deepgram.com/docs/voice-agent-inject-agent-message), [Nova-3 code-switching](https://developers.deepgram.com/docs/multilingual-code-switching), [ElevenLabs models](https://elevenlabs.io/docs/overview/models). Wake word: [livekit-wakeword](https://github.com/livekit/livekit-wakeword), [LiveKit announcement](https://livekit.com/blog/livekit-wakeword), [openWakeWord](https://github.com/dscripka/openWakeWord), [Sensory wake-word FAQ](https://sensory.com/wake-word-faq-performance-accuracy-and-implementation/), [Amazon word-level wakeword verification](https://cdn.amazon.science/ba/c5/bd48ce11445ba0368d2d9191600d/building-a-robust-word-level-wakeword-verification-network.pdf). Recall mechanics: [separate audio per participant](https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime), [output media](https://docs.recall.ai/docs/stream-media), [output audio](https://docs.recall.ai/docs/output-audio-in-meetings).
