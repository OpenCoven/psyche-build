import XCTest

final class PsycheAppUITests: XCTestCase {
    func testLaunchesMainCockpit() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["native-ios-cloud-terminal"].exists)
    }
}
