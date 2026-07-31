import Foundation
import Testing
@testable import WordFixer

struct DiffEngineTests {
    @Test
    func preservesLineBoundariesAroundCorrections() {
        let original = "this si a simple\nnormal test\nwit h some linebreaks"
        let corrected = "this is a simple\nnormal test\nwith some linebreaks"

        let rendered = String(DiffEngine().computeDiff(original: original, corrected: corrected).characters)

        #expect(rendered.contains("simple\nnormal"))
        #expect(rendered.contains("test\n"))
        #expect(!rendered.contains("simplenormal"))
        #expect(lineBreaks(in: rendered) == ["\n", "\n"])
    }

    @Test
    func preservesBlankLinesAndMixedSeparators() {
        let original = "One eror.\r\n\r\nSecond lnie.\rLast line."
        let corrected = "One error.\r\n\r\nSecond line.\rLast line."

        let rendered = String(DiffEngine().computeDiff(original: original, corrected: corrected).characters)

        #expect(lineBreaks(in: rendered) == ["\r\n", "\r\n", "\r"])
    }

    @Test
    func returnsUnchangedMultilineTextExactly() {
        let text = "First line\n\nSecond line\r\n"

        let rendered = String(DiffEngine().computeDiff(original: text, corrected: text).characters)

        #expect(rendered == text)
    }

    private func lineBreaks(in text: String) -> [String] {
        let nsText = text as NSString
        var result: [String] = []
        var index = 0

        while index < nsText.length {
            if nsText.character(at: index) == 13 {
                if index + 1 < nsText.length, nsText.character(at: index + 1) == 10 {
                    result.append("\r\n")
                    index += 2
                } else {
                    result.append("\r")
                    index += 1
                }
            } else if nsText.character(at: index) == 10 {
                result.append("\n")
                index += 1
            } else {
                index += 1
            }
        }

        return result
    }
}
