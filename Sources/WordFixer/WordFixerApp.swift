import SwiftUI

@main
struct WordFixerApp: App {
    let configManager = ConfigManager()
    let textCapture = TextCapture()

    var body: some Scene {
        MenuBarExtra("Word Fixer", systemImage: "textformat.abc") {
            Button("Test Capture") {
                Task {
                    textCapture.saveClipboard()
                    do {
                        let text = try await textCapture.captureSelectedText()
                        print("[TextCapture] Captured text: \(text)")
                    } catch {
                        print("[TextCapture] Error: \(error.localizedDescription)")
                    }
                    textCapture.restoreClipboard()
                }
            }
            Divider()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }
}
