# Scoped memory v1 verification

## Final verification result

The scenario records below preserve the full isolated Docker and Slack/Hookdeck matrix. A final post-review regression run then re-exercised the changed security boundaries on the final working tree: public summary recall, memory-exposed egress denial, private-channel same-scope recall and public denial, DM same-user recall and public denial, plugin-hook omission, baseline sandbox egress, and clean teardown. Historical scenario files were not rewritten; the final run is recorded separately under `final-post-review-regression/`.

## Environment

- Commit under test: `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- Team: `T03PDDDEK`
- Bot user: `U0AT3BYG99C`
- Internal test user: `U03RQQTE1EF`
- Public fixture: `C0BL50N2600` (`#archie-test-channel`)
- Private fixture: `C0BM7QRSVS4`
- DM fixture: `D0AUZLR6ZJQ`
- Isolated store: a temporary host directory mounted directly at `/workdir/memory`

## Scenario matrix

| Scenario | Coverage | Result |
| --- | --- | --- |
| Tools-off scheduled public trigger | Live Hookdeck, Slack, scheduler, Docker, scoped extraction | Pass |
| Public extraction and recall | Live Hookdeck, Slack, Docker, memory MCP | Pass |
| Private-channel isolation and same-channel recall | Live Hookdeck, Slack, Docker, memory MCP | Pass |
| Internal DM isolation and same-DM recall | Live Hookdeck, Slack, Docker, memory MCP | Pass |
| Mixed private/public audience collapse | Live private seed and public Slack root through `Task.append` | Pass |
| Outsider-visible audience | Slack client integration seam; no safe live fixture existed | Pass |
| Lookup-failure continuity | Slack client, scheduler, and memory-tool integration seams | Pass |
| Private-to-public transition | Live private seed plus classifier transition seam | Pass |
| Final post-review regression | Live Hookdeck, Slack, Docker, memory MCP, plugin-hook isolation, memory egress | Pass |

The scenario directories contain the validated JSON record and its generated Markdown rendering.

## Defects found live

1. Marker initialization attempted an atomic rename across Docker mount boundaries. Temporary marker creation now occurs inside the mounted memory directory.
2. Slack returned a sparse DM `conversations.info` response containing only `id`, `user`, and `is_im`. DM classification now authorizes that exact response using the live partner lookup while retaining strict provenance checks for non-DM conversations.

Both defects have regression tests.

## Automated verification

- Final focused regression: 3 files, 53 tests passed
- Full suite: 109 files, 1,699 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npx openspec validate scoped-memory-v1 --strict`: passed
- `git diff --check`: passed
- Fresh hostile review of the final security patch: clean
- Fresh live Slack/Hookdeck and E2E egress regression: passed
- `npm run lint`: unavailable because this repository's lint script references `eslint`, but `eslint` is not declared or installed
- E2E approval-gate fixture: unavailable because the production plugin set has no gatekeeper/write-marker fixture; approval behavior remains covered by the passing integration suite

### Post-rebase and final layout amendment

After rebasing onto `origin/main` at `88fa9d7`, private rolling files were flattened to `private/channels/<id>.md` and `private/users/<id>.md`. Current-base verification passed as follows:

- 109 test files / 1,696 tests passed together with the load-sensitive CLI `TaskList` file excluded.
- The isolated `TaskList` file passed all 7 tests, covering 110 files / 1,703 tests in total.
- Typecheck, build, strict OpenSpec validation, and `git diff --check` passed.
- The prior live records remain unchanged because they accurately record the pre-flattening paths they exercised; the final path-only amendment is covered by path, initialization, outcome, lifecycle, tool, and complete-suite tests.

## Safety and teardown

- The Docker stack was stopped and removed.
- The Hookdeck connection was restored to its original paused state.
- The shared host `workdir/memory` was never mounted into the test container. A nested-mount inspection confirmed the isolated override.
- No file or directory under the shared host memory path had a modification time at or after E2E boot.
- A final attested no-event boot repeated the mount audit with one explicit digest command. `tar -C <shared-memory> -cf - . | shasum -a 256` returned `67b2d3bc35672d117a65172c022d79e1004fd5f6ef9971f097befb1b38263556` before and after, with 784 entries both times.
- Docker inspection showed `/tmp/archie-scoped-memory-audit.RcmiMF/memory -> /workdir/memory`; the isolated store initialized with schema version 1 and team `T03PDDDEK`.
- The audit boot attested `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`, reached healthy with zero active tasks, and ended with `docker compose ps --all` reporting no project containers.
- Both owned isolated E2E temporary roots were moved to Trash after verification.
- The final post-review boot used `/tmp/archie-scoped-memory-final/memory -> /workdir/memory`, attested the same dirty SHA, and initialized schema version 1 for team `T03PDDDEK`.
- The final live regression passed public recall, post-exposure Bash denial, private-channel isolation, DM isolation, and public denial for both private stores. Generated memory-authorized agent settings contained no plugin hooks.
- The final live sandbox probe passed with Claude CLI 2.1.233: the non-allowlisted host was blocked, the allowlisted host was reachable, npm worked, and the Yarn Berry proxy was mapped.
- Final teardown again reported no Compose containers. Hookdeck connection `web_sfs37zDNBLPO` was paused. The shared memory digest remained `67b2d3bc35672d117a65172c022d79e1004fd5f6ef9971f097befb1b38263556`, with 482 files before and after.

## Fixture limits

- There was no safe bot-visible Slack Connect, restricted-guest, or foreign-member fixture. Those fail-closed paths were exercised through the Slack client integration seam as prescribed by `verification.md`; an ordinary public channel was not used as a substitute.
- A real channel visibility conversion was not performed in the shared workspace. The private-to-public transition used the supported live-classifier seam against the isolated private seed.
- Synthetic Hookdeck ingress used real Slack roots authored by the bot, so it cannot prove human structured-author capture. Host-resolved integration tests cover internal structured authors and forged transcript-marker rejection.
