export const meta = {
  name: 'forge-qa',
  description: 'Forge v2 QA: black-box verification of acceptance criteria against a live instance by roles that never see the code, plus an independent verdict reviewer',
  whenToUse: 'Invoked by forge-run after implementation review passes. Not normally launched directly.',
  phases: [
    { title: 'Preflight', detail: 'harness / docker / debug MCP availability' },
    { title: 'Run', detail: 'blind QA runner: per-AC scenarios and evidence' },
    { title: 'Verdict', detail: 'independent reviewer audits the evidence' },
  ],
}

// args: { acs: [{id, text, method}], verificationPlan: [{ac, method, scenario, evidence}],
//         evidenceDir: string, guidance?: string }
// guidance is the operator's answer to a previous runner-failure impasse; it powers one
// guidance-augmented retry (a cache miss on resume) while cached successes replay untouched.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(input.acs) || !Array.isArray(input.verificationPlan)) return { status: 'error', reason: 'missing input.acs or input.verificationPlan' }
const evidenceDir = input.evidenceDir || '/tmp/forge-qa-evidence'
const guidance = input.guidance ? `\nOperator guidance from a previous impasse: ${input.guidance}` : ''

// The blindness contract: QA roles receive ONLY the ACs and the verification plan —
// never the diff, the design, or any implementer context. That is the point.
const qaContext = `Acceptance criteria:\n${JSON.stringify(input.acs, null, 2)}\nVerification plan:\n${JSON.stringify(input.verificationPlan, null, 2)}`

const RESULTS = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ac: { type: 'string' },
          status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'BLOCKED'] },
          evidence: { type: 'string', description: 'Path under the evidence dir, test file + case name, or for BLOCKED: what is missing' },
          repro: { type: 'string', description: 'For FAILED: the exact failing scenario, replayable' },
        },
        required: ['ac', 'status', 'evidence'],
      },
    },
  },
  required: ['results'],
}

phase('Preflight')
const pre = await agent(
  `Check what live-QA infrastructure is available in this environment, without booting anything yet: (1) the archie-e2e skill and its tools (tools/e2e/); (2) docker: does "docker compose version" work, and does a .env with the required keys exist? (3) the archie-debug MCP (.mcp.json). Report availability and, if unavailable, the exact reason. Consult docs/guides/e2e-in-cloud-sandbox.md before declaring the harness unavailable in a sandbox — apparent preflight failures there are often a setup gap, not a missing capability.`,
  { label: 'preflight', phase: 'Preflight', effort: 'low', schema: { type: 'object', properties: { liveAvailable: { type: 'boolean' }, reasons: { type: 'array', items: { type: 'string' } } }, required: ['liveAvailable', 'reasons'] } }
)
const liveAvailable = pre ? pre.liveAvailable : false
if (!liveAvailable) log(`Live QA unavailable: ${pre ? pre.reasons.join('; ') : 'preflight agent failed'} — live-e2e ACs will be waived with named steps`)

