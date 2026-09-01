import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui as Ui

Ui.BarWidget {
  id: root
  moduleName: "hazat.word-fixer"

  property bool reviewing: false
  readonly property string runtimeRoot: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string ownerFile: runtimeRoot + "/word-fixer/active.lock/owner.json"

  function refreshStatus() {
    statusReader.reload()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  FileView {
    id: statusReader
    path: root.ownerFile
    printErrors: false
    onLoaded: root.reviewing = true
    onLoadFailed: root.reviewing = false
  }

  Timer {
    interval: 750
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshStatus()
  }

  Ui.BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "W"
    fontSize: Style.font.caption
    active: root.reviewing
    tooltipText: root.reviewing
      ? "Word Fixer · Reviewing text"
      : "Word Fixer ready · SUPER+SHIFT+C"

    onPressed: function() {
      if (!root.bar) return
      var message = root.reviewing
        ? "A review is currently in progress."
        : "Ready — select text and press SUPER+SHIFT+C."
      root.bar.run("notify-send --urgency=low 'Word Fixer' '" + message + "'")
    }
  }
}
