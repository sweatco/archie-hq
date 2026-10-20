import XCTest

final class RunnerFixtureUITests: XCTestCase {
  func testLaunchesAndExposesDebugControls() {
    let app = XCUIApplication()
    app.launch()

    let nonce = app.staticTexts["runner.nonce"]
    XCTAssertTrue(nonce.waitForExistence(timeout: 10))
    XCTAssertEqual(nonce.label, "ARCHIE_FULL_CYCLE_NONCE")
    XCTAssertTrue(app.buttons["runner.debug"].exists)
    XCTAssertTrue(app.buttons["runner.crash"].exists)
  }
}