phase('Run')
const runnerPrompt = `You are a black-box QA engineer. Inputs: the acceptance criteria and the verification plan below. You have NOT seen the implementation and MUST NOT read the implementation diff or non-test source changes — judge the running system and the test suite only (inspecting and running test files is allowed; they are your domain). ${qaContext}\n\nLive infrastructure available: ${liveAvailable} (${pre ? pre.reasons.join('; ') : ''}).\n\n${liveAvailable ? "For each AC with method live-e2e: load the archie-e2e skill and follow it — boot the system under test from the current branch, wait for health, drive the plan's scenario through the archie-debug MCP (nonce → create_task → wait_for_task → approve when the edit gate fires), read the knowledge log and event JSONL, assert the AC against observed behavior, and tear down when done." : 'Live infra is unavailable in this environment — mark every live-e2e AC BLOCKED with the named post-merge or local step from the verification plan; do not attempt to boot.'} For each AC with method unit or integration: run the suite; if a named test case demonstrably covers the AC, record VERIFIED with the test file + case name as the evidence; otherwise execute the plan's check yourself. ACs with method manual or deploy-only: mark BLOCKED with the plan's named step. First delete any existing contents of ${evidenceDir} (stale evidence from a previous cycle must never be re-audited), then record fresh evidence per AC under ${evidenceDir}/<AC-id>/ — the exact assertions checked, event/log excerpts, pass/fail. Report per-AC: VERIFIED (evidence attached) / FAILED (replayable repro attached) / BLOCKED (what is missing). Candor over polish: never report VERIFIED without evidence you recorded yourself.`
let runner = await agent(runnerPrompt, { label: 'qa-runner', phase: 'Run', schema: RESULTS })
if ((!runner || !Array.isArray(runner.results)) && guidance) {
  runner = await agent(runnerPrompt + guidance, { label: 'qa-runner (guided)', phase: 'Run', schema: RESULTS })
}
if (!runner || !Array.isArray(runner.results)) return { status: 'impasse', stage: 'qa', question: 'The QA runner failed to produce results. Retry, or waive live QA for this run? (Your answer becomes guidance for a retry.)', context: pre }

phase('Verdict')
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    rulings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ac: { type: 'string' },
          ruling: { type: 'string', enum: ['VERIFIED', 'UNCONVINCING', 'WAIVED-OK'] },
          note: { type: 'string' },
        },
        required: ['ac', 'ruling'],
      },
    },
  },
  required: ['rulings'],
}
const reviewPrompt = `You audit QA evidence. Inputs: the acceptance criteria, the verification plan, the runner's claimed results below, and the evidence directory ${evidenceDir} (read it yourself). For each AC, judge whether the recorded evidence actually demonstrates the criterion — not whether the runner says it does. An empty or vague evidence file fails the audit. Rule each: VERIFIED / UNCONVINCING (evidence does not show what is claimed) / WAIVED-OK (a declared BLOCKED with a credible named post-merge or local step). ${qaContext}\nRunner results:\n${JSON.stringify(runner.results, null, 2)}`
let review = await agent(reviewPrompt, { label: 'qa-verdict-reviewer', phase: 'Verdict', schema: REVIEW_SCHEMA })
if ((!review || !Array.isArray(review.rulings)) && guidance) {
  review = await agent(reviewPrompt + guidance, { label: 'qa-verdict-reviewer (guided)', phase: 'Verdict', schema: REVIEW_SCHEMA })
}
if (!review || !Array.isArray(review.rulings)) return { status: 'impasse', stage: 'qa', question: 'The QA verdict reviewer failed to produce rulings. How should we proceed? (Your answer becomes guidance for a retry — the audit cannot be skipped.)', context: { results: runner.results } }

// Merge runner results + reviewer rulings into the manifest vocabulary: verified | waived | failed
const manifest = []
const failures = []
for (const ac of input.acs) {
  const r = runner.results.find((x) => x.ac === ac.id) || { status: 'BLOCKED', evidence: 'runner returned no result for this AC' }
  const ruling = (review.rulings.find((x) => x.ac === ac.id) || {}).ruling || 'UNCONVINCING'
  let status
  if (r.status === 'VERIFIED' && ruling === 'VERIFIED') status = 'verified'
  else if (r.status === 'BLOCKED' && ruling === 'WAIVED-OK') status = 'waived'
  else status = 'failed'
  const row = { ac: ac.id, text: ac.text, method: ac.method, status, evidence: r.evidence, note: (review.rulings.find((x) => x.ac === ac.id) || {}).note }
  manifest.push(row)
  if (status === 'failed') failures.push({ ac: ac.id, problem: row.note || r.evidence, scenario: r.repro || 'see evidence' })
}
log(`QA: ${manifest.filter((m) => m.status === 'verified').length} verified, ${manifest.filter((m) => m.status === 'waived').length} waived, ${failures.length} failed`)
return { status: 'ok', manifest, failures, liveAvailable }
