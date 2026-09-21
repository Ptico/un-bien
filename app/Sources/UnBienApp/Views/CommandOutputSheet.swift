#if canImport(AppKit)
import AppKit
#endif
import SwiftUI

/// Full text of a LONG machine notice (slash-command output — e.g. an
/// `/unbien install` summary with unit paths and step logs). The app-side
/// equivalent of the pi TUI's persistent notify panel: monospace, scrollable,
/// copyable, dismissed explicitly. Never persisted.
struct CommandOutputSheet: View {
    let notice: TransientNotice
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    @State private var copied = false

    private var levelColor: Color {
        switch notice.level {
        case "error": return .red
        case "warning": return .orange
        default: return .accentColor
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(notice.message)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .foregroundStyle(theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .textSelection(.enabled)
            }
            .background(theme.surface)
            .safeAreaInset(edge: .top) {
                HStack(spacing: 6) {
                    Circle().fill(levelColor).frame(width: 8, height: 8)
                    Text(notice.date, style: .time)
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
                .background(theme.surface.opacity(0.6))
            }
            .navigationTitle("Command output")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        #if os(iOS)
                        UIPasteboard.general.string = notice.message
                        #else
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(notice.message, forType: .string)
                        #endif
                        copied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            copied = false
                        }
                    } label: {
                        Label(copied ? "Copied" : "Copy",
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(copied)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 420)
        #endif
    }
}
