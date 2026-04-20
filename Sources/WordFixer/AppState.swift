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

    private var session: TextTargetSession?
    private var correctedText: String?
    private var isProcessing = false

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
        guard !isProcessing else { return }
        isProcessing = true

        Task { @MainActor in
            let session: TextTargetSession
            do {
                session = try await textCapture.capture()
                self.session = session
            } catch {
                overlayPanel.show(state: .error(error.localizedDescription))
                self.session = nil
                return
            }

            overlayPanel.show(state: .loading)

            let correctedText: String
            do {
                correctedText = try await piInvoker.invoke(text: session.originalText, config: configManager.config)
            } catch {
                overlayPanel.show(state: .error(error.localizedDescription))
                return
            }

            self.correctedText = correctedText
            let diff = diffEngine.computeDiff(original: session.originalText, corrected: correctedText)
            overlayPanel.show(state: .diff(diff))
        }
    }

    func confirm() {
        guard let session, let correctedText else {
            reset()
            return
        }

        Task { @MainActor in
            overlayPanel.hide()

            if session.usedClipboardFallback, let sourceApp = session.sourceApp {
                sourceApp.activate()
                try? await Task.sleep(for: .milliseconds(200))
            }

            do {
                try await textCapture.apply(correctedText, to: session)
                textCapture.finish(session: session)
            } catch {
                textCapture.cancel(session: session)
                overlayPanel.show(state: .error(error.localizedDescription))
                return
            }

            session.sourceApp?.activate()
            reset()
        }
    }

    func dismiss() {
        overlayPanel.hide()
        if let session {
            textCapture.cancel(session: session)
            session.sourceApp?.activate()
        }
        reset()
    }

    private func reset() {
        session = nil
        correctedText = nil
        isProcessing = false
    }
}
