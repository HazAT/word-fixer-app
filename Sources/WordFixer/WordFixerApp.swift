import SwiftUI

@main
struct WordFixerApp: App {
    let configManager = ConfigManager()
    let textCapture = TextCapture()
    let piInvoker = PiInvoker()

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
            Button("Test Pi") {
                Task {
                    do {
                        let result = try await piInvoker.invoke(
                            text: "I havve a speling eror in this sentance",
                            config: configManager.config
                        )
                        print("[PiInvoker] Result: \(result)")
                    } catch {
                        print("[PiInvoker] Error: \(error.localizedDescription)")
                    }
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
