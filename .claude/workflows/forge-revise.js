export const meta = {
  name: 'forge-revise',
  description: 'Forge v2 post-ship revision: apply an operator-requested change to a shipped run\'s branch through the full machinery — request-mode implement with blind review, re-QA, docs delta, PR/plan-record refresh. Never hand-edits.',
  whenToUse: 'Invoked by the /forge conductor when the operator requests a change to a PR a Forge run produced. Input: the run identity (change/branch/brief/acs/plan — from the done result, or reconstructed from the docs/plans record) plus the request verbatim.',
  // No meta.phases and no phase() calls on purpose: all work runs in child workflows, whose
  // agents render under their own "▸ forge-<stage>" groups (see forge-run for the rationale).
}

// args: { change, branch, base?, brief, acs, plan: {design, tasks, verificationPlan, summary},
//         request: string  — the operator's requested change, verbatim,
//         evidenceDir?, workflowsDir?  — same semantics as forge-run,
//         answers?: { implement?: string | { request?, setup?, gate?, review? }, qa?: string,
//                     docs?: string, ship?: string } }
// One QA pass, no auto route-back: the operator is actively steering a revision. A QA FAILURE
// impasse is terminal for this launch (resume would replay the cached failure) — the escape is
// a fresh forge-revise with an amended request, or abandonment. All OTHER impasses resume as in
// forge-run: identical args plus the answer under the key the impasse question names.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.change || !input.branch || !input.brief || !Array.isArray(input.acs) || !input.request) return { status: 'error', reason: 'missing input.change/branch/brief/acs/request' }
// Validate the plan SHAPE up front — especially for cross-session launches where it was
// reconstructed from the docs/plans record — so a malformed plan fails here, before the
// expensive committing implement stage, not after it.
if (!input.plan || typeof input.plan.design !== 'string' || !Array.isArray(input.plan.tasks) || !Array.isArray(input.plan.verificationPlan) || input.plan.verificationPlan.length === 0) {
  return { status: 'error', reason: 'input.plan must carry design (string), tasks (array), and a non-empty verificationPlan (array) — reconstruct all three from the docs/plans record before launching' }
}
const base = input.base || 'main'
const answers = input.answers || {}
const evidenceDir = input.evidenceDir || `/tmp/forge-${input.change}/qa-evidence`

const run = async (name, childArgs, stage) => {
  try {
    const r = await workflow(input.workflowsDir ? { scriptPath: `${input.workflowsDir}/${name}.js` } : name, childArgs)
    if (!r) return { status: 'impasse', stage, question: `${name} returned nothing. Retry the revision?`, context: null }
    if (r.status === 'error' && !r.stage) return { ...r, stage }
    return r
  } catch (e) {
    return { status: 'impasse', stage, question: `${name} threw: ${String((e && e.message) || e)}. Retry the revision?`, context: null }
  }
}

const implRes = await run('forge-implement', { change: input.change, branch: input.branch, base, brief: input.brief, acs: input.acs, plan: input.plan, fresh: false, request: input.request, guidance: answers.implement }, 'implement')
if (implRes.status !== 'ok') return implRes
log(`Revision implemented and reviewed clean in ${implRes.rounds} round(s)`)

const qaRes = await run('forge-qa', { acs: input.acs, verificationPlan: input.plan.verificationPlan, evidenceDir, guidance: answers.qa }, 'qa')
if (qaRes.status !== 'ok') return qaRes
if (qaRes.failures.length > 0) {
  // Terminal on purpose: resuming this run would replay every completed call from cache into
  // the identical failure. The escape is a FRESH forge-revise launch with an amended request —
  // the branch keeps this revision's commits — or abandoning the revision.
  return { status: 'impasse', stage: 'qa', terminal: true, question: `${qaRes.failures.length} AC(s) failing after the revision. Resume cannot help here (completed calls replay from cache). Launch a NEW forge-revise with an amended request (the branch keeps this revision's commits), or abandon the revision.`, context: qaRes.failures }
}

const docsRes = await run('forge-docs', { branch: input.branch, base, brief: `${input.brief}\n\nOperator revision applied on top of the shipped change: ${input.request}`, guidance: answers.docs }, 'docs')
if (docsRes.status !== 'ok') return docsRes

const shipRes = await run('forge-ship', {
  change: input.change,
  branch: input.branch,
  base,
  brief: input.brief,
  acs: input.acs,
  plan: input.plan,
  planSummary: `${input.plan.summary || 'shipped change'} (revised: ${input.request})`,
  manifest: qaRes.manifest,
  docsUpdated: [...(docsRes.updated.updated || []), ...(docsRes.updated.created || [])],
  guidance: answers.ship,
}, 'ship')
if (shipRes.status !== 'ok') return shipRes

return { status: 'done', pr: shipRes.pr, manifest: qaRes.manifest, nonBlockingFindings: (() => {
  const nb = []
  if (implRes.verdicts) for (const [key, v] of Object.entries(implRes.verdicts)) {
    if (v && Array.isArray(v.findings)) for (const f of v.findings) if (!f.blocking) nb.push({ stage: 'implement', reviewer: key, text: f.text, file: f.file })
  }
  return nb
})(), rounds: { implement: implRes.rounds, docs: docsRes.rounds } }
