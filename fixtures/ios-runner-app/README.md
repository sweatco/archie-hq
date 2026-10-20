# iOS Runner Fixture

This dependency-free app is the deterministic source input for Archie's full-cycle Tart runner canary. It requires only Xcode and an iOS Simulator runtime. Signing is disabled because the target is Simulator-only.

The shared `RunnerFixture` scheme proves:

- Swift source compilation and app linking.
- One unit test and one UI accessibility test.
- Simulator installation, launch, and screenshot capture.
- A repeatable `archieDebugCheckpoint` LLDB breakpoint with the local `nonce` value.
- A deliberate `ARCHIE_FULL_CYCLE_CRASH` fatal error and crash report.

The generated Xcode project is committed so the runner image does not need XcodeGen. After changing `project.yml`, regenerate it with:

```bash
xcodegen generate --spec fixtures/ios-runner-app/project.yml
```

The local smoke command is:

```bash
xcodebuild \
  -project fixtures/ios-runner-app/RunnerFixture.xcodeproj \
  -scheme RunnerFixture \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath /tmp/archie-runner-fixture-derived-data \
  -resultBundlePath /tmp/archie-runner-fixture.xcresult \
  test CODE_SIGNING_ALLOWED=NO
```

Use `npm run runner:ios-full-cycle-e2e` for the destructive Archie-managed Tart/Orchard run. Its configuration is documented in [runner architecture](../../docs/architecture/runners.md).
