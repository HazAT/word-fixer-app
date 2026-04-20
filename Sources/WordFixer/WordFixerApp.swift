import SwiftUI

@main
struct WordFixerApp: App {
    var body: some Scene {
        MenuBarExtra("Word Fixer", systemImage: "textformat.abc") {
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }
}
