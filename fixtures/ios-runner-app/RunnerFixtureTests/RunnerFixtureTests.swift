import XCTest
@testable import RunnerFixture

final class RunnerFixtureTests: XCTestCase {
  func testDebugNonceContract() {
    XCTAssertEqual(runnerFixtureNonce, "ARCHIE_FULL_CYCLE_NONCE")
    archieDebugCheckpoint()
  }
}
