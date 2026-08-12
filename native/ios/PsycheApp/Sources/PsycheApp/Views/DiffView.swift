import PsycheCore
import SwiftUI

enum DiffLineKind: Equatable {
    case addition
    case deletion
    case hunk
    case context
}

struct DiffLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let kind: DiffLineKind

    var accessibilityLabel: String {
        let content: String
        switch kind {
        case .addition, .deletion:
            content = String(text.dropFirst())
        case .context:
            content = text.hasPrefix(" ") ? String(text.dropFirst()) : text
        case .hunk:
            content = text
        }

        switch kind {
        case .addition: return "Added: \(content)"
        case .deletion: return "Deleted: \(content)"
        case .hunk: return "Change range: \(content)"
        case .context: return "Context: \(content)"
        }
    }

    static func rows(from diff: String) -> [DiffLine] {
        diff.components(separatedBy: .newlines).enumerated().map { index, text in
            DiffLine(id: index, text: text, kind: kind(for: text))
        }
    }

    private static func kind(for text: String) -> DiffLineKind {
        if text.hasPrefix("@@") { return .hunk }
        if text.hasPrefix("+") && !text.hasPrefix("+++") { return .addition }
        if text.hasPrefix("-") && !text.hasPrefix("---") { return .deletion }
        return .context
    }
}

struct DiffView: View {
    @EnvironmentObject private var store: WorkspaceStore

    let paneID: String
    let file: BrowserFile

    @State private var diff: String?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if store.isStale {
                ContentUnavailableView(
                    "Workspace out of date",
                    systemImage: "wifi.exclamationmark",
                    description: Text("Reconnect before loading changes.")
                )
            } else if isLoading, diff == nil {
                ProgressView("Loading changes…")
            } else if let errorMessage, diff == nil {
                ContentUnavailableView(
                    "Couldn't load changes",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if let diff, diff.isEmpty {
                ContentUnavailableView(
                    "No changes",
                    systemImage: "checkmark.circle",
                    description: Text("The host reported no diff for this file.")
                )
            } else if let diff {
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(DiffLine.rows(from: diff)) { line in
                            DiffLineRow(line: line)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .background(PsycheTheme.terminal)
            }
        }
        .navigationTitle(file.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.isStale) {
            guard !store.isStale else {
                isLoading = false
                return
            }
            await load()
        }
        .accessibilityIdentifier("file-diff")
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            diff = try await store.diffFile(file.path, inPane: paneID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct DiffLineRow: View {
    let line: DiffLine

    var body: some View {
        HStack(spacing: 0) {
            Text(prefix)
                .foregroundStyle(foreground)
                .frame(width: 28, alignment: .center)
                .accessibilityHidden(true)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(foreground)
                .padding(.trailing, 12)
        }
        .font(.system(.footnote, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .textSelection(.enabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityLabel)
    }

    private var prefix: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        case .hunk: "@@"
        case .context: "·"
        }
    }

    private var foreground: Color {
        switch line.kind {
        case .addition: PsycheTheme.mint
        case .deletion: PsycheTheme.amber
        case .hunk: .cyan
        case .context: PsycheTheme.terminalText
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: PsycheTheme.mint.opacity(0.09)
        case .deletion: PsycheTheme.amber.opacity(0.09)
        case .hunk: Color.cyan.opacity(0.08)
        case .context: .clear
        }
    }
}
