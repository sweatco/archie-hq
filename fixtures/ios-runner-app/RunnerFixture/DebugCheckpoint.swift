import Foundation

let runnerFixtureNonce = "ARCHIE_FULL_CYCLE_NONCE"

@_cdecl("archie_debug_checkpoint")
public func archieDebugCheckpoint() {
  let nonce = runnerFixtureNonce
  NSLog("Runner fixture checkpoint: %@", nonce)
  withExtendedLifetime(nonce) {}
}
