export const meta = {
  name: 'forge-run',
  description: 'Forge v2 master chain: plan → implement → QA (with route-back) → docs → ship. Runs autonomously from AC sign-off to an open PR, or returns a structured impasse.',
  whenToUse: 'Invoked by the /forge conductor after the operator signs off the brief + ACs. Input: change name, brief, ACs, dossier. On impasse: answer in chat, relaunch with resumeFromRunId and the answer under args.answers.',
  // No meta.phases and no phase() calls here on purpose: this workflow spawns no agents of its
  // own — all work runs in child workflows, whose agents render under their own "▸ forge-<stage>"
  // groups. Parent-declared phases would only render as permanently empty boxes next to them.
}

// args: {
//   change: string (kebab-case), base?: string ('main'), branch?: string (`forge/<change>`),
//   brief: string, acs: [{id, text, method}], dossier: [{claim, citation}],
//   evidenceDir?: string,
//   workflowsDir?: string  — ABSOLUTE path to this repo's .claude/workflows. Always pass it:
//     named workflow resolution is cwd-scoped, and in multi-repo sessions the cwd is the repos'
//     parent directory, so child stages invoked by bare name fail to resolve there.
//   answers?: {            — operator impasse answers, added on resume; NEVER set on first launch
//     plan?: string, implement?: string | { [taskId]: string, gate?, review? },
//     qa?: string, qaCycles?: string, docs?: string, ship?: string,
//   },
// }
// Resume contract: relaunch with the SAME args plus the answer under the key the impasse
// question names. Answers reach only the stage that impassed (and only its guided-retry
// prompts), so every completed agent call replays from cache. Replay is POSITIONAL: the
// longest unchanged prefix of agent calls replays; from the first divergent call onward
// everything runs live — which is why re-reviews and re-QA after a live fix never replay
// stale verdicts even when their prompts are byte-identical to earlier rounds. `args` may
// arrive as a JSON string — normalize before use.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.change || !input.brief || !Array.isArray(input.acs)) return { status: 'error', reason: 'missing input.change/brief/acs' }
const base = input.base || 'main'
const branch = input.branch || `forge/${input.change}`
const answers = input.answers || {}
const evidenceDir = input.evidenceDir || `/tmp/forge-${input.change}/qa-evidence`

// Child workflows return { status: 'ok' | 'impasse' | 'error', ... }. Propagate anything
// non-ok upward unchanged (plus the stage tag) so the conductor can run the answer round-trip.
// With workflowsDir set, children resolve by script path (robust in multi-repo sessions);
// bare names remain the fallback for cwd-at-repo-root sessions.
const run = async (name, childArgs, stage) => {
  try {
    const r = await workflow(input.workflowsDir ? { scriptPath: `${input.workflowsDir}/${name}.js` } : name, childArgs)
    if (!r) return { status: 'impasse', stage, question: `${name} returned nothing. Retry the run?`, context: null }
    return r
  } catch (e) {
    return { status: 'impasse', stage, question: `${name} threw: ${String((e && e.message) || e)}. Retry the run?`, context: null }
  }
}

const planRes = await run('forge-plan', { brief: input.brief, acs: input.acs, dossier: input.dossier || [], guidance: answers.plan }, 'plan')
if (planRes.status !== 'ok') return planRes
log(`Plan ready: ${planRes.plan.tasks.length} tasks, ${planRes.rounds} critique round(s)`)

let implRes = await run('forge-implement', { change: input.change, branch, base, brief: input.brief, acs: input.acs, plan: planRes.plan, fresh: true, guidance: answers.implement }, 'implement')
if (implRes.status !== 'ok') return implRes
log(`Implementation reviewed clean in ${implRes.rounds} round(s)`)

const qaCap = answers.qaCycles ? 3 : 2
let qaRes = null
let cycles = 0
while (cycles < qaCap) {
  cycles++
  qaRes = await run('forge-qa', { acs: input.acs, verificationPlan: planRes.plan.verificationPlan, evidenceDir, guidance: answers.qa }, 'qa')
  if (qaRes.status !== 'ok') return qaRes
  if (qaRes.failures.length === 0) break
  if (cycles === qaCap) {
    // The qaCycles unlock is deliberately one-shot: caps exist so runs stay bounded.
    return answers.qaCycles
      ? { status: 'impasse', stage: 'qa', terminal: true, question: `${qaRes.failures.length} AC(s) still failing after the operator-guided extra cycle. The run has exhausted its QA budget — abandon it (fix manually or start a fresh run with a reworked brief); no further answer unlocks more cycles.`, context: qaRes.failures }
      : { status: 'impasse', stage: 'qa', question: `${qaRes.failures.length} AC(s) still failing after ${cycles} QA cycles. How should the fixes change? (Your answer becomes guidance keyed "qaCycles" and unlocks ONE more fix + QA cycle — it is delivered into the extra cycle's fix prompts.)`, context: qaRes.failures }
  }
  log(`QA cycle ${cycles}: ${qaRes.failures.length} failing AC(s) — routing back to implement`)
  // The operator's qaCycles steer is baked only into the UNLOCKED cycle's route-back (the one
  // new call sequence on resume). Keyed answers.implement guidance travels separately to EVERY
  // route-back, so per-unit impasse answers stay honorable in any cycle; successful calls ignore
  // guidance, keeping earlier cycles cache-stable.
  const unlockedRouteBack = cycles === 2 && answers.qaCycles
  implRes = await run('forge-implement', { change: input.change, branch, base, brief: input.brief, acs: input.acs, plan: planRes.plan, fresh: false, fixes: qaRes.failures, steer: unlockedRouteBack ? answers.qaCycles : undefined, guidance: answers.implement }, 'implement')
  if (implRes.status !== 'ok') return implRes
}

const docsRes = await run('forge-docs', { branch, base, brief: input.brief, guidance: answers.docs }, 'docs')
if (docsRes.status !== 'ok') return docsRes

const shipRes = await run('forge-ship', {
  change: input.change,
  branch,
  base,
  brief: input.brief,
  acs: input.acs,
  plan: planRes.plan,
  planSummary: planRes.plan.summary,
  manifest: qaRes.manifest,
  docsUpdated: [...(docsRes.updated.updated || []), ...(docsRes.updated.created || [])],
  guidance: answers.ship,
}, 'ship')
if (shipRes.status !== 'ok') return shipRes

return {
  status: 'done',
  pr: shipRes.pr,
  manifest: qaRes.manifest,
  planSummary: planRes.plan.summary,
  // The full plan travels out so the conductor can launch fix-mode forge-implement for
  // post-run review feedback (it requires plan.design and plan.tasks).
  plan: planRes.plan,
  rounds: { plan: planRes.rounds, implement: implRes.rounds, qaCycles: cycles, docs: docsRes.rounds },
}
