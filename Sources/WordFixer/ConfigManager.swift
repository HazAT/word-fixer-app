import Foundation

struct AppConfig: Codable {
    var shortcutKey: String
    var shortcutModifiers: [String]
    var nodeBinaryPath: String
    var debugLogging: Bool

    init(shortcutKey: String, shortcutModifiers: [String], nodeBinaryPath: String, debugLogging: Bool) {
        self.shortcutKey = shortcutKey
        self.shortcutModifiers = shortcutModifiers
        self.nodeBinaryPath = nodeBinaryPath
        self.debugLogging = debugLogging
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        shortcutKey = try container.decodeIfPresent(String.self, forKey: .shortcutKey) ?? "c"
        shortcutModifiers = try container.decodeIfPresent([String].self, forKey: .shortcutModifiers) ?? ["command", "shift"]
        nodeBinaryPath = try container.decode(String.self, forKey: .nodeBinaryPath)
        debugLogging = try container.decodeIfPresent(Bool.self, forKey: .debugLogging) ?? true
    }
}

@Observable
final class ConfigManager {
    private(set) var config: AppConfig

    private static let environment = ProcessInfo.processInfo.environment
    private static let homeDirectory = FileManager.default.homeDirectoryForCurrentUser
    private static let sourceDefaultsDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("shared", isDirectory: true)

    static let configDir = baseDirectory(environmentKey: "XDG_CONFIG_HOME", fallback: ".config")
        .appendingPathComponent("word-fixer", isDirectory: true)
    static let dataDir = baseDirectory(environmentKey: "XDG_DATA_HOME", fallback: ".local/share")
        .appendingPathComponent("word-fixer", isDirectory: true)
    static let configFile = configDir.appendingPathComponent("config.json")
    static let piDir = configDir.appendingPathComponent(".pi", isDirectory: true)
    static let systemPromptFile = piDir.appendingPathComponent("SYSTEM.md")
    static let naturalPromptFile = piDir.appendingPathComponent("NATURAL.md")
    static let feedbackPromptFile = piDir.appendingPathComponent("FEEDBACK.md")
    static let settingsFile = piDir.appendingPathComponent("settings.json")
    static let helperStateFile = dataDir.appendingPathComponent("helper.json")

    init() {
        if let data = try? Data(contentsOf: Self.configFile),
           let loaded = try? JSONDecoder().decode(AppConfig.self, from: data) {
            let migrated = Self.validated(loaded)
            self.config = migrated
            DebugLog.isEnabled = migrated.debugLogging
            Self.ensureSupportFiles()
            Self.persist(migrated)
            print("Config loaded from: \(Self.configFile.path)")
            print("Pi dir: \(Self.piDir.path)")
        } else {
            let defaultConfig = Self.makeDefaultConfig()
            self.config = defaultConfig
            DebugLog.isEnabled = defaultConfig.debugLogging
            Self.ensureSupportFiles()
            Self.persist(defaultConfig)
            print("Config bootstrapped at: \(Self.configFile.path)")
            print("Pi dir: \(Self.piDir.path)")
        }
    }

    private static func baseDirectory(environmentKey: String, fallback: String) -> URL {
        if let path = environment[environmentKey], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return homeDirectory.appendingPathComponent(fallback, isDirectory: true)
    }

    private static func makeDefaultConfig() -> AppConfig {
        AppConfig(
            shortcutKey: "c",
            shortcutModifiers: ["command", "shift"],
            nodeBinaryPath: detectNodeBinaryPath() ?? "",
            debugLogging: true
        )
    }

    private static func validated(_ config: AppConfig) -> AppConfig {
        var updated = config
        if !FileManager.default.isExecutableFile(atPath: updated.nodeBinaryPath),
           let detectedNodeBinaryPath = detectNodeBinaryPath() {
            updated.nodeBinaryPath = detectedNodeBinaryPath
        }
        return updated
    }

    private static func detectNodeBinaryPath() -> String? {
        let pathEntries = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)

        for entry in pathEntries where !entry.isEmpty {
            let candidate = URL(fileURLWithPath: entry).appendingPathComponent("node").path
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private static func ensureSupportFiles() {
        let fileManager = FileManager.default
        try? fileManager.createDirectory(at: piDir, withIntermediateDirectories: true)
        try? fileManager.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let files = [
            ("prompts/SYSTEM.md", systemPromptFile),
            ("prompts/NATURAL.md", naturalPromptFile),
            ("prompts/FEEDBACK.md", feedbackPromptFile),
            ("settings.json", settingsFile),
        ]
        for (relativeSourcePath, destination) in files where !fileManager.fileExists(atPath: destination.path) {
            guard let source = defaultFile(relativePath: relativeSourcePath) else {
                DebugLog.write("Missing bundled default: \(relativeSourcePath)")
                continue
            }
            try? fileManager.copyItem(at: source, to: destination)
        }
    }

    private static func defaultFile(relativePath: String) -> URL? {
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("defaults").appendingPathComponent(relativePath),
            sourceDefaultsDir.appendingPathComponent(relativePath),
        ].compactMap { $0 }
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func persist(_ config: AppConfig) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(config) else { return }
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        try? data.write(to: configFile, options: .atomic)
    }
}
