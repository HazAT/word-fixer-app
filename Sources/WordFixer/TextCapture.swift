import AppKit
import Carbon
import Foundation

enum ApplyStrategy {
    case accessibility
    case clipboard
}

struct TextTargetSession {
    let originalText: String
    let sourceApp: NSRunningApplication?
    let element: AXUIElement?
    let selectedRange: CFRange?
    let prefixContext: String
    let suffixContext: String
    let applyStrategy: ApplyStrategy
    let usedClipboardFallback: Bool
}

enum TextCaptureError: Error, LocalizedError {
    case accessibilityNotGranted
    case noTextCaptured
    case unsupportedTextElement
    case replacementFailed
    case selectionRestoreFailed
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
        case .selectionRestoreFailed:
            return "The original text selection could not be restored. Select the text again and retry."
        case .simulationFailed:
            return "Failed to simulate keyboard shortcut."
        }
    }
}

final class TextCapture {
    private enum Timing {
        static let clipboardCopySetup: Duration = .milliseconds(100)
        static let clipboardPoll: Duration = .milliseconds(50)
        static let selectionRestoreSettle: Duration = .milliseconds(100)
        static let clipboardWriteSetup: Duration = .milliseconds(75)
        static let clipboardApplySettle: Duration = .milliseconds(750)
    }

    private var savedClipboardItems: [[(String, Data)]]?

    func capture() async throws -> TextTargetSession {
        try ensureAccessibilityPermission()

        let sourceApp = NSWorkspace.shared.frontmostApplication
        if let session = captureFromAccessibility(sourceApp: sourceApp) {
            if session.applyStrategy == .accessibility {
                return session
            }

            // AX selected text can omit structural separators in rich web
            // editors (notably Slack), even though it still reports a valid
            // selection and range. Clipboard capture is authoritative whenever
            // AX cannot also provide a safe AX replacement path.
            return try await captureFromClipboardFallback(
                sourceApp: sourceApp,
                accessibilityTarget: session
            )
        }

        return try await captureFromClipboardFallback(sourceApp: sourceApp)
    }

    func apply(_ correctedText: String, to session: TextTargetSession) async throws {
        switch session.applyStrategy {
        case .accessibility:
            guard let element = session.element, let selectedRange = session.selectedRange else {
                throw TextCaptureError.replacementFailed
            }
            try replaceViaAccessibility(
                correctedText,
                originalText: session.originalText,
                prefixContext: session.prefixContext,
                suffixContext: session.suffixContext,
                element: element,
                selectedRange: selectedRange
            )
        case .clipboard:
            try await restoreClipboardSelection(for: session)
            if savedClipboardItems == nil {
                saveClipboard()
            }
            try await pasteViaClipboardFallback(correctedText)
        }
    }

    func cancel(session: TextTargetSession?) {
        guard shouldRestoreClipboard(for: session) else { return }
        restoreClipboard()
    }

    func finish(session: TextTargetSession?) {
        guard shouldRestoreClipboard(for: session) else { return }
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

        let selectedTextAttribute = copyStringAttribute(element, attribute: kAXSelectedTextAttribute as CFString)
        let selectedRangeAttribute = copyRangeAttribute(element, attribute: kAXSelectedTextRangeAttribute as CFString)
        let fullValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString)

        if let selectedText = selectedTextAttribute,
           !selectedText.isEmpty,
           let selectedRange = selectedRangeAttribute,
           selectedRange.length > 0 {
            let resolvedRange = resolvedSelectedRange(
                selectedText: selectedText,
                preferredRange: selectedRange,
                fullValue: fullValue
            )
            return buildAccessibilitySession(
                originalText: selectedText,
                sourceApp: sourceApp,
                element: element,
                selectedRange: resolvedRange,
                fullValue: fullValue
            )
        }

        guard let selectedRange = selectedRangeAttribute,
              selectedRange.length > 0,
              let fullValue,
              let selectedText = substring(fullValue, range: selectedRange),
              !selectedText.isEmpty else {
            return nil
        }

