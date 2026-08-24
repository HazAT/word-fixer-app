import SwiftUI

struct CorrectionOption {
    let title: String
    let diff: AttributedString
}

enum OverlayState {
    case loading
    case review(options: [CorrectionOption], selectedIndex: Int, feedback: String, cost: Double?)
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
                        Text("Reviewing three ways…")
                            .foregroundStyle(.secondary)
                    }

                case .review(let options, let selectedIndex, let feedback, let cost):
                    HStack {
                        Text("Word Fixer")
                            .font(.headline)
                        Spacer()
                        Text("TAB TO SWITCH")
                            .font(.caption2.weight(.semibold))
                            .tracking(0.6)
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                            correctionCard(option, isSelected: index == selectedIndex)
                        }
                    }

                    feedbackCard(feedback)

                    VStack(alignment: .trailing, spacing: 2) {
                        Text("⇥ Switch · ↩ Paste selected · Esc Dismiss")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        if let cost {
                            Text("Total cost \(formatCost(cost))")
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
        .frame(width: 580)
    }

    private func correctionCard(_ option: CorrectionOption, isSelected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                Text(option.title)
                    .font(.subheadline.weight(.semibold))
                if isSelected {
                    Text("PASTE")
                        .font(.caption2.weight(.bold))
                        .tracking(0.5)
                        .foregroundStyle(Color.accentColor)
                }
            }
            Text(option.diff)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isSelected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isSelected ? Color.accentColor.opacity(0.8) : Color.primary.opacity(0.08), lineWidth: isSelected ? 1.5 : 1)
        )
    }

    private func feedbackCard(_ feedback: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Does this make sense?", systemImage: "text.bubble")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.purple)
            Text(feedback)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.purple.opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.purple.opacity(0.20), lineWidth: 1)
        )
    }

    private func formatCost(_ cost: Double) -> String {
        let format = cost < 0.001 ? "%.6f" : "%.4f"
        return String(format: "$" + format, cost)
    }
}
