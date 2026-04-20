import SwiftUI

struct DiffEngine {
    private enum WordStyle { case plain, deleted, added }

    /// Compute a word-level inline diff as an AttributedString.
    /// Deletions are shown in red with strikethrough, additions in green background.
    func computeDiff(original: String, corrected: String) -> AttributedString {
        if original == corrected {
            return AttributedString(original)
        }

        let oldWords = tokenize(original)
        let newWords = tokenize(corrected)

        let diff = newWords.difference(from: oldWords)

        var removedOldIndices = Set<Int>()
        var insertedNewIndices = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let offset, _, _): removedOldIndices.insert(offset)
            case .insert(let offset, _, _): insertedNewIndices.insert(offset)
            }
        }

        // Build ordered list of (word, style) by merging old/new around kept (LCS) words
        let keptOld = (0..<oldWords.count).filter { !removedOldIndices.contains($0) }
        let keptNew = (0..<newWords.count).filter { !insertedNewIndices.contains($0) }

        var ops: [(String, WordStyle)] = []
        var prevOld = -1
        var prevNew = -1

        for i in 0..<keptOld.count {
            let oi = keptOld[i]
            let ni = keptNew[i]
            // Deletions from old before this kept word
            for j in (prevOld + 1)..<oi { ops.append((oldWords[j], .deleted)) }
            // Insertions from new before this kept word
            for j in (prevNew + 1)..<ni { ops.append((newWords[j], .added)) }
            // Unchanged word
            ops.append((oldWords[oi], .plain))
            prevOld = oi
            prevNew = ni
        }

        // Trailing deletions and insertions
        for j in (prevOld + 1)..<oldWords.count { ops.append((oldWords[j], .deleted)) }
        for j in (prevNew + 1)..<newWords.count { ops.append((newWords[j], .added)) }

        // Build AttributedString
        var result = AttributedString()
        for (idx, (word, style)) in ops.enumerated() {
            if idx > 0 { result.append(AttributedString(" ")) }
            var attr = AttributedString(word)
            switch style {
            case .plain: break
            case .deleted:
                attr.foregroundColor = .red
                attr.strikethroughStyle = .single
            case .added:
                attr.backgroundColor = Color.green.opacity(0.3)
            }
            result.append(attr)
        }
        return result
    }

    /// Split text into tokens on any whitespace, preserving non-empty words.
    private func tokenize(_ text: String) -> [String] {
        text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
    }
}
