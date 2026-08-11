import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class PaneIndicatorTests: XCTestCase {
    func testAttentionWinsOverAnyStatus() {
        XCTAssertEqual(
            PaneIndicator.forStatus("running", needsAttention: true),
            .needsAttention
        )
        XCTAssertEqual(
            PaneIndicator.forStatus("idle", needsAttention: true),
            .needsAttention
        )
    }

    func testAttentionStatusesNeedYouEvenWithoutTheFlag() {
        for status in ["waiting", "failed", "blocked"] {
            XCTAssertEqual(
                PaneIndicator.forStatus(status, needsAttention: false),
                .needsAttention,
                status
            )
        }
    }

    func testRunningStatusesReadAsLive() {
        for status in ["starting", "running", "working", "analyzing"] {
            XCTAssertEqual(
                PaneIndicator.forStatus(status, needsAttention: false),
                .running,
                status
            )
        }
    }

    /// An idle pane must not wear the live accent. Before this, every dot was
    /// mint unless the pane needed attention, so a finished pane looked exactly
    /// like a working one.
    func testQuietStatusesDoNotLookLive() {
        for status in ["idle", "exited", "unknown", "hibernating"] {
            XCTAssertEqual(
                PaneIndicator.forStatus(status, needsAttention: false),
                .quiet,
                status
            )
        }
    }

    func testStatusMatchingIsCaseInsensitive() {
        XCTAssertEqual(PaneIndicator.forStatus("RUNNING", needsAttention: false), .running)
        XCTAssertEqual(PaneIndicator.forStatus("Waiting", needsAttention: false), .needsAttention)
    }

    /// The dot and the Now section have to agree: anything grouped under Needs
    /// You shows the attention colour, anything under Running shows the live
    /// colour, and everything else stays quiet.
    func testIndicatorAgreesWithTheNowSectionForEveryFixturePane() {
        let store = WorkspaceStore()
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        XCTAssertFalse(store.nowSections.isEmpty)

        for section in store.nowSections {
            for item in section.items {
                let indicator = PaneIndicator.forStatus(
                    item.status,
                    needsAttention: item.needsAttention
                )
                switch section.kind {
                case .needsYou: XCTAssertEqual(indicator, .needsAttention, item.paneID)
                case .running: XCTAssertEqual(indicator, .running, item.paneID)
                case .recent: XCTAssertEqual(indicator, .quiet, item.paneID)
                }
            }
        }
    }
}
