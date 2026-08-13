import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class MobileInspectionPresentationTests: XCTestCase {
    func testAllAndChangedFiltersKeepDirectoryContextAndSortPaths() throws {
        let snapshot = try decodeSnapshot()

        let all = FileBrowserModel.groups(
            in: snapshot,
            filter: .all,
            query: ""
        )
        XCTAssertEqual(all.map(\.directory), ["", "Sources", "Tests"])
        XCTAssertEqual(all.flatMap(\.files).map(\.path), [
            "README.md",
            "Sources/App.swift",
            "Sources/Deleted.swift",
            "Tests/AppTests.swift",
        ])

        let changed = FileBrowserModel.groups(
            in: snapshot,
            filter: .changed,
            query: ""
        )
        XCTAssertEqual(changed.flatMap(\.files).map(\.path), [
            "Sources/App.swift",
            "Sources/Deleted.swift",
        ])
    }

    func testSearchMatchesTheFullProjectRelativePath() throws {
        let groups = FileBrowserModel.groups(
            in: try decodeSnapshot(),
            filter: .all,
            query: "apptests"
        )

        XCTAssertEqual(groups.map(\.directory), ["Tests"])
        XCTAssertEqual(groups.flatMap(\.files).map(\.path), ["Tests/AppTests.swift"])
    }

    func testDeletedFilesOpenDiffWhileExistingFilesOpenPreview() throws {
        let snapshot = try decodeSnapshot()
        let files = snapshot.files

        XCTAssertEqual(
            FileInspectionDestination.forFile(files.first { $0.path == "Sources/Deleted.swift" }!),
            .diff
        )
        XCTAssertEqual(
            FileInspectionDestination.forFile(files.first { $0.path == "Sources/App.swift" }!),
            .preview
        )
    }

    func testDiffLinesExposeNonColorSemanticsAndKeepHeadersAsContext() {
        let lines = DiffLine.rows(from: """
        diff --git a/App.swift b/App.swift
        --- a/App.swift
        +++ b/App.swift
        @@ -1 +1 @@
        -old
        +new
         same
        """)

        XCTAssertEqual(lines.map(\.kind), [
            .context, .context, .context, .hunk, .deletion, .addition, .context,
        ])
        XCTAssertEqual(lines[4].accessibilityLabel, "Deleted: old")
        XCTAssertEqual(lines[5].accessibilityLabel, "Added: new")
        XCTAssertEqual(lines[6].accessibilityLabel, "Context: same")
        XCTAssertEqual(lines[3].displayText, " -1 +1 @@")
        XCTAssertEqual(lines[4].displayText, "old")
        XCTAssertEqual(lines[5].displayText, "new")
        XCTAssertEqual(lines[6].displayText, " same")
    }

    private func decodeSnapshot() throws -> BrowserSnapshot {
        try JSONDecoder().decode(BrowserSnapshot.self, from: Data("""
        {
          "rootPath": "/repo",
          "files": [
            {"path":"Tests/AppTests.swift","name":"AppTests.swift","parentPath":"Tests","exists":true,"changed":false,"statusCode":"","statusLabel":""},
            {"path":"Sources/Deleted.swift","name":"Deleted.swift","parentPath":"Sources","exists":false,"changed":true,"statusCode":" D","statusLabel":"D"},
            {"path":"README.md","name":"README.md","parentPath":null,"exists":true,"changed":false,"statusCode":"","statusLabel":""},
            {"path":"Sources/App.swift","name":"App.swift","parentPath":"Sources","exists":true,"changed":true,"statusCode":" M","statusLabel":"M"}
          ]
        }
        """.utf8))
    }
}
