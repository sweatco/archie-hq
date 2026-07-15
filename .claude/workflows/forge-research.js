export const meta = {
  name: 'forge-research',
  description: 'Forge v2 research: parallel fact-finding lenses, adversarial fact-check per lens, sizing judgment',
  whenToUse: 'Invoked by the /forge conductor after the clarifying interview, before the brief is drafted.',
  phases: [
    { title: 'Lenses', detail: 'codebase / prior art / constraints / web, in parallel' },
    { title: 'Verify', detail: 'adversarial fact-check of each lens dossier' },
    { title: 'Sizing', detail: 'does this fit one bounded run?' },
  ],
}

// args: { request: string (idea + clarifications, verbatim), externalUnknowns?: string[] }
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!input.request) return { status: 'error', reason: 'missing input.request' }

const CLAIMS = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'One factual claim, stated plainly' },
          citation: { type: 'string', description: 'file:line for code claims, URL for web claims' },
        },
        required: ['claim', 'citation'],
      },
    },
    summary: { type: 'string', description: 'What this lens concluded overall, 2-4 sentences' },
  },
  required: ['claims', 'summary'],
}

const CHECKED = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          citation: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'WRONG', 'UNVERIFIABLE'] },
          correction: { type: 'string', description: 'For WRONG: what is actually there (with citation)' },
        },
        required: ['claim', 'citation', 'verdict'],
      },
    },
  },
  required: ['verdicts'],
}

const CONTRACT = 'Return findings as a list of factual claims, each with a file:line citation (code) or source URL (web). Do not speculate; a claim you cannot cite is not a finding.'

const lenses = [
  {
    key: 'codebase',
    prompt: `You are the codebase mapper for a proposed change to this repository. Read docs/architecture/ first, then the code. The proposed change: <request>${input.request}</request>. Report: which subsystems the change touches, the existing patterns to follow (with file:line), the tests that cover the area today, and the seams the change should use. ${CONTRACT}`,
  },
  {
    key: 'prior-art',
    prompt: `You are the prior-art scanner for a proposed change to this repository. The proposed change: <request>${input.request}</request>. Scan open PRs, recently closed PRs, open issues (GitHub MCP tools via ToolSearch, or gh CLI if available), docs/plans/, docs/proposals/, and openspec/changes/archive/. Goal: nothing in flight collides with or already solves this; name anything the change should build on or supersede. ${CONTRACT}`,
  },
  {
    key: 'constraints',
    prompt: `You are the constraints scanner for a proposed change to this repository. The proposed change: <request>${input.request}</request>. Read docs/architecture/ (especially security.md), the sandbox rules, the edit-mode gate, plugin spec compliance rules, and CLAUDE.md conventions. Return the constraints the design must not violate. ${CONTRACT}`,
  },
]
if (Array.isArray(input.externalUnknowns) && input.externalUnknowns.length > 0) {
  lenses.push({
    key: 'web',
    prompt: `You are the web researcher for a proposed change to this repository. The proposed change: <request>${input.request}</request>. These external facts are load-bearing and must be established from upstream documentation/changelogs, not memory: ${JSON.stringify(input.externalUnknowns)}. Use WebSearch/WebFetch. Every claim cited with a URL. ${CONTRACT}`,
  })
}

phase('Lenses')
const checked = await pipeline(
  lenses,
  (lens) => agent(lens.prompt, { label: `lens:${lens.key}`, phase: 'Lenses', schema: CLAIMS }),
  (found, lens) => {
    if (!found || !found.claims || found.claims.length === 0) return { lens: lens.key, verdicts: [], summary: found ? found.summary : null }
    return agent(
      `You are an adversarial fact-checker with read access to this repo and the web. Below is a research dossier fragment. For EACH claim, try to REFUTE it against the actual code or the cited source — open the file, fetch the URL, look yourself. Verdict per claim: CONFIRMED (you saw it yourself) / WRONG (state what is actually there, with citation) / UNVERIFIABLE (no citation, or the citation does not support the claim). Do not evaluate design direction — facts only. Claims:\n${JSON.stringify(found.claims, null, 2)}`,
      { label: `verify:${lens.key}`, phase: 'Verify', schema: CHECKED }
    ).then((v) => ({ lens: lens.key, summary: found.summary, verdicts: v ? v.verdicts : [] }))
  }
)

const dossier = []
const rejected = []
for (const lensResult of checked.filter(Boolean)) {
  for (const v of lensResult.verdicts || []) {
    if (v.verdict === 'CONFIRMED') dossier.push({ lens: lensResult.lens, claim: v.claim, citation: v.citation })
    else if (v.verdict === 'WRONG' && v.correction) dossier.push({ lens: lensResult.lens, claim: v.correction, citation: v.citation, note: 'correction of a refuted claim' })
    else rejected.push({ lens: lensResult.lens, claim: v.claim, verdict: v.verdict })
  }
}
log(`Dossier: ${dossier.length} confirmed claims kept, ${rejected.length} rejected`)

phase('Sizing')
const SIZING = {
  type: 'object',
  properties: {
    fits: { type: 'boolean', description: 'true if this change fits one bounded Forge run' },
    reasons: { type: 'array', items: { type: 'string' } },
    split: {
      type: 'array',
      description: 'Only when fits=false: ordered iterations, each independently shippable',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rationale: { type: 'string' },
          observableOutcome: { type: 'string', description: 'The behavior a live instance would exhibit after ONLY this iteration merges — must not be "code exists"' },
        },
        required: ['title', 'rationale', 'observableOutcome'],
      },
    },
  },
  required: ['fits', 'reasons'],
}
const sizing = await agent(
  `You judge whether a proposed change fits ONE bounded development run: a single feature branch, a single live-QA boot, roughly a normal-sized PR, review loops capped at 3 rounds. Consider: subsystems touched, migration surface for persisted state, number of independently observable behaviors, cross-repo reach. The request: <request>${input.request}</request>. The fact-checked dossier: ${JSON.stringify(dossier, null, 2)}. If it does NOT fit, propose an ordered split into iterations under one hard rule: every iteration must be independently shippable and independently QA-able against a live instance — its own observable behavior, safe to merge alone. Reject chapter-splits where an early iteration's only outcome is "code exists".`,
  { label: 'sizing-judge', phase: 'Sizing', schema: SIZING }
)

return { status: 'ok', dossier, rejected, sizing: sizing || { fits: true, reasons: ['sizing agent failed; defaulting to fits — conductor should sanity-check'] } }
