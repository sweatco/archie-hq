<!--
Nothing here is mandatory — it's a starting point. Delete any section that
doesn't apply. Keep PRs focused: one logical change per PR (see CONTRIBUTING.md).
Tick only what you actually ran; note anything you couldn't (e.g. no API key).
-->

## What & why

<!-- What changed and the motivation. Link issues with "Closes #123" if relevant. -->

## Checklist

- [ ] `npm run typecheck`, `npm run build`, and `npm test` pass
- [ ] **Smoke test:** app boots (`npm run example:setup` then `npm run dev`) and a CLI request round-trips through the PM to an agent and back
- [ ] Exercised the path this change touches (Slack / edit mode / sandbox / plugins / memory), or noted why not
- [ ] New source files carry the SPDX header (`// SPDX-License-Identifier: AGPL-3.0-or-later`)
- [ ] Docs updated if behavior or setup changed
