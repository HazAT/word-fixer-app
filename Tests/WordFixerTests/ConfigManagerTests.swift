import Foundation
import Testing
@testable import WordFixer

struct ConfigManagerTests {
    @Test
    func decodesSharedLinuxConfigWithMacShortcutDefaults() throws {
        let data = Data(#"{"nodeBinaryPath":"/tmp/word-fixer/node","debugLogging":false}"#.utf8)

        let config = try JSONDecoder().decode(AppConfig.self, from: data)

        #expect(config.nodeBinaryPath == "/tmp/word-fixer/node")
        #expect(config.shortcutKey == "c")
        #expect(config.shortcutModifiers == ["command", "shift"])
        #expect(config.debugLogging == false)
    }

    @Test
    func encodesOnlyTheSharedNodeRuntimeSchema() throws {
        let config = AppConfig(
            shortcutKey: "c",
            shortcutModifiers: ["command", "shift"],
            nodeBinaryPath: "/tmp/word-fixer/node",
            debugLogging: true
        )

        let value = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(config)) as? [String: Any])

        #expect(value["nodeBinaryPath"] as? String == "/tmp/word-fixer/node")
        #expect(value["piBinaryPath"] == nil)
    }

    @Test
    func keepsHelperRuntimeStateOutsideConfiguration() {
        #expect(ConfigManager.helperStateFile.deletingLastPathComponent() == ConfigManager.dataDir)
        #expect(ConfigManager.helperStateFile.deletingLastPathComponent() != ConfigManager.configDir)
    }
}
