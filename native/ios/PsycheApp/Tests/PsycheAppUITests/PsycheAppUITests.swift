import XCTest

final class PsycheAppUITests: XCTestCase {
    func testLaunchesMainCockpit() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["native-ios-cloud-terminal"].exists)
    }

    func testPairsHostWithValidSixDigitCode() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["Panes"].waitForExistence(timeout: 5))
        app.buttons["Panes"].tap()
        XCTAssertTrue(app.buttons["Psyche"].waitForExistence(timeout: 5))
        app.buttons["Psyche"].tap()
        XCTAssertTrue(app.buttons["Pair a host"].waitForExistence(timeout: 5))
        app.buttons["Pair a host"].tap()

        let hostField = app.textFields["pair-host-field"]
        let codeField = app.textFields["pair-code-field"]
        XCTAssertTrue(hostField.waitForExistence(timeout: 5))
        codeField.tap()
        codeField.typeText("12345")
        XCTAssertFalse(app.buttons["Pair"].isEnabled)

        codeField.typeText("6")
        XCTAssertFalse(app.buttons["Pair"].isEnabled)
        hostField.tap()
        hostField.typeText("psyche.local")
        XCTAssertTrue(app.buttons["Pair"].isEnabled)
        app.buttons["Pair"].tap()

        XCTAssertTrue(app.staticTexts["Paired with psyche.local"].waitForExistence(timeout: 5))
    }
}
