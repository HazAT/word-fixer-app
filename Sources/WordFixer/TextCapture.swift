import AppKit
import Carbon

enum TextCaptureError: Error, LocalizedError {
    case accessibilityNotGranted
    case noTextCaptured
    case simulationFailed

    var errorDescription: String? {
        switch self {
        case .accessibilityNotGranted:
            return "Accessibility permission required. Open System Settings → Privacy & Security → Accessibility."
        case .noTextCaptured:
            return "No text was captured. Make sure text is selected."
        case .simulationFailed:
            return "Failed to simulate keyboard shortcut."
        }
    }
}

final class TextCapture {
    private var savedItems: [(String, Data)]? = nil  // (type, data) pairs

    func saveClipboard() {
        let pb = NSPasteboard.general
        savedItems = []
        for item in pb.pasteboardItems ?? [] {
            for type in item.types {
                if let data = item.data(forType: type) {
                    savedItems?.append((type.rawValue, data))
                }
            }
        }
    }

    func restoreClipboard() {
        guard let items = savedItems else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        let item = NSPasteboardItem()
        for (typeStr, data) in items {
            item.setData(data, forType: NSPasteboard.PasteboardType(typeStr))
        }
        pb.writeObjects([item])
        savedItems = nil
    }

    func captureSelectedText() async throws -> String {
        guard AXIsProcessTrusted() else {
            let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            throw TextCaptureError.accessibilityNotGranted
        }

        NSPasteboard.general.clearContents()
        try simulateKeyPress(keyCode: UInt16(kVK_ANSI_C), flags: .maskCommand)

        try await Task.sleep(for: .milliseconds(150))

        guard let text = NSPasteboard.general.string(forType: .string),
              !text.isEmpty else {
            throw TextCaptureError.noTextCaptured
        }
        return text
    }

    func pasteText(_ text: String) async throws {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        try simulateKeyPress(keyCode: UInt16(kVK_ANSI_V), flags: .maskCommand)

        try await Task.sleep(for: .milliseconds(200))
    }

    private func simulateKeyPress(keyCode: UInt16, flags: CGEventFlags) throws {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw TextCaptureError.simulationFailed
        }
        keyDown.flags = flags
        keyUp.flags = flags
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
}
