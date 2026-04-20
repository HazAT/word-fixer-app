import AppKit
import Carbon
import Foundation

struct TextTargetSession {
    let originalText: String
    let sourceApp: NSRunningApplication?
    let element: AXUIElement?
    let selectedRange: CFRange?
    let usedClipboardFallback: Bool
}

enum TextCaptureError: Error, LocalizedError {
    case accessibilityNotGranted
    case noTextCaptured
    case unsupportedTextElement
    case replacementFailed
    case simulationFailed

    var errorDescription: String? {
        switch self {
        case .accessibilityNotGranted:
            return "Accessibility permission required. Open System Settings → Privacy & Security → Accessibility."
        case .noTextCaptured:
            return "No text was captured. Make sure text is selected."
        case .unsupportedTextElement:
            return "The focused app doesn't expose selected text through Accessibility."
        case .replacementFailed:
            return "Failed to replace the selected text."
        case .simulationFailed:
            return "Failed to simulate keyboard shortcut."
        }
    }
}

final class TextCapture {
    private var savedClipboardItems: [[(String, Data)]]?

    func capture() async throws -> TextTargetSession {
        try ensureAccessibilityPermission()

        let sourceApp = NSWorkspace.shared.frontmostApplication
        if let session = captureFromAccessibility(sourceApp: sourceApp) {
            return session
        }

        return try await captureFromClipboardFallback(sourceApp: sourceApp)
    }

    func apply(_ correctedText: String, to session: TextTargetSession) async throws {
        if let element = session.element, let selectedRange = session.selectedRange {
            try replaceViaAccessibility(
                correctedText,
                element: element,
                selectedRange: selectedRange
            )
            return
        }

        try await pasteViaClipboardFallback(correctedText)
    }

    func cancel(session: TextTargetSession?) {
        guard let session, session.usedClipboardFallback else { return }
        restoreClipboard()
    }

    func finish(session: TextTargetSession?) {
        guard let session, session.usedClipboardFallback else { return }
        restoreClipboard()
    }

    private func ensureAccessibilityPermission() throws {
        guard AXIsProcessTrusted() else {
            let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            throw TextCaptureError.accessibilityNotGranted
        }
    }

    private func captureFromAccessibility(sourceApp: NSRunningApplication?) -> TextTargetSession? {
        let system = AXUIElementCreateSystemWide()
        guard let element = copyAXElementAttribute(system, attribute: kAXFocusedUIElementAttribute as CFString) else {
            return nil
        }

        if let selectedText = copyStringAttribute(element, attribute: kAXSelectedTextAttribute as CFString),
           !selectedText.isEmpty,
           let selectedRange = copyRangeAttribute(element, attribute: kAXSelectedTextRangeAttribute as CFString),
           selectedRange.length > 0 {
            return TextTargetSession(
                originalText: selectedText,
                sourceApp: sourceApp,
                element: element,
                selectedRange: selectedRange,
                usedClipboardFallback: false
            )
        }

        guard let selectedRange = copyRangeAttribute(element, attribute: kAXSelectedTextRangeAttribute as CFString),
              selectedRange.length > 0,
              let fullValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString),
              let selectedText = substring(fullValue, range: selectedRange),
              !selectedText.isEmpty else {
            return nil
        }

        return TextTargetSession(
            originalText: selectedText,
            sourceApp: sourceApp,
            element: element,
            selectedRange: selectedRange,
            usedClipboardFallback: false
        )
    }

    private func replaceViaAccessibility(_ correctedText: String, element: AXUIElement, selectedRange: CFRange) throws {
        guard let fullValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString) else {
            throw TextCaptureError.replacementFailed
        }

        let nsValue = fullValue as NSString
        let nsRange = NSRange(location: selectedRange.location, length: selectedRange.length)
        guard nsRange.location >= 0,
              nsRange.length >= 0,
              nsRange.location + nsRange.length <= nsValue.length else {
            throw TextCaptureError.replacementFailed
        }

        let updatedValue = nsValue.replacingCharacters(in: nsRange, with: correctedText)
        let setValueResult = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            updatedValue as CFTypeRef
        )
        guard setValueResult == .success else {
            throw TextCaptureError.replacementFailed
        }

        var updatedRange = CFRange(location: selectedRange.location, length: (correctedText as NSString).length)
        if let rangeValue = AXValueCreate(.cfRange, &updatedRange) {
            _ = AXUIElementSetAttributeValue(
                element,
                kAXSelectedTextRangeAttribute as CFString,
                rangeValue
            )
        }
    }

    private func captureFromClipboardFallback(sourceApp: NSRunningApplication?) async throws -> TextTargetSession {
        saveClipboard()

        try await Task.sleep(for: .milliseconds(100))

        let pasteboard = NSPasteboard.general
        let initialChangeCount = pasteboard.changeCount
        pasteboard.clearContents()
        simulateCopy()

        var capturedText: String?
        for _ in 0..<20 {
            try await Task.sleep(for: .milliseconds(50))
            if pasteboard.changeCount > initialChangeCount {
                capturedText = pasteboard.string(forType: .string)
                if let capturedText, !capturedText.isEmpty {
                    break
                }
            }
        }

        guard let capturedText, !capturedText.isEmpty else {
            restoreClipboard()
            throw TextCaptureError.noTextCaptured
        }

        return TextTargetSession(
            originalText: capturedText,
            sourceApp: sourceApp,
            element: nil,
            selectedRange: nil,
            usedClipboardFallback: true
        )
    }

    private func pasteViaClipboardFallback(_ text: String) async throws {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        simulatePaste()
        try await Task.sleep(for: .milliseconds(300))
    }

    private func saveClipboard() {
        let pasteboard = NSPasteboard.general
        savedClipboardItems = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in
                guard let data = item.data(forType: type) else { return nil }
                return (type.rawValue, data)
            }
        }
    }

    private func restoreClipboard() {
        guard let savedClipboardItems else { return }

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let items = savedClipboardItems.map { storedItem in
            let pasteboardItem = NSPasteboardItem()
            for (type, data) in storedItem {
                pasteboardItem.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            return pasteboardItem
        }
        pasteboard.writeObjects(items)
        self.savedClipboardItems = nil
    }

    private func copyAXElementAttribute(_ element: AXUIElement, attribute: CFString) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func copyStringAttribute(_ element: AXUIElement, attribute: CFString) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success else { return nil }
        return value as? String
    }

    private func copyRangeAttribute(_ element: AXUIElement, attribute: CFString) -> CFRange? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }
        let axValue = unsafeBitCast(value, to: AXValue.self)
        guard AXValueGetType(axValue) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return range
    }

    private func substring(_ text: String, range: CFRange) -> String? {
        let nsText = text as NSString
        let nsRange = NSRange(location: range.location, length: range.length)
        guard nsRange.location >= 0,
              nsRange.length >= 0,
              nsRange.location + nsRange.length <= nsText.length else {
            return nil
        }
        return nsText.substring(with: nsRange)
    }

    private func simulateCopy() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: UInt16(kVK_ANSI_C), keyDown: true)!
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: UInt16(kVK_ANSI_C), keyDown: false)!
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    private func simulatePaste() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: UInt16(kVK_ANSI_V), keyDown: true)!
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: UInt16(kVK_ANSI_V), keyDown: false)!
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
}
