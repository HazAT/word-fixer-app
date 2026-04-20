import SwiftUI
import HotKey

@main
struct WordFixerApp: App {
    let configManager = ConfigManager()
    let appState: AppState
    let hotKey: HotKey

    init() {
        let config = configManager
        let state = AppState(configManager: config)
        self.appState = state

        let key = Self.mapKey(config.config.shortcutKey)
        let modifiers = Self.mapModifiers(config.config.shortcutModifiers)
        hotKey = HotKey(key: key, modifiers: modifiers)
        hotKey.keyDownHandler = { [appState = state] in
            Task { @MainActor in appState.trigger() }
        }
    }

    var body: some Scene {
        MenuBarExtra("Word Fixer", systemImage: "textformat.abc") {
            Button("About") {
                let path = ConfigManager.configFile.path
                NSAlert.runModal(message: "Word Fixer", info: "Config: \(path)")
            }
            Divider()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }

    private static func mapKey(_ key: String) -> Key {
        switch key.lowercased() {
        case "a": return .a
        case "b": return .b
        case "c": return .c
        case "d": return .d
        case "e": return .e
        case "f": return .f
        case "g": return .g
        case "h": return .h
        case "i": return .i
        case "j": return .j
        case "k": return .k
        case "l": return .l
        case "m": return .m
        case "n": return .n
        case "o": return .o
        case "p": return .p
        case "q": return .q
        case "r": return .r
        case "s": return .s
        case "t": return .t
        case "u": return .u
        case "v": return .v
        case "w": return .w
        case "x": return .x
        case "y": return .y
        case "z": return .z
        default: return .c
        }
    }

    private static func mapModifiers(_ modifiers: [String]) -> NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "command": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "option", "alt": flags.insert(.option)
            case "control", "ctrl": flags.insert(.control)
            default: break
            }
        }
        return flags
    }
}

private extension NSAlert {
    static func runModal(message: String, info: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = info
        alert.runModal()
    }
}
