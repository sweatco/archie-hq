# Sweatcoin build in a local Tart VM

Run `npm run runner:sweatcoin-e2e -- --repo /absolute/path/to/sweatcoin-mobile` after changes to runner provisioning, execution, persistence, transfers, or this harness. It runs the current Archie source, including uncommitted changes, against a disposable copy of a mobile Git revision. It requires Apple Silicon macOS, Tart, Orchard, Git LFS, a cached image, and GitHub access to the mobile project's private dependencies. No Archie server, Slack connection, signing certificates, or TeamCity credentials are needed.

```bash
npm ci
npm run typecheck
npm test
npm run runner:sweatcoin-e2e -- \
  --repo /absolute/path/to/sweatcoin-mobile \
  --ref HEAD
```

`--ref` defaults to the mobile checkout's HEAD. Dirty files in that checkout are excluded; commit mobile changes locally to test them. Materialize its LFS files with `git lfs pull` first. The harness makes a separate local clone and never changes the source checkout. GitHub authentication comes from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`. It is passed to dependency commands through the runner's private environment bootstrap, with an in-memory Git credential helper; it is never placed in repository URLs.

The image is selected automatically when `tart list --source oci --format json` contains exactly one cached digest. Otherwise pass `--image registry/repository@sha256:...`. Treat the image as a ready build environment: this harness does not install or replace toolchain tools. It needs Xcode matching `ios/.xcode-version`, the project's Ruby, Bundler, Node, Yarn, Tuist, and an available iOS simulator runtime with the iPhone 17 device type. The default guest login is `admin` / `admin`; override its password with `ARCHIE_E2E_GUEST_PASSWORD`. The VM uses 4 CPUs, 8 GiB memory, and a 140 GiB disk. Allow disk space for project dependencies and a full native build in addition to the cached base image.

The local image used during development is `377766724298.dkr.ecr.eu-west-1.amazonaws.com/tart-images@sha256:a489b2cd75b5520ab1332c27a57277d01b35edba0c4786b87e3e85da097d4c95` (tag `macos-26.4_xcode-26.5_base_1787136896`). The digest, source commit, installed tool versions, and file manifests are recorded per run; the tag is only descriptive. If a toolchain incompatibility appears, adjust the base image and rerun with its new digest.

## What runs

1. Start a separate authenticated Orchard controller on a free loopback port and a local worker. Give them a private `ORCHARD_HOME` and Archie workdir.
2. Provision and sync through the production `RunnerManager` and `OrchardRunnerProvider`. Verify every source file's digest, symlink type, and executable bit in the guest before installing dependencies.
3. Start a detached command, recreate the manager from persisted state, retry the same request ID, and poll from the original cursor. Require exactly one execution.
4. Generate and collect 32 MiB of random binary data; require its SHA-256 to match. This catches transfer failures before the expensive build.
5. Install project dependencies with the image's Bundler and immutable Yarn, then run `ios/scripts/install_pods.sh`.
6. Build the `swc` scheme's `Internal` configuration for the arm64 iOS simulator. Require `xcodebuild` success, a successful `.xcresult` summary, and an app executable.
7. Create a simulator, boot it with the repository's Argent CLI and normal Simulator window to configure accessibility, and install the app. Open Simulator.app from the selected Xcode explicitly because Argent can silently ignore a failed GUI launch. Use Argent MCP through the runner MCP client to discover devices and run the login/recovery scenario twice. Every assertion must pass. Boot and the initial app launch use the repository CLI to avoid the pinned MCP adapter's retry loop on slow startup requests. The setup launches the app once and requires welcome before recording, with up to three two-minute observations at a two-second polling interval. Each recorded pass then restarts it and uses the normal 60-second screen assertions.
8. Record both passes with Xcode's H.264 simulator recorder, bounded to five minutes. Finalize the MP4 before deleting the simulator, collect it through the production transfer path, and decode every frame on the host.
9. Release the lease, verify the Tart VM disappeared, and stop the test's controller and worker. Cleanup failure makes the run fail.

`--transfer-only` runs through the large binary transfer, then collects the source manifest and cleans up. It reports a separate `sweatcoin-tart-transfer` scenario; a pass does not claim the app was built.

For UI-only changes, use `--reuse-build /absolute/path/to/a/previous/report.json`. The prior run must contain `swc.app.zip` and a successful build summary for the selected mobile commit; its UI result may have failed. This mode installs the repository’s JavaScript dependencies, restores that app in a fresh VM, and runs the same simulator setup, UI, recording, collection, and deletion checks. It reports `sweatcoin-tart-ui-replay`, the parent report, and the archive SHA-256. It does not claim a new native compilation.

Setup installs a fresh app with no account and requires its initial welcome screen. The initial wait has a separate startup budget because fresh simulator startup can be slow; repeated observations never relaunch the app. Each recorded pass then restarts that app and checks readiness. It exercises navigation without submitting a phone number, sending an SMS, or signing in. It does not exercise signed device builds, release distribution, logged-in flows, XCTest, LLDB, or production Softnet policy. The generic `runner:ios-full-cycle-e2e` fixture covers the separate XCTest and debugger scenario. This local lab uses NAT and authenticated HTTP on loopback; production runner configuration continues to require Softnet and HTTPS.

## UI scenario contract

The scenario is the short, explicit sequence in `src/runners/sweatcoin-ui.ts`, included in the Archie file manifest. Each screen must satisfy its identity check and become idle. Before every tap, the test discovers the native control's window bounds, computes a point inside it, and requires the expected destination after the gesture. MCP responses and a screenshot of each destination are retained.

