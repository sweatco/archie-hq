export const meta = {
  name: 'forge-plan',
  description: 'Forge v2 plan: planner drafts design/tasks/verification plan; completeness critic and red team harden it in a capped loop',
  whenToUse: 'Invoked by forge-run after AC sign-off. Not normally launched directly.',
  phases: [
    { title: 'Draft', detail: 'planner: design, ordered tasks, verification plan' },
    { title: 'Critique', detail: 'completeness critic ∥ red team, cap 3 rounds' },
  ],
}

// args: { brief: string, acs: [{id, text, method}], dossier: [{claim, citation}], guidance?: string }
// guidance is the operator's answer to a previous cap-impasse; it unlocks ONE extra guided
// revision round. It must never leak into the capped rounds' prompts — those stay stable so a
// resumed run replays them from cache.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.brief || !Array.isArray(input.acs)) return { status: 'error', reason: 'missing input.brief or input.acs' }

const PLAN = {
  type: 'object',
  properties: {
    design: { type: 'string', description: 'The design, markdown: approach, key decisions, affected files/subsystems, error and recovery paths, known trade-offs' },
    tasks: {
      type: 'array',
      description: 'Small, ordered, independently checkable tasks (typecheck/tests per task)',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'What to change and where; concrete enough that a fresh agent can execute it' },
          tests: { type: 'string', description: 'The tests this task adds or must keep green' },
        },
        required: ['id', 'title', 'detail', 'tests'],
      },
    },
    verificationPlan: {
      type: 'array',
      description: 'One row per AC',
      items: {
        type: 'object',
        properties: {
          ac: { type: 'string', description: 'AC id' },
          method: { type: 'string', enum: ['unit', 'integration', 'live-e2e', 'manual', 'deploy-only'] },
          scenario: { type: 'string', description: 'The concrete scenario/check that will produce the evidence' },
          evidence: { type: 'string', description: 'What the evidence will look like and where it will live' },
        },
        required: ['ac', 'method', 'scenario', 'evidence'],
      },
    },
    summary: { type: 'string', description: 'Compact plan summary for the operator: goal, approach, task count, verification highlights, trade-offs' },
  },
  required: ['design', 'tasks', 'verificationPlan', 'summary'],
}

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          blocking: { type: 'boolean' },
        },
        required: ['text', 'blocking'],
      },
    },
  },
  required: ['pass', 'findings'],
}

const planContext = `The brief:\n<brief>${input.brief}</brief>\nThe acceptance criteria (the contract every stage verifies against):\n${JSON.stringify(input.acs, null, 2)}\nThe fact-checked research dossier (only confirmed claims):\n${JSON.stringify(input.dossier || [], null, 2)}`

const critics = [
  {
    key: 'completeness',
    prompt: (p) => `You verify a plan covers its contract. Inputs: brief + ACs + dossier, and the plan. For each AC: is it fully satisfied by the design, and does the verification plan give it a concrete, evidence-producing check? Then hunt for what's missing: edge cases, error paths, migrations for persisted state, rollback, recovery/restart interactions, docs the repo expects. ${planContext}\nThe plan:\n${JSON.stringify(p, null, 2)}`,
  },
  {
    key: 'red-team',
    prompt: (p) => `You try to kill this plan. Inputs: brief + ACs + dossier, and the plan. Attack: (1) blast radius — what else does this touch that the plan doesn't mention? (2) security & sandbox — does anything widen access or violate the dossier's constraints? (3) simplicity — propose a materially simpler design that meets all ACs; if you can, the plan is over-engineered and that is a blocking finding. (4) what will this break that no test covers? ${planContext}\nThe plan:\n${JSON.stringify(p, null, 2)}`,
  },
]

const critique = async (which, tag) => {
  const verdicts = await parallel(which.map((c) => () =>
    agent(c.prompt(plan), { label: `critic:${c.key} ${tag}`, phase: 'Critique', schema: VERDICT }).then((v) => ({ key: c.key, v }))
  ))
  const blocking = []
  for (const r of verdicts.filter(Boolean)) {
    if (r.v) {
      lastVerdicts[r.key] = r.v
      for (const f of r.v.findings) if (f.blocking) blocking.push({ critic: r.key, text: f.text })
    }
  }
  return blocking
}

const revisePrompt = (blocking, extra) => `You are the planner, revising your plan to resolve blocking findings from independent critics. Address every finding; do not silently drop tasks or ACs.${extra || ''} ${planContext}\nThe current plan:\n${JSON.stringify(plan, null, 2)}\nBlocking findings:\n${JSON.stringify(blocking, null, 2)}`

phase('Draft')
let plan = await agent(
  `You are a planner. Inputs are ONLY the brief, ACs, and dossier below — you have no other context and must not assume any. Produce: (1) a design that satisfies every AC within the dossier's constraints; (2) small ordered tasks, each independently checkable; (3) a verification plan mapping every AC id to its method and the concrete scenario/check producing its evidence. Follow the repo's conventions (read CLAUDE.md and docs/architecture/ as needed). ${planContext}`,
  { label: 'planner', phase: 'Draft', schema: PLAN }
)
if (!plan && input.guidance) {
  plan = await agent(
    `You are a planner. Inputs are ONLY the brief, ACs, and dossier below — you have no other context and must not assume any. Operator guidance from a previous failed attempt: ${input.guidance}. Produce: (1) a design that satisfies every AC within the dossier's constraints; (2) small ordered tasks, each independently checkable; (3) a verification plan mapping every AC id to its method and the concrete scenario/check producing its evidence. Follow the repo's conventions (read CLAUDE.md and docs/architecture/ as needed). ${planContext}`,
    { label: 'planner (guided)', phase: 'Draft', schema: PLAN }
  )
}
if (!plan) return { status: 'impasse', stage: 'plan', question: 'The planner agent failed to produce a plan. Retry the run, or rescope?', context: null }

phase('Critique')
let lastVerdicts = {}
let pending = critics
let blocking = []
let rounds = 0
while (rounds < 3) {
  rounds++
  blocking = await critique(pending, `r${rounds}`)
  if (blocking.length === 0) {
    log(`Plan accepted after round ${rounds}`)
    return { status: 'ok', plan, rounds, verdicts: lastVerdicts }
  }
  if (rounds === 3) break
  log(`Round ${rounds}: ${blocking.length} blocking finding(s) — revising`)
  const revised = await agent(revisePrompt(blocking), { label: `planner r${rounds + 1}`, phase: 'Draft', schema: PLAN })
  if (revised) plan = revised
  const blockedCritics = new Set(blocking.map((b) => b.critic))
  pending = critics.filter((c) => blockedCritics.has(c.key))
}

// Cap hit. The guided escape hatch: an operator answer (via resume args) buys exactly one more
// revision + full critique round, in prompts the capped rounds never used (so they stay cached).
if (input.guidance) {
  log('Cap hit — running one operator-guided revision round')
  const revised = await agent(revisePrompt(blocking, `\nOperator guidance from the impasse: ${input.guidance}. The operator's word overrides a critic's finding where they conflict.`), { label: 'planner (guided)', phase: 'Draft', schema: PLAN })
  if (revised) plan = revised
  blocking = await critique(critics, 'guided')
  if (blocking.length === 0) return { status: 'ok', plan, rounds: rounds + 1, verdicts: lastVerdicts, guided: true }
}
return { status: 'impasse', stage: 'plan', question: `Plan critics still have ${blocking.length} blocking finding(s) after ${input.guidance ? 'a guided round' : '3 rounds'}. How should we proceed?`, context: { blocking, summary: plan.summary } }
