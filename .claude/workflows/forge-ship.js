export const meta = {
  name: 'forge-ship',
  description: 'Forge v2 ship: assemble the house-style PR with the verification manifest, push the branch, open the PR ready for review. Never merges.',
  whenToUse: 'Invoked by forge-run as the final stage. Not normally launched directly.',
  phases: [{ title: 'Ship', detail: 'push branch, open PR with manifest' }],
}

// args: { change, branch, base, brief, planSummary, manifest: [{ac, text, method, status, evidence}],
//         docsUpdated, guidance?: string }
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.branch || !input.base || !Array.isArray(input.manifest)) return { status: 'error', reason: 'missing input.branch/base/manifest' }
const guidance = input.guidance ? `\nOperator guidance from a previous impasse: ${input.guidance}` : ''

phase('Ship')
const shipPrompt = (
  `You open the pull request for a completed, verified change. On branch ${input.branch} (already checked out):
1. Push: git push -u origin ${input.branch} (on network failure retry up to 4 times with exponential backoff: 2s, 4s, 8s, 16s).
2. Check the repo for a PR template (.github/pull_request_template.md and variants); if one exists, mirror its section headings. Otherwise use the house style: "What & why" / "How it works" / "Verification".
3. The Verification section IS the manifest below, rendered as a table: AC id, criterion, method, status (verified/waived), evidence (test case name, evidence excerpt, or the named post-merge step for waivers). Candor over polish: a waiver stated plainly beats an implied pass. Do not omit or soften any row.
4. Open the PR against ${input.base} as ready for review (not draft), using the GitHub MCP tools (load via ToolSearch) or the gh CLI, whichever is available. NEVER merge it and never enable auto-merge — the merge decision is human.
If an open PR already exists for this branch, update its body instead of opening a duplicate.

The brief (source for What & why):
<brief>${input.brief || ''}</brief>
Plan summary (source for How it works): ${input.planSummary || ''}
Docs updated in this PR: ${JSON.stringify(input.docsUpdated || [])}
The verification manifest:
${JSON.stringify(input.manifest, null, 2)}`)

const SHIP = {
  type: 'object',
  properties: {
    prNumber: { type: 'number' },
    url: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['prNumber', 'url'],
}

let shipped = await agent(shipPrompt, { label: 'ship', phase: 'Ship', schema: SHIP })
if (!shipped && guidance) {
  shipped = await agent(shipPrompt + guidance, { label: 'ship (guided)', phase: 'Ship', schema: SHIP })
}
if (!shipped) return { status: 'impasse', stage: 'ship', question: 'The ship agent failed to push or open the PR. Check push permissions / PR tooling? (Your answer becomes guidance for a retry.)', context: null }
return { status: 'ok', pr: shipped }
