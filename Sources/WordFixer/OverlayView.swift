import SwiftUI

enum OverlayState {
    case loading
    case diff(AttributedString, cost: Double?)
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

                case .diff(let attributed, let cost):
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Word Fixer")
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Text(attributed)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("↩ Confirm · Esc Dismiss")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        if let cost {
                            Text("Cost \(formatCost(cost))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)

                case .error(let message):
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
        }
        .frame(width: 500)
    }

    private func formatCost(_ cost: Double) -> String {
        let format = cost < 0.001 ? "%.6f" : "%.4f"
        return String(format: "$" + format, cost)
    }
}
