import PsycheCore
import SwiftUI

enum FileBrowserFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case changed = "Changed"

    var id: Self { self }
}

struct FileBrowserGroup: Identifiable, Equatable {
    let directory: String
    let files: [BrowserFile]

    var id: String { directory }
}

enum FileBrowserModel {
    static func groups(
        in snapshot: BrowserSnapshot,
        filter: FileBrowserFilter,
        query: String
    ) -> [FileBrowserGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let visibleFiles = snapshot.files.filter { file in
            let passesFilter = filter == .all || file.changed
            let passesSearch = needle.isEmpty
                || file.path.localizedCaseInsensitiveContains(needle)
            return passesFilter && passesSearch
        }

        return Dictionary(grouping: visibleFiles) { $0.parentPath ?? "" }
            .map { directory, files in
                FileBrowserGroup(
                    directory: directory,
                    files: files.sorted {
                        $0.path.localizedStandardCompare($1.path) == .orderedAscending
                    }
                )
            }
            .sorted {
                if $0.directory.isEmpty { return true }
                if $1.directory.isEmpty { return false }
                return $0.directory.localizedStandardCompare($1.directory) == .orderedAscending
            }
    }
}

enum FileInspectionDestination: Equatable {
    case preview
    case diff

    static func forFile(_ file: BrowserFile) -> Self {
        file.exists ? .preview : .diff
    }
}

struct FileBrowserView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss

    let paneID: String

    @State private var snapshot: BrowserSnapshot?
    @State private var filter = FileBrowserFilter.all
    @State private var query = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if store.isStale {
                unavailable(
                    "Workspace out of date",
                    systemImage: "wifi.exclamationmark",
                    description: "Reconnect and refresh the workspace before inspecting files."
                )
            } else if isLoading, snapshot == nil {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage, snapshot == nil {
                unavailable(
                    "Couldn't load files",
                    systemImage: "exclamationmark.triangle",
                    description: errorMessage,
                    retry: load
                )
                .accessibilityIdentifier("file-browser-error")
            } else if let snapshot {
                fileList(snapshot)
            } else {
                unavailable(
                    "No files",
                    systemImage: "doc",
                    description: "The host did not publish any files for this pane."
                )
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search paths")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Close") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Picker("File filter", selection: $filter) {
                    ForEach(FileBrowserFilter.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }
                .pickerStyle(.menu)
            }
        }
        .task(id: store.isStale) {
            guard !store.isStale else {
                isLoading = false
                return
            }
            await load()
        }
        .accessibilityIdentifier("file-browser")
    }

    private func fileList(_ snapshot: BrowserSnapshot) -> some View {
        let groups = FileBrowserModel.groups(in: snapshot, filter: filter, query: query)
        return Group {
            if groups.isEmpty {
                unavailable(
                    query.isEmpty ? "No \(filter.rawValue.lowercased()) files" : "No matches",
                    systemImage: "doc.text.magnifyingglass",
                    description: query.isEmpty
                        ? "There are no files in this view."
                        : "No project-relative paths match “\(query)”."
                )
            } else {
                List {
                    if let errorMessage {
                        Section {
                            Label(errorMessage, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(PsycheTheme.amber)
                        }
                    }
                    ForEach(groups) { group in
                        if group.directory.isEmpty {
                            Section("Project root") {
                                fileRows(group.files)
                            }
                        } else {
                            Section {
                                DisclosureGroup {
                                    fileRows(group.files)
                                } label: {
                                    Label(group.directory, systemImage: "folder")
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await load() }
            }
        }
    }

    @ViewBuilder
    private func fileRows(_ files: [BrowserFile]) -> some View {
        ForEach(files) { file in
            NavigationLink {
                switch FileInspectionDestination.forFile(file) {
                case .preview:
                    FilePreviewView(paneID: paneID, file: file)
                case .diff:
                    DiffView(paneID: paneID, file: file)
                }
            } label: {
                FileBrowserRow(file: file)
            }
        }
    }

    private func unavailable(
        _ title: String,
        systemImage: String,
        description: String,
        retry: (() async -> Void)? = nil
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            if let retry {
                Button("Try Again") { Task { await retry() } }
            }
        }
    }

    private func load() async {
        guard !store.isStale, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            snapshot = try await store.listFiles(inPane: paneID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct FileBrowserRow: View {
    let file: BrowserFile

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: file.exists ? "doc.text" : "trash")
                .foregroundStyle(file.exists ? PsycheTheme.terminalText : PsycheTheme.amber)
            Text(file.name)
                .lineLimit(1)
            Spacer(minLength: 8)
            if file.changed {
                Text(file.statusLabel.isEmpty ? "Changed" : file.statusLabel)
                    .font(.caption.monospaced())
                    .foregroundStyle(file.exists ? PsycheTheme.mint : PsycheTheme.amber)
                    .accessibilityLabel(file.exists ? "Changed" : "Deleted")
            }
        }
        .frame(minHeight: PsycheTheme.minimumTapTarget)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("file-\(file.path)")
    }

    private var accessibilityLabel: String {
        if !file.exists { return "\(file.name), deleted" }
        if file.changed { return "\(file.name), changed" }
        return file.name
    }
}

private struct FilePreviewView: View {
    @EnvironmentObject private var store: WorkspaceStore

    let paneID: String
    let file: BrowserFile

    @State private var content: String?
    @State private var isTruncated = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if store.isStale {
                ContentUnavailableView(
                    "Workspace out of date",
                    systemImage: "wifi.exclamationmark",
                    description: Text("Reconnect before reading this file.")
                )
            } else if isLoading, content == nil {
                ProgressView("Loading file…")
            } else if let errorMessage, content == nil {
                ContentUnavailableView(
                    "Couldn't read file",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if let content {
                VStack(spacing: 0) {
                    if isTruncated {
                        Label("Preview truncated to the safe size limit", systemImage: "scissors")
                            .font(.footnote)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            .padding(.vertical, 8)
                            .background(PsycheTheme.key)
                            .accessibilityIdentifier("file-preview-truncated")
                    }
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(content.components(separatedBy: .newlines).enumerated()), id: \.offset) { index, line in
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text("\(index + 1)")
                                        .foregroundStyle(.secondary)
                                        .frame(minWidth: 32, alignment: .trailing)
                                        .accessibilityHidden(true)
                                    Text(line.isEmpty ? " " : line)
                                        .foregroundStyle(PsycheTheme.terminalText)
                                }
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .accessibilityLabel("Line \(index + 1): \(line)")
                            }
                        }
                        .padding()
                    }
                }
                .background(PsycheTheme.terminal)
            } else {
                ProgressView("Loading file…")
            }
        }
        .navigationTitle(file.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if file.changed {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink("View Changes") {
                        DiffView(paneID: paneID, file: file)
                    }
                }
            }
        }
        .task(id: store.isStale) {
            guard !store.isStale else {
                isLoading = false
                return
            }
            await load()
        }
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let preview = try await store.readFile(file.path, inPane: paneID)
            content = preview.content
            isTruncated = preview.truncated
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
