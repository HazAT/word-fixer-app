import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "WordFixerModel.js" as WordFixerModel

Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool opened: false
  property bool finished: false
  property string requestId: ""
  property string completionFile: ""
  property string viewState: "loading"
  property int selectedIndex: 0
  property string original: ""
  property string correction: ""
  property string natural: ""
  property string takeaway: ""
  property string errorMessage: ""
  property string errorAction: ""
  property var cost: null

  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property color scrim: Color.menu.scrim
  readonly property color border: Color.menu.border
  readonly property var cardBorderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  readonly property int cornerRadius: Style.cornerRadius
  readonly property int contentMargin: Style.spacing.panelPadding
  readonly property int contentSpacing: Style.spacing.panelGap
  readonly property string fontFamily: Style.font.menuFamily
  readonly property int maximumCardHeight: Math.max(0, panel.height - Math.max(Style.gapsOut * 4, Style.space(32)))
  readonly property int cardWidth: Math.min(Style.space(760), Math.max(0, panel.width - Math.max(Style.gapsOut * 4, Style.space(32))))
  readonly property int cardHeight: Math.min(maximumCardHeight, Math.max(Style.space(180), contentColumn.implicitHeight + contentMargin * 2))
  readonly property var choices: [
    { title: "Light edit", corrected: root.correction },
    { title: "Natural English", corrected: root.natural }
  ]

  function resetContent() {
    root.selectedIndex = 0
    root.original = ""
    root.correction = ""
    root.natural = ""
    root.takeaway = ""
    root.errorMessage = ""
    root.errorAction = ""
    root.cost = null
  }

  function writeCompletion(outcome, choice) {
    if (root.finished || !root.requestId || !root.completionFile) return
    root.finished = true
    completionWriter.path = root.completionFile
    completionWriter.setText(JSON.stringify(WordFixerModel.completion(root.requestId, outcome, choice)) + "\n")
  }

  function finish(outcome, choice) {
    root.writeCompletion(outcome, choice)
    root.opened = false
  }

  function dismiss() {
    root.finish("cancel", -1)
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "hazat.word-fixer")
  }

  function acceptSelected() {
    if (root.viewState !== "review") return
    root.finish("choice", root.selectedIndex)
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "hazat.word-fixer")
  }

  function applyPayload(payload) {
    var replacingRequest = root.opened && !root.finished && root.requestId
      && root.requestId !== payload.requestId
    if (replacingRequest) root.writeCompletion("cancel", -1)

    var sameRequest = root.requestId === payload.requestId
    root.requestId = payload.requestId
    root.completionFile = payload.completionFile
    root.finished = false
    root.opened = true
    root.viewState = payload.state
    if (!sameRequest) root.resetContent()

    if (payload.state === "review") {
      root.original = payload.original
      root.correction = payload.correction
      root.natural = payload.natural
      root.takeaway = payload.takeaway
      root.cost = payload.cost === undefined ? null : payload.cost
    } else if (payload.state === "error") {
      root.errorMessage = payload.message
      root.errorAction = payload.action
    }

    Qt.callLater(function() {
      if (root.opened) keyCatcher.forceActiveFocus()
    })
  }

  function open(payloadJson) {
    var payload = WordFixerModel.parsePayload(payloadJson)
    if (!payload.valid) {
      if (root.opened && !root.finished) root.writeCompletion("cancel", -1)
      root.resetContent()
      root.requestId = ""
      root.completionFile = ""
      root.finished = true
      root.viewState = "error"
      root.errorMessage = payload.error
      root.errorAction = "Press Escape to dismiss, then try the shortcut again."
      root.opened = true
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      return
    }
    root.applyPayload(payload)
  }

  function close() {
    root.finish("cancel", -1)
  }

  function handleKey(event) {
    var key = ""
    if (event.key === Qt.Key_Escape) key = "Escape"
    else if (event.key === Qt.Key_Return) key = "Return"
    else if (event.key === Qt.Key_Enter) key = "Enter"
    else if (event.key === Qt.Key_Backtab) key = "Backtab"
    else if (event.key === Qt.Key_Tab) key = "Tab"
    else return

    var action = WordFixerModel.keyAction(key, (event.modifiers & Qt.ShiftModifier) !== 0, root.viewState)
    if (action.action === "cancel") root.dismiss()
    else if (action.action === "accept") root.acceptSelected()
    else if (action.action === "select") root.selectedIndex = WordFixerModel.nextChoice(root.selectedIndex, action.direction)
    event.accepted = action.action !== "none"
  }

  FileView {
    id: completionWriter
    path: ""
    atomicWrites: true
    printErrors: true
  }

  PanelWindow {
    id: panel

    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "word-fixer"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.cardHeight
      anchors.centerIn: parent
      radius: root.cornerRadius
      color: root.background
      borderSpec: root.cardBorderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) { root.handleKey(event) }
      }

      ScrollView {
        id: scrollArea
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        clip: true
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical.policy: contentColumn.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff

        Column {
          id: contentColumn
          width: scrollArea.availableWidth
          spacing: root.contentSpacing

          Item {
            width: parent.width
            height: Math.max(titleLabel.implicitHeight, stateLabel.implicitHeight)

            Text {
              id: titleLabel
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Word Fixer"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.heading
              font.bold: true
            }

            Text {
              id: stateLabel
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: root.viewState === "review" ? "TAB TO SWITCH" : (root.viewState === "loading" ? "REVIEWING" : "ACTION NEEDED")
              color: root.viewState === "error" ? root.urgent : root.accent
              opacity: 0.9
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          Row {
            visible: root.viewState === "loading"
            width: parent.width
            spacing: Style.spacing.controlGap

            Text {
              textFormat: Text.PlainText
              text: loadingTimer.frame
              color: root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              text: "Reviewing three ways…"
              color: root.foreground
              opacity: 0.75
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          Repeater {
            model: root.viewState === "review" ? root.choices : []

            delegate: BorderSurface {
              id: choiceCard
              required property int index
              required property var modelData
              readonly property bool selected: index === root.selectedIndex

              width: contentColumn.width
              height: choiceContent.implicitHeight + Style.spacing.controlPaddingY * 2 + borderTop + borderBottom
              radius: root.cornerRadius
              color: selected
                ? Style.selectedFillFor(root.foreground, root.accent, root.urgent)
                : Style.normalFillFor(root.foreground, root.accent, root.urgent)
              borderSpec: selected
                ? Border.flat(root.accent, Math.max(1, Style.space(2)))
                : Border.controlSpec("normal", root.foreground, root.accent, root.urgent)
              padding: Style.spacing.controlPaddingX
              topPadding: Style.spacing.controlPaddingY
              bottomPadding: Style.spacing.controlPaddingY

              Column {
                id: choiceContent
                anchors.top: parent.top
                anchors.topMargin: choiceCard.contentTopInset
                anchors.left: parent.left
                anchors.leftMargin: choiceCard.contentLeftInset
                anchors.right: parent.right
                anchors.rightMargin: choiceCard.contentRightInset
                spacing: Style.spacing.labelGap

                Row {
                  width: parent.width
                  spacing: Style.spacing.controlGap

                  Text {
                    textFormat: Text.PlainText
                    text: choiceCard.selected ? "●" : "○"
                    color: choiceCard.selected ? root.accent : root.foreground
                    opacity: choiceCard.selected ? 1 : 0.55
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                  }

                  Text {
                    textFormat: Text.PlainText
                    text: choiceCard.modelData.title
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                  }

                  Text {
                    visible: choiceCard.selected
                    textFormat: Text.PlainText
                    text: "PASTE"
                    color: root.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                }

                Text {
                  width: parent.width
                  textFormat: Text.RichText
                  text: WordFixerModel.renderDiff(root.original, choiceCard.modelData.corrected, {
                    foreground: String(root.foreground),
                    added: String(root.accent),
                    deleted: String(root.urgent)
                  })
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.Wrap
                }
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.selectedIndex = choiceCard.index
              }
            }
          }

          BorderSurface {
            id: takeawayCard
            visible: root.viewState === "review"
            width: parent.width
            height: takeawayContent.implicitHeight + Style.spacing.controlPaddingY * 2 + borderTop + borderBottom
            radius: root.cornerRadius
            color: Style.normalFillFor(root.foreground, root.accent, root.urgent)
            borderSpec: Border.controlSpec("normal", root.foreground, root.accent, root.urgent)
            padding: Style.spacing.controlPaddingX
            topPadding: Style.spacing.controlPaddingY
            bottomPadding: Style.spacing.controlPaddingY

            Column {
              id: takeawayContent
              anchors.top: parent.top
              anchors.topMargin: takeawayCard.contentTopInset
              anchors.left: parent.left
              anchors.leftMargin: takeawayCard.contentLeftInset
              anchors.right: parent.right
              anchors.rightMargin: takeawayCard.contentRightInset
              spacing: Style.spacing.labelGap

              Text {
                textFormat: Text.PlainText
                text: "Takeaway"
                color: root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
              }

              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: root.takeaway
                color: root.foreground
                opacity: 0.82
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.Wrap
              }
            }
          }

          Column {
            visible: root.viewState === "error"
            width: parent.width
            spacing: Style.spacing.md

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.errorMessage
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              wrapMode: Text.Wrap
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.errorAction
              color: root.foreground
              opacity: 0.78
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
            }
          }

          Column {
            width: parent.width
            spacing: Style.spacing.xs

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.viewState === "review"
                ? "Tab / Shift+Tab Switch  ·  Enter Paste selected  ·  Esc Dismiss"
                : "Esc Dismiss"
              color: root.foreground
              opacity: 0.55
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              wrapMode: Text.Wrap
            }

            Text {
              visible: root.viewState === "review" && root.cost !== null
              width: parent.width
              textFormat: Text.PlainText
              text: WordFixerModel.formatCost(root.cost)
              color: root.foreground
              opacity: 0.48
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
            }
          }
        }
      }
    }
  }

  Timer {
    id: loadingTimer
    property int step: 0
    readonly property string frame: ["·", "··", "···"][step]
    interval: 350
    repeat: true
    running: root.opened && root.viewState === "loading"
    onTriggered: step = (step + 1) % 3
  }
}
