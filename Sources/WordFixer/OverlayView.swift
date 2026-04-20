import SwiftUI

enum OverlayState {
    case loading
    case diff(AttributedString)
    case error(String)
}

struct OverlayView: View {
    let state: OverlayState

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16)
                .fill(.regularMaterial)

            VStack(alignment: .leading, spacing: 16) {
                switch state {
                case .loading:
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Fixing…")
                            .foregroundStyle(.secondary)
                    }

                case .diff(let attributed):
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Word Fixer")
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Text(attributed)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack {
                        Spacer()
                        Text("↩ Confirm · Esc Dismiss")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }

                case .error(let message):
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
        }
        .frame(width: 500)
    }
}
