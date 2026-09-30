#!/bin/bash
set -euo pipefail
export PATH="$HOME/.rbenv/shims:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CI=1 LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 COCOAPODS_DISABLE_STATS=true RCT_NO_LAUNCH_PACKAGER=1 BUNDLE_VERSION=system
result=.archie-e2e
mkdir -p "$result/results"

case "${1:?Expected a build or simulator phase}" in
  prepare|prepare-ui)
    test "$(xcodebuild -version | head -1)" = "Xcode $(cat ios/.xcode-version)"
    { xcodebuild -version; ruby --version; node --version; tuist version; } | tee "$result/results/toolchain.txt"
    git init -q
    if test "$1" = prepare; then bundle install; fi
    SKIP_COCOAPODS=1 yarn install --immutable
    if test "$1" = prepare; then bash ios/scripts/install_pods.sh; fi
    ;;
  build)
    xcodebuild build -workspace ios/swc.xcworkspace -scheme swc -configuration Internal \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath "$result/DerivedData" \
      -resultBundlePath "$result/results/build.xcresult" -quiet -jobs 4 \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
      FORCE_BUNDLING=true EXPO_UPDATES_ENABLED=NO \
      > "$result/results/build.log" 2>&1 || { tail -80 "$result/results/build.log"; exit 1; }
    xcrun xcresulttool get build-results summary --path "$result/results/build.xcresult" --format json \
      > "$result/results/build-summary.json"
    python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["status"] == "succeeded" and s["errorCount"] == 0, s' "$result/results/build-summary.json"
    app="$result/DerivedData/Build/Products/Internal-iphonesimulator/swc.app"
    test -s "$app/swc"
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist" > "$result/results/bundle-id.txt"
    ditto -c -k --keepParent "$app" "$result/results/swc.app.zip"
    ;;
  restore-app)
    mkdir -p "$result/DerivedData/Build/Products/Internal-iphonesimulator"
    ditto -x -k .archie-prebuilt-app "$result/DerivedData/Build/Products/Internal-iphonesimulator"
    cp .archie-prebuilt-app "$result/results/swc.app.zip"
    cp .archie-prebuilt-summary "$result/results/build-summary.json"
    ;;
  simulator)
    runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["isAvailable"] and x["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]; print(max(r, key=lambda x: tuple(map(int,x["version"].split("."))))["identifier"])')
    udid=$(xcrun simctl create ArchieSweatcoinE2E com.apple.CoreSimulator.SimDeviceType.iPhone-17 "$runtime")
    printf '%s\n' "$udid" > "$result/udid"
    DO_NOT_TRACK=1 node node_modules/@swmansion/argent/dist/cli.js run boot-device --udid "$udid" --json \
      | tee "$result/results/argent-boot.json"
    python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r.get("booted") is True, r' "$result/results/argent-boot.json"
    open -a "$(xcode-select -p)/Applications/Simulator.app" --args -CurrentDeviceUDID "$udid"
    app="$result/DerivedData/Build/Products/Internal-iphonesimulator/swc.app"
    xcrun simctl install "$udid" "$app"
    printf '%s\n' "$runtime" > "$result/results/runtime.txt"
    ;;
  launch)
    DO_NOT_TRACK=1 node node_modules/@swmansion/argent/dist/cli.js run launch-app \
      --udid "$(cat "$result/udid")" --bundleId swc --json | tee "$result/results/argent-launch.json"
    ;;
  record)
    python3 - <<'PY'
import pathlib, signal, subprocess, sys
root = pathlib.Path('.archie-e2e')
recorder = subprocess.Popen(['xcrun', 'simctl', 'io', (root / 'udid').read_text().strip(), 'recordVideo', '--codec=h264', str(root / 'results/scenario.mp4')])
(root / 'recorder.pid').write_text(str(recorder.pid))
try:
    sys.exit(recorder.wait(timeout=300))
except subprocess.TimeoutExpired:
    recorder.send_signal(signal.SIGINT)
    recorder.wait(timeout=30)
    raise RuntimeError('Video exceeded the five-minute scenario limit')
finally:
    if recorder.poll() is None:
        recorder.kill()
        recorder.wait()
PY
    ;;
  stop-recording)
    kill -INT "$(cat "$result/recorder.pid")"
    ;;
  cleanup)
    if test -s "$result/udid"; then
      udid=$(cat "$result/udid")
      xcrun simctl io "$udid" screenshot "$result/results/app.png" || true
      xcrun simctl spawn "$udid" log show --last 10m --style compact --predicate 'process == "swc"' \
        > "$result/results/app.log" 2>&1 || true
      xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
      xcrun simctl delete "$udid"
    fi
    ;;
  *) exit 2 ;;
esac