| Action | Expected screen | Executable evidence | State effect |
| --- | --- | --- | --- |
| Launch Sweatcoin | Welcome / sign up | `signUpButton` visible | Prepared app, no account |
| Open login | Login method selection | `signInWithPhoneNumberButton` visible | Navigation only |
| Choose phone login | Phone recovery | `buttonConfirm` visible and native `PhoneInput` exists | No submission |
| Cancel recovery | Welcome / sign up | `signUpButton` visible | Restores the starting screen |

The nested welcome-screen login link has no separate native node. The test uses the same 215-point horizontal offset within `logInButton` as the mobile repository's `e2e/steps/onboarding.ts`, checks its bounds, and requires the login screen afterward. This remains a layout-dependent constraint; exposing the link as a separate native control would remove the offset. The phone input is an intentional 1×1 native field with separately rendered text, so the visible Send SMS control identifies that screen while a native lookup checks the input exists.

Argent comes from the mobile repository's pinned dependency and `.mcp.json`; the harness does not install AXe, Maestro, or a global Argent package. The test uses explicit MCP calls because the flow recorder could not resolve the nested link reliably. Recording uses `simctl` because the cached image lacks `ffmpeg`, which Argent's recording tool requires. The harness adds no audio or touch overlays.

## TeamCity reference

The [Build iOS configuration](https://ci.sweatco.team/buildConfiguration/SweatcoinMobile_BuildIOS) uses the `SweatcoinMobile_BuildSwcInTart` meta-runner: clone a Tart image, then execute `cirrus run build`. The mobile repository's `.cirrus.yml` defines the VM and build steps. [Successful build 325495](https://ci.sweatco.team/buildConfiguration/SweatcoinMobile_BuildIOS/325495) reported Xcode 26.5, Ruby 3.2.2, Node 23.6.0, Yarn 4.12.0, and Tuist 4.109.0.

The local recipe follows the dependency ordering of `.cirrus.yml`'s `maestro_ios_task`, then uses an unsigned simulator build. TeamCity's signing, VPN, upload, reporting, and deployment steps are outside this test. It builds from source with no restored native build cache, so a pass cannot come from TeamCity's IPA reuse path.

## Evidence and cleanup

Each run creates a private, gitignored `e2e-evidence/sweatcoin-*` directory. `--out /absolute/new/directory` selects a different destination and refuses to overwrite an existing directory. Follow the phase logs there while a build runs.

`report.json` contains the result, last command phase, source and Archie identities, transfer counts, restart and binary integrity assertions, both UI pass results, video duration/frame count/SHA-256, artifact paths, and VM deletion result. `archie-manifest.json` identifies the actual working tree bytes, including dirty and untracked source. `source-manifest.json` identifies the synced mobile files and guest driver. Collected artifacts include the build log, `.xcresult`, summary, toolchain versions, MCP responses and screenshots, final screenshot, simulator app log, the built `swc.app.zip`, and `scenario.mp4`. UI failures also retain Argent hierarchy and network diagnostics when available. Failed runs retain available artifacts and host logs too.

Normal completion, command failures, and Ctrl-C trigger cleanup. The source clone and Orchard credentials/state are removed after cleanup; the temporary controller credential is redacted from its startup log. Evidence remains. The cached image and the user's Orchard contexts are preserved, and `TART_NO_AUTO_PRUNE=1` disables cache pruning for the worker. A forced host kill or crash cannot run cleanup: use the exact instance/backend IDs in `report.json` and the local Tart inventory to stop and delete only that run's `orchard-archie-e2e-...` VM. Do not prune the Tart cache or operate on another controller's workdir.

Run serially on a trusted local checkout. This expensive, credentialed test is intentionally opt-in, outside `npm test`; agents should use it when verifying runner changes on a prepared Mac and report a missing prerequisite as skipped, never passed.

## Verified runs

The fresh VM UI replay passed on 2026-09-07 at mobile commit `ec0041c9c478b2bb94a2c9f911fe59109c6c57c6`, using the cached image above. Both unchanged navigation passes succeeded. Its 221.23-second MP4 contains 7,952 decoded frames at 1206×2622; sampled video frames confirmed all four screens in both passes. Source and 32 MiB artifact integrity, manager restart/retry, evidence collection, and physical VM deletion also passed. The report is `e2e-evidence/sweatcoin-mOC7dz/report.json`; `verification.json` records the visual review and verification tiers.

This was a `--reuse-build` run, using the successful native compilation from `e2e-evidence/sweatcoin-6ZHWMU/report.json` with archive SHA-256 `07e8c132a6679d3c8662bbd61b29c36cea019dd879840000154b46d1102c304b`. That earlier run built successfully but failed its 60-second initial UI assertion. The replay reached the first welcome screen after 101 seconds with slower polling, without restarting that initial process or seeding app fixtures. Startup now has a separate bounded wait; recorded navigation retains its 60-second assertions. The underlying startup performance was not diagnosed. This evidence combines a native build and a subsequent fresh VM UI replay, not a new compilation in the passing replay.

The real runs exposed two runner defects: a fast tar download could exhaust Orchard’s replay buffer, and completed exec sessions retained SSH connections. Artifact collection now uses bounded chunks; the provider closes a remote session after its terminal event has been persisted. The early 32 MiB integrity check and repeated collection exercise both fixes.
