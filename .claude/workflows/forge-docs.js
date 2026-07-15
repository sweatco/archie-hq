export const meta = {
  name: 'forge-docs',
  description: 'Forge v2 docs: locate the documentation describing the touched subsystem, update it to match what actually shipped, adversarially verify docs-vs-diff',
  whenToUse: 'Invoked by forge-run after QA passes, before ship — so docs describe verified behavior and merge atomically with the code.',
  phases: [
    { title: 'Update', detail: 'find the right docs/ pages and bring them true' },
    { title: 'Verify', detail: 'fresh reader checks docs against the diff' },
  ],
}

// args: { branch, base, brief, guidance?: string }
// guidance is the operator's answer to a previous impasse; used only in retry prompts so the
// original calls stay cache-stable across resumes.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.branch || !input.base) return { status: 'error', reason: 'missing input.branch/base' }
const guidance = input.guidance ? `\nOperator guidance from a previous impasse: ${input.guidance}` : ''

const UPDATED = {
  type: 'object',
  properties: {
    updated: { type: 'array', items: { type: 'string' }, description: 'Doc paths changed' },
    created: { type: 'array', items: { type: 'string' }, description: 'Doc paths added' },
    none: { type: 'boolean', description: 'true if the change genuinely warrants no doc update (say why in rationale)' },
    rationale: { type: 'string' },
  },
  required: ['updated', 'created', 'none', 'rationale'],
}

const CHECK = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, file: { type: 'string' }, blocking: { type: 'boolean' } },
        required: ['text', 'blocking'],
      },
    },
  },
  required: ['findings'],
}

const diffCmd = `git diff origin/${input.base}...HEAD -- . ':!docs'`

phase('Update')
const updaterPrompt = `You keep this repo's documentation true. On branch ${input.branch} (already checked out), read the code diff (${diffCmd}) and the brief:\n<brief>${input.brief || '(none provided)'}</brief>\nFind which pages under docs/ (docs/architecture/ describes the current system; docs/guides/ the how-tos) cover the touched subsystem — search before writing; prefer updating an existing page over creating one. Update them to describe what actually shipped: behavior, not implementation history. If no doc covers the area and the change is user- or architecture-visible, create a page in the right folder. If the change genuinely warrants no doc update (pure internal refactor with no behavioral surface), say so. Never touch CHANGELOG.md, docs/plans/, or docs/proposals/. Never hard-wrap prose. Commit any changes on ${input.branch}.`
let updated = await agent(updaterPrompt, { label: 'doc-updater', phase: 'Update', schema: UPDATED })
if (!updated && guidance) {
  updated = await agent(updaterPrompt + guidance, { label: 'doc-updater (guided)', phase: 'Update', schema: UPDATED })
}
if (!updated) return { status: 'impasse', stage: 'docs', question: 'The doc-updater agent failed. How should we proceed? (Your answer becomes guidance for a retry.)', context: null }

const verify = (tag) => agent(
  `You verify documentation against reality. On the current branch, read the code diff (${diffCmd}) and the doc changes (git diff origin/${input.base}...HEAD -- docs). The updater claims: ${JSON.stringify(updated)}. Judge: do the updated docs accurately describe the shipped behavior? Findings are: stale claims left standing, behavior the diff introduces that the docs miss, and invented behavior the diff does not support. If the updater claimed no docs were needed, verify that too — a behavioral or architectural change with no doc update is a blocking finding.`,
  { label: `doc-verifier ${tag}`, phase: 'Verify', schema: CHECK }
)
// The fixer may report only the pages it touched — merge its lists into the running totals so
// the shipped docsUpdated never under-reports after a fix round.
const fix = (blocking, extra) => agent(
  `You fix documentation findings on branch ${input.branch}. Address every finding below against the actual code diff (${diffCmd}), commit the fixes. Never hard-wrap prose; never touch CHANGELOG.md.${extra || ''} Findings:\n${JSON.stringify(blocking, null, 2)}`,
  { label: `doc-fixer${extra ? ' (guided)' : ''}`, phase: 'Update', schema: UPDATED }
).then((revised) => revised ? { ...revised, updated: [...new Set([...(updated.updated || []), ...(revised.updated || [])])], created: [...new Set([...(updated.created || []), ...(revised.created || [])])] } : null)

let blocking = []
let verifierFailed = false
let round = 0
while (round < 2) {
  round++
  phase('Verify')
  const check = await verify(`r${round}`)
  verifierFailed = !check
  blocking = check && check.findings ? check.findings.filter((f) => f.blocking) : []
  if (check && blocking.length === 0) return { status: 'ok', updated, rounds: round }
  if (round === 2) break
  if (verifierFailed) {
    log('Doc verifier returned no verdict — retrying the verification, not the docs')
    continue
  }
  log(`Docs round ${round}: ${blocking.length} blocking finding(s) — revising`)
  const revised = await fix(blocking)
  if (revised) updated = revised
}

// Cap hit — one operator-guided fix + re-verify (prompts the capped rounds never used).
if (guidance) {
  log('Docs cap hit — running one operator-guided round')
  if (blocking.length > 0) {
    const revised = await fix(blocking, guidance + " The operator's word overrides a verifier finding where they conflict.")
    if (revised) updated = revised
  }
  const check = await verify('guided')
  verifierFailed = !check
  blocking = check && check.findings ? check.findings.filter((f) => f.blocking) : []
  if (check && blocking.length === 0) return { status: 'ok', updated, rounds: 3, guided: true }
}
return { status: 'impasse', stage: 'docs', question: verifierFailed ? 'The doc verifier repeatedly failed to return a verdict. How should we proceed? (Your answer becomes guidance for one more round.)' : `Doc verifier still has ${blocking.length} blocking finding(s) after ${guidance ? 'a guided round' : '2 rounds'}. How should we proceed? (Your answer becomes guidance for one more round.)`, context: { blocking, verifierFailed } }