        return buildAccessibilitySession(
            originalText: selectedText,
            sourceApp: sourceApp,
            element: element,
            selectedRange: selectedRange,
            fullValue: fullValue
        )
    }

    private func replaceViaAccessibility(_ correctedText: String, originalText: String, prefixContext: String, suffixContext: String, element: AXUIElement, selectedRange: CFRange) throws {
        let replacementText = correctedText

        if try replaceSelectedTextAttribute(replacementText, originalText: originalText, element: element, selectedRange: selectedRange) {
            return
        }

        guard let fullValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString) else {
            throw TextCaptureError.replacementFailed
        }

        let resolvedRange = resolvedSelectedRange(
            selectedText: originalText,
            preferredRange: selectedRange,
            fullValue: fullValue,
            prefixContext: prefixContext,
            suffixContext: suffixContext
        )

        let nsValue = fullValue as NSString
        let nsRange = NSRange(location: resolvedRange.location, length: resolvedRange.length)
        guard nsRange.location >= 0,
              nsRange.length >= 0,
              nsRange.location + nsRange.length <= nsValue.length else {
            throw TextCaptureError.replacementFailed
        }

        let updatedValue = nsValue.replacingCharacters(in: nsRange, with: replacementText)
        let setValueResult = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            updatedValue as CFTypeRef
        )
        guard setValueResult == .success else {
            throw TextCaptureError.replacementFailed
        }

        var updatedRange = CFRange(location: resolvedRange.location, length: (replacementText as NSString).length)
        if let rangeValue = AXValueCreate(.cfRange, &updatedRange) {
            _ = AXUIElementSetAttributeValue(
                element,
                kAXSelectedTextRangeAttribute as CFString,
                rangeValue
            )
        }
    }

    private func replaceSelectedTextAttribute(_ replacementText: String, originalText: String, element: AXUIElement, selectedRange: CFRange) throws -> Bool {
        var writable = DarwinBoolean(false)
        let settableResult = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedTextAttribute as CFString,
            &writable
        )
        guard settableResult == .success, writable.boolValue else {
            return false
        }

        let beforeValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString)

        var range = selectedRange
        if let rangeValue = AXValueCreate(.cfRange, &range) {
            _ = AXUIElementSetAttributeValue(
                element,
                kAXSelectedTextRangeAttribute as CFString,
                rangeValue
            )
        }

        let setResult = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            replacementText as CFTypeRef
        )
        guard setResult == .success else {
            return false
        }

        guard let beforeValue else {
            return false
        }

        let expectedValue = (beforeValue as NSString).replacingCharacters(
            in: NSRange(location: selectedRange.location, length: selectedRange.length),
            with: replacementText
        )

        guard let afterValue = copyStringAttribute(element, attribute: kAXValueAttribute as CFString) else {
            return false
        }

        if afterValue == expectedValue {
            return true
        }

        return false
    }

    private func captureFromClipboardFallback(sourceApp: NSRunningApplication?, accessibilityTarget: TextTargetSession? = nil) async throws -> TextTargetSession {
        saveClipboard()

        let capturedText = try await copySelectedTextViaClipboard()

        guard let capturedText, !capturedText.isEmpty else {
            restoreClipboard()
            throw TextCaptureError.noTextCaptured
        }

        return TextTargetSession(
            originalText: capturedText,
            sourceApp: sourceApp,
            element: accessibilityTarget?.element,
            selectedRange: accessibilityTarget?.selectedRange,
            prefixContext: accessibilityTarget?.prefixContext ?? "",
            suffixContext: accessibilityTarget?.suffixContext ?? "",
            applyStrategy: .clipboard,
            usedClipboardFallback: true
        )
    }

    private func pasteViaClipboardFallback(_ text: String) async throws {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        DebugLog.write("clipboard paste prepared length=\(text.count)")
        try await Task.sleep(for: Timing.clipboardWriteSetup)
        simulatePaste()
        try await Task.sleep(for: Timing.clipboardApplySettle)
    }

    private func restoreClipboardSelection(for session: TextTargetSession) async throws {
        guard let element = session.element, let selectedRange = session.selectedRange else {
            DebugLog.write("clipboard selection restore unavailable: capture used clipboard fallback")
            return
        }

        let focusResult = AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )

        var range = selectedRange
        guard let rangeValue = AXValueCreate(.cfRange, &range) else {
            throw TextCaptureError.selectionRestoreFailed
        }
        let rangeResult = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            rangeValue
        )
        guard rangeResult == .success else {
            DebugLog.write("clipboard selection range restore failed result=\(rangeResult.rawValue) focusResult=\(focusResult.rawValue)")
            throw TextCaptureError.selectionRestoreFailed
        }

        try await Task.sleep(for: Timing.selectionRestoreSettle)

        let isFocused = copyBoolAttribute(element, attribute: kAXFocusedAttribute as CFString)
        let restoredText = copyStringAttribute(element, attribute: kAXSelectedTextAttribute as CFString)
        guard isFocused != false else {
            let restoredLength = restoredText?.count ?? -1
            DebugLog.write("clipboard selection verification failed focused=\(String(describing: isFocused)) restoredLength=\(restoredLength) expectedLength=\(session.originalText.count) focusResult=\(focusResult.rawValue)")
            throw TextCaptureError.selectionRestoreFailed
        }

        if restoredText == session.originalText {
            DebugLog.write("clipboard selection restored through AX length=\(restoredText?.count ?? 0) focusResult=\(focusResult.rawValue)")
            return
        }

        guard session.usedClipboardFallback,
              let copiedText = try await copySelectedTextViaClipboard(),
              copiedText == session.originalText else {
            let restoredLength = restoredText?.count ?? -1
            DebugLog.write("clipboard selection content verification failed axLength=\(restoredLength) expectedLength=\(session.originalText.count)")
            throw TextCaptureError.selectionRestoreFailed
        }

        DebugLog.write("clipboard selection restored and verified by copy length=\(copiedText.count) focusResult=\(focusResult.rawValue)")
    }

    private func copySelectedTextViaClipboard() async throws -> String? {
        try await Task.sleep(for: Timing.clipboardCopySetup)

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let emptyChangeCount = pasteboard.changeCount
        simulateCopy()

        for _ in 0..<20 {
            try await Task.sleep(for: Timing.clipboardPoll)
            if pasteboard.changeCount > emptyChangeCount,
               let copiedText = pasteboard.string(forType: .string),
               !copiedText.isEmpty {
                return copiedText
            }
        }

        return nil
    }

    private func shouldRestoreClipboard(for session: TextTargetSession?) -> Bool {
        guard let session else { return false }
        return session.usedClipboardFallback || session.applyStrategy == .clipboard
    }

    private func buildAccessibilitySession(originalText: String, sourceApp: NSRunningApplication?, element: AXUIElement, selectedRange: CFRange, fullValue: String?) -> TextTargetSession {
        let context = selectionContext(in: fullValue, range: selectedRange)
        return TextTargetSession(
            originalText: originalText,
            sourceApp: sourceApp,
            element: element,
            selectedRange: selectedRange,
            prefixContext: context.prefix,
            suffixContext: context.suffix,
            applyStrategy: chooseApplyStrategy(
                sourceApp: sourceApp,
                selectedText: originalText,
                selectedRange: selectedRange,
                fullValue: fullValue
            ),
            usedClipboardFallback: false
        )
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

    private func copyBoolAttribute(_ element: AXUIElement, attribute: CFString) -> Bool? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }
        return value as? Bool
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

    private func resolvedSelectedRange(selectedText: String, preferredRange: CFRange, fullValue: String?, prefixContext: String = "", suffixContext: String = "") -> CFRange {
        guard let fullValue else {
            return preferredRange
        }

        if let preferredText = substring(fullValue, range: preferredRange), preferredText == selectedText {
            return preferredRange
        }

        let nsFullValue = fullValue as NSString
        let nsSelectedText = selectedText as NSString
        var searchRange = NSRange(location: 0, length: nsFullValue.length)
        var exactContextMatch: NSRange?
        var bestRange: NSRange?
        var bestDistance = Int.max

        while true {
            let foundRange = nsFullValue.range(of: nsSelectedText as String, options: [], range: searchRange)
            if foundRange.location == NSNotFound {
                break
            }

            let matchesContext = matchesContext(in: fullValue, range: foundRange, prefixContext: prefixContext, suffixContext: suffixContext)
            if matchesContext {
                exactContextMatch = foundRange
                break
            }

            let distance = abs(foundRange.location - preferredRange.location)
            if distance < bestDistance {
                bestDistance = distance
                bestRange = foundRange
            }

            let nextLocation = foundRange.location + max(foundRange.length, 1)
            if nextLocation >= nsFullValue.length {
                break
            }
            searchRange = NSRange(location: nextLocation, length: nsFullValue.length - nextLocation)
        }

        if let exactContextMatch {
            return CFRange(location: exactContextMatch.location, length: exactContextMatch.length)
        }

        if let bestRange {
            return CFRange(location: bestRange.location, length: bestRange.length)
        }

        return preferredRange
    }

    private func selectionContext(in text: String?, range: CFRange, contextLength: Int = 8) -> (prefix: String, suffix: String) {
        guard let text else { return ("", "") }
        let nsText = text as NSString
        let textLength = nsText.length
        // Clamp the range into [0, textLength]. AX can hand us a selectedRange
        // that points outside `kAXValueAttribute` (e.g. selecting text inside a
        // web page where focus lives in a different element), and an unclamped
        // substring(with:) would raise NSRangeException and abort the process.
        let location = max(0, min(range.location, textLength))
        let length = max(0, min(range.length, textLength - location))
        let selectionEnd = location + length
        let prefixLength = min(contextLength, location)
        let suffixLength = min(contextLength, textLength - selectionEnd)
        let prefix = prefixLength > 0 ? nsText.substring(with: NSRange(location: location - prefixLength, length: prefixLength)) : ""
        let suffix = suffixLength > 0 ? nsText.substring(with: NSRange(location: selectionEnd, length: suffixLength)) : ""
        return (prefix, suffix)
    }

    private func matchesContext(in text: String, range: NSRange, prefixContext: String, suffixContext: String) -> Bool {
        let context = selectionContext(in: text, range: CFRange(location: range.location, length: range.length), contextLength: max(prefixContext.count, suffixContext.count, 8))
        let prefixMatches = prefixContext.isEmpty || context.prefix.hasSuffix(prefixContext)
        let suffixMatches = suffixContext.isEmpty || context.suffix.hasPrefix(suffixContext)
        return prefixMatches && suffixMatches
    }

    private func chooseApplyStrategy(sourceApp: NSRunningApplication?, selectedText: String, selectedRange: CFRange, fullValue: String?) -> ApplyStrategy {
        guard let sourceApp else {
            return .clipboard
        }

        if isLikelyElectronApp(sourceApp) || isLikelyCatalystApp(sourceApp) {
            return .clipboard
        }

        guard let fullValue else {
            return .clipboard
        }

        guard let rangeText = substring(fullValue, range: selectedRange), rangeText == selectedText else {
            return .clipboard
        }

        return .accessibility
    }

    private func isLikelyElectronApp(_ app: NSRunningApplication) -> Bool {
        guard let bundleURL = app.bundleURL else {
            return false
        }

        let frameworksURL = bundleURL.appendingPathComponent("Contents/Frameworks")
        let electronFramework = frameworksURL.appendingPathComponent("Electron Framework.framework").path
        let chromiumFramework = frameworksURL.appendingPathComponent("Chromium Embedded Framework.framework").path
        return FileManager.default.fileExists(atPath: electronFramework) || FileManager.default.fileExists(atPath: chromiumFramework)
    }

    private func isLikelyCatalystApp(_ app: NSRunningApplication) -> Bool {
        guard let bundleURL = app.bundleURL,
              let bundle = Bundle(url: bundleURL) else {
            return false
        }

        if bundle.object(forInfoDictionaryKey: "LSRequiresIPhoneOS") as? Bool == true {
            return true
        }

        let frameworksURL = bundleURL.appendingPathComponent("Contents/Frameworks")
        let uikitMacHelper = frameworksURL.appendingPathComponent("UIKitMacHelper.framework").path
        return FileManager.default.fileExists(atPath: uikitMacHelper)
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
