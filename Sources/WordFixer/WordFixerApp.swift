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
            Button("Test Diff") {
                let engine = DiffEngine()
                let diff1 = engine.computeDiff(original: "teh quick brown fox", corrected: "the quick brown fox")
                let diff2 = engine.computeDiff(original: "hello world", corrected: "hello beautiful world")
                let diff3 = engine.computeDiff(original: "remove this word", corrected: "remove word")
                let diff4 = engine.computeDiff(original: "same text", corrected: "same text")
                print("[DiffEngine] Test 1: \(diff1)")
                print("[DiffEngine] Test 2: \(diff2)")
                print("[DiffEngine] Test 3: \(diff3)")
                print("[DiffEngine] Test 4: \(diff4)")
            }
            Divider()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }
}
