import Foundation

enum DebugLog {
    static var isEnabled = true

    private static let logFile = ConfigManager.configDir.appendingPathComponent("debug.log")
    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let queue = DispatchQueue(label: "wordfixer.debuglog")

    static func write(_ message: String) {
        guard isEnabled else { return }

        let line = "[\(formatter.string(from: Date()))] \(message)\n"
        fputs(line, stderr)

        queue.async {
            try? FileManager.default.createDirectory(at: ConfigManager.configDir, withIntermediateDirectories: true)
            let data = Data(line.utf8)
            if FileManager.default.fileExists(atPath: logFile.path) {
                if let handle = try? FileHandle(forWritingTo: logFile) {
                    defer { try? handle.close() }
                    _ = try? handle.seekToEnd()
                    try? handle.write(contentsOf: data)
                }
            } else {
                try? data.write(to: logFile)
            }
        }
    }
}
