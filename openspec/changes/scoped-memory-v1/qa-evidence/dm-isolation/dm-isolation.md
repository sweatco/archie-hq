# E2E evidence — dm-isolation

- **Result:** PASS
- **ACs covered:** internal-dm-task-completes, dm-partner-changes-or-becomes-external
- **Terminal state:** `completed`
- **Started:** 2026-08-31T03:25:26Z · **Finished:** 2026-08-31T03:29:56Z
- **Environment:** http://localhost:3457 · branch `detached-main` · commit `a528a9be4f9ad631cf8dad5f788574010cb34df5-dirty`
- **Nonce:** `SMV1-DM-SECRET-484JMU` · **Task:** `task-20260831-0329-337631`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| real-dm-classification | Slack's real sparse DM response classifies by its live internal partner. | scope user/U03RQQTE1EF. | Initial live run exposed rejection of sparse is_im/user responses; after the narrow fix and regression test, retry task-20260831-0327-tezt3z persisted user/U03RQQTE1EF. | PASS |
| exact-user-write | The DM seed writes only its exact user vault. | users/U03RQQTE1EF/private.md contains the kiwi outcome; public corpus does not. | Only users/U03RQQTE1EF/private.md contains the exact nonce and kiwi. | PASS |
| same-dm-recall | A second task in the same DM can read the outcome. | Authorized user-local read returns kiwi. | task-20260831-0328-w7db8l replied Kiwi and recorded exposure scope user/U03RQQTE1EF. | PASS |
| public-denial | A public task cannot search or read the DM outcome. | No authorized result and no public leak. | task-20260831-0329-337631 replied No authorized memory result; recursive public search had no exact DM nonce or kiwi hit after extraction. | PASS |

## Excerpts

### Knowledge log

```
[2026-08-31T03:27:36.783Z] Got it — SMV1-DM-SECRET-484JMU → kiwi. Noted for this DM.
[2026-08-31T03:28:32.285Z] Kiwi — DM memory was used.
[2026-08-31T03:29:50.049Z] No authorized memory result.
```

### Events

```json
{"type":"live_defect_fixed","defect":"Sparse conversations.info DM response was rejected before user authorization","tests":["client sparse DM fixture","132 focused tests","typecheck"]}
{"type":"hookdeck","seed_request":"req_UYJuZEt2wKCVQCJgeUIV","recall_request":"req_QZ1nsxk7wzdNnZ6JmPqa","public_denial_request":"req_7JoH8NHpETS3HYIRGA42"}
{"type":"scoped_store","files":["users/U03RQQTE1EF/private.md"],"prohibited_public_hits":[]}
```

## Verdict

**PASS** — 4/4 assertions passed.
