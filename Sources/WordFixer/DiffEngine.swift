import SwiftUI

struct DiffEngine {
    private enum TokenStyle { case plain, deleted, added }

    /// Compute an inline diff as an AttributedString while preserving the exact
    /// whitespace layout, including line breaks.
    func computeDiff(original: String, corrected: String) -> AttributedString {
        if original == corrected {
            return AttributedString(original)
        }

        let oldTokens = tokenize(original)
        let newTokens = tokenize(corrected)
        let diff = newTokens.difference(from: oldTokens)

        var removedOldIndices = Set<Int>()
        var insertedNewIndices = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let offset, _, _): removedOldIndices.insert(offset)
            case .insert(let offset, _, _): insertedNewIndices.insert(offset)
            }
        }

        let keptOld = (0..<oldTokens.count).filter { !removedOldIndices.contains($0) }
        let keptNew = (0..<newTokens.count).filter { !insertedNewIndices.contains($0) }

        var ops: [(String, TokenStyle)] = []
        var prevOld = -1
        var prevNew = -1

        for i in 0..<keptOld.count {
            let oldIndex = keptOld[i]
            let newIndex = keptNew[i]

            for j in (prevOld + 1)..<oldIndex { ops.append((oldTokens[j], .deleted)) }
            for j in (prevNew + 1)..<newIndex { ops.append((newTokens[j], .added)) }
            ops.append((oldTokens[oldIndex], .plain))

            prevOld = oldIndex
            prevNew = newIndex
        }

        for j in (prevOld + 1)..<oldTokens.count { ops.append((oldTokens[j], .deleted)) }
        for j in (prevNew + 1)..<newTokens.count { ops.append((newTokens[j], .added)) }

        var result = AttributedString()
        for (token, style) in ops {
            var attr = AttributedString(token)
            switch style {
            case .plain:
                break
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

    private func tokenize(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }

        var tokens: [String] = []
        var current = ""
        var currentIsWhitespace: Bool?

        for character in text {
            let isWhitespace = character.isWhitespace
            if currentIsWhitespace == isWhitespace || currentIsWhitespace == nil {
                current.append(character)
                currentIsWhitespace = isWhitespace
                continue
            }

            tokens.append(current)
            current = String(character)
            currentIsWhitespace = isWhitespace
        }

        if !current.isEmpty {
            tokens.append(current)
        }

        return tokens
    }
}
