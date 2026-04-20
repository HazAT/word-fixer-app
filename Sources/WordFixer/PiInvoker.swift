import Foundation

enum PiError: Error, LocalizedError {
    case binaryNotFound(String)
    case executionFailed(String)
    case timeout

    var errorDescription: String? {
        switch self {
        case .binaryNotFound(let path):
            return "Pi binary not found at: \(path). Check config.json."
        case .executionFailed(let stderr):
            return "Pi error: \(stderr)"
        case .timeout:
            return "Pi took too long to respond (30s timeout)."
        }
    }
}

final class PiInvoker {
    func invoke(text: String, config: AppConfig) async throws -> String {
        let binaryPath = config.piBinaryPath
        guard FileManager.default.fileExists(atPath: binaryPath) else {
            throw PiError.binaryNotFound(binaryPath)
        }

        let piDir = ConfigManager.piDir.path
        let escaped = text.replacingOccurrences(of: "'", with: "'\\''")
        let command = "'\(binaryPath)' -p '\(escaped)'"

        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/zsh")
                process.arguments = ["-c", command]
                process.environment = [
                    "PI_CODING_AGENT_DIR": piDir,
                    "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
                    "HOME": ProcessInfo.processInfo.environment["HOME"] ?? ""
                ]

                let stdout = Pipe()
                let stderr = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr

                try process.run()
                process.waitUntilExit()

                let outData = stdout.fileHandleForReading.readDataToEndOfFile()
                let errData = stderr.fileHandleForReading.readDataToEndOfFile()

                guard process.terminationStatus == 0 else {
                    let errStr = String(data: errData, encoding: .utf8) ?? "Unknown error"
                    throw PiError.executionFailed(errStr)
                }

                let result = String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return result
            }

            group.addTask {
                try await Task.sleep(for: .seconds(30))
                throw PiError.timeout
            }

            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}
