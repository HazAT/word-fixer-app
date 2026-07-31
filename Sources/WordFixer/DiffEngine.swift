import SwiftUI

struct DiffEngine {
    private enum TokenStyle { case plain, deleted, added }
    private struct Line {
        let content: String
        let separator: String
    }

    /// Compute an inline diff as an AttributedString while preserving the exact
    /// whitespace layout, including line breaks.
    func computeDiff(original: String, corrected: String) -> AttributedString {
        if original == corrected {
            return AttributedString(original)
        }

        let oldLines = splitLines(original)
        let newLines = splitLines(corrected)
        let hasMatchingLineStructure = oldLines.count == newLines.count
            && zip(oldLines, newLines).allSatisfy { $0.separator == $1.separator }

        guard hasMatchingLineStructure else {
            return computeInlineDiff(original: original, corrected: corrected)
        }

        var result = AttributedString()
        for (oldLine, newLine) in zip(oldLines, newLines) {
            result.append(computeInlineDiff(original: oldLine.content, corrected: newLine.content))
            result.append(AttributedString(newLine.separator))
        }
        return result
    }

    private func computeInlineDiff(original: String, corrected: String) -> AttributedString {
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

    private func splitLines(_ text: String) -> [Line] {
        let nsText = text as NSString
        var lines: [Line] = []
        var lineStart = 0
        var index = 0

        while index < nsText.length {
            let character = nsText.character(at: index)
            guard character == 13 || character == 10 else {
                index += 1
                continue
            }

            let separatorLength = character == 13
                && index + 1 < nsText.length
                && nsText.character(at: index + 1) == 10 ? 2 : 1
            let content = nsText.substring(with: NSRange(location: lineStart, length: index - lineStart))
            let separator = nsText.substring(with: NSRange(location: index, length: separatorLength))
            lines.append(Line(content: content, separator: separator))
            index += separatorLength
            lineStart = index
        }

        lines.append(Line(
            content: nsText.substring(with: NSRange(location: lineStart, length: nsText.length - lineStart)),
            separator: ""
        ))
        return lines
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
