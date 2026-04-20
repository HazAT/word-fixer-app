import AppKit
import SwiftUI

@Observable
@MainActor
final class AppState {
    private let configManager: ConfigManager
    private let textCapture = TextCapture()
    private let piInvoker = PiInvoker()
    private let diffEngine = DiffEngine()
    let overlayPanel = OverlayPanel()

    private var correctedText: String?

    init(configManager: ConfigManager) {
        self.configManager = configManager

        overlayPanel.onConfirm = { [weak self] in
            Task { @MainActor in self?.confirm() }
        }
        overlayPanel.onDismiss = { [weak self] in
            Task { @MainActor in self?.dismiss() }
        }
    }

    func trigger() {
        Task { @MainActor in
            textCapture.saveClipboard()

            let original: String
            do {
                original = try await textCapture.captureSelectedText()
            } catch {
                overlayPanel.show(state: .error(error.localizedDescription))
                textCapture.restoreClipboard()
                return
            }

            overlayPanel.show(state: .loading)

            let corrected: String
            do {
                corrected = try await piInvoker.invoke(text: original, config: configManager.config)
            } catch {
                overlayPanel.show(state: .error(error.localizedDescription))
                textCapture.restoreClipboard()
                return
            }

            self.correctedText = corrected
            let diff = diffEngine.computeDiff(original: original, corrected: corrected)
            overlayPanel.show(state: .diff(diff))
        }
    }

    func confirm() {
        guard let text = correctedText else {
            overlayPanel.hide()
            return
        }
        Task { @MainActor in
            do {
                try await textCapture.pasteText(text)
            } catch {
                print("[AppState] Paste error: \(error.localizedDescription)")
            }
            textCapture.restoreClipboard()
            correctedText = nil
            overlayPanel.hide()
        }
    }

    func dismiss() {
        textCapture.restoreClipboard()
        correctedText = nil
        overlayPanel.hide()
    }
}
