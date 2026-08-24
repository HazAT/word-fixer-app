import AppKit
import SwiftUI

final class OverlayPanel: NSPanel {
    var onConfirm: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onSwitchSelection: (() -> Void)?

    private var hostingView: NSHostingView<OverlayView>?

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 580, height: 200),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .floating
        isMovableByWindowBackground = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        hidesOnDeactivate = false
        animationBehavior = .utilityWindow
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
    }

    override var canBecomeKey: Bool { true }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36: // Return
            onConfirm?()
        case 53: // Escape
            onDismiss?()
        case 48: // Tab
            onSwitchSelection?()
        default:
            super.keyDown(with: event)
        }
    }

    func show(state: OverlayState) {
        let view = OverlayView(state: state)
        if let existing = hostingView {
            existing.rootView = view
        } else {
            let hv = NSHostingView(rootView: view)
            hv.translatesAutoresizingMaskIntoConstraints = false
            contentView = hv
            hostingView = hv
        }

        // Size to fit content
        hostingView?.layout()
        let fittingSize = hostingView?.fittingSize ?? NSSize(width: 580, height: 200)
        let maximumHeight = min(NSScreen.main?.visibleFrame.height ?? 680, 680) - 40
        let panelSize = NSSize(width: 580, height: min(fittingSize.height, maximumHeight))

        // Center on screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - panelSize.width / 2
            let y = screenFrame.midY - panelSize.height / 2
            setFrame(NSRect(origin: NSPoint(x: x, y: y), size: panelSize), display: true)
        }

        makeKeyAndOrderFront(nil)
    }

    func hide() {
        orderOut(nil)
    }
}
