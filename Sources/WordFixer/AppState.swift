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
    private var invocationCost: Double?
    private var isProcessing = false
    private var isApplying = false
    private var currentInvocationTask: Task<Void, Never>?

    init(configManager: ConfigManager) {
        self.configManager = configManager
        DebugLog.write("AppState.init piBinaryPath=\(configManager.config.piBinaryPath)")

        Task {
            DebugLog.write("AppState prewarm start")
            await piInvoker.prewarm(config: configManager.config)
            DebugLog.write("AppState prewarm finished")
        }

        overlayPanel.onConfirm = { [weak self] in
            Task { @MainActor in self?.confirm() }
        }
        overlayPanel.onDismiss = { [weak self] in
            Task { @MainActor in self?.dismiss() }
        }
    }

    func trigger() {
        guard !isProcessing else {
            DebugLog.write("trigger ignored: already processing")
            return
        }
        DebugLog.write("trigger start")
        isProcessing = true

        currentInvocationTask = Task { @MainActor in
            let session: TextTargetSession
            do {
                session = try await textCapture.capture()
                DebugLog.write("capture success length=\(session.originalText.count) clipboardFallback=\(session.usedClipboardFallback) applyStrategy=\(session.applyStrategy)")
                self.session = session
            } catch {
                DebugLog.write("capture failed error=\(error.localizedDescription)")
                currentInvocationTask = nil
                isProcessing = false
                overlayPanel.show(state: .error(error.localizedDescription))
                self.session = nil
                return
            }

            if Task.isCancelled {
                DebugLog.write("trigger cancelled before loading state")
                currentInvocationTask = nil
                isProcessing = false
                return
            }

            DebugLog.write("overlay loading shown")
            overlayPanel.show(state: .loading)

            let invocation: PiInvocationResult
            do {
                invocation = try await piInvoker.invoke(text: session.originalText, config: configManager.config)
                let costDescription = invocation.cost.map { String($0) } ?? "nil"
                DebugLog.write("pi invoke success outputLength=\(invocation.text.count) cost=\(costDescription)")
            } catch is CancellationError {
                DebugLog.write("pi invoke cancelled")
                currentInvocationTask = nil
                isProcessing = false
                return
            } catch {
                DebugLog.write("pi invoke failed error=\(error.localizedDescription)")
                currentInvocationTask = nil
                isProcessing = false
                overlayPanel.show(state: .error(error.localizedDescription))
                return
            }

            currentInvocationTask = nil
            self.correctedText = invocation.text
            self.invocationCost = invocation.cost
            let diff = diffEngine.computeDiff(original: session.originalText, corrected: invocation.text)
            DebugLog.write("overlay diff shown")
            overlayPanel.show(state: .diff(diff, cost: invocation.cost))
        }
    }

    func confirm() {
        guard !isApplying else {
            DebugLog.write("confirm ignored: already applying")
            return
        }

        DebugLog.write("confirm")
        guard let session, let correctedText else {
            DebugLog.write("confirm with missing session/text")
            reset()
            return
        }

        isApplying = true

        Task { @MainActor in
            overlayPanel.hide()

            if session.applyStrategy == .clipboard, let sourceApp = session.sourceApp {
                sourceApp.activate()
                try? await Task.sleep(for: .milliseconds(300))
            }

            do {
                try await textCapture.apply(correctedText, to: session)
                textCapture.finish(session: session)
                DebugLog.write("apply success")
            } catch {
                DebugLog.write("apply failed error=\(error.localizedDescription)")
                textCapture.cancel(session: session)
                reset()
                overlayPanel.show(state: .error(error.localizedDescription))
                return
            }

            session.sourceApp?.activate()
            reset()
        }
    }

    func dismiss() {
        DebugLog.write("dismiss")
        currentInvocationTask?.cancel()
        currentInvocationTask = nil
        overlayPanel.hide()
        if let session {
            textCapture.cancel(session: session)
            session.sourceApp?.activate()
        }
        reset()
    }

    private func reset() {
        DebugLog.write("reset")
        currentInvocationTask = nil
        session = nil
        correctedText = nil
        invocationCost = nil
        isProcessing = false
        isApplying = false
    }
}
