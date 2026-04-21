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
        let command = "'\(binaryPath)' --no-tools -p '\(escaped)'"

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

        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                try process.run()
                // Read pipes BEFORE waitUntilExit to avoid deadlock on large output
                let outData = stdout.fileHandleForReading.readDataToEndOfFile()
                let errData = stderr.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()

                guard process.terminationStatus == 0 else {
                    let errStr = String(data: errData, encoding: .utf8) ?? "Unknown error"
                    throw PiError.executionFailed(errStr)
                }

                return String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            }

            group.addTask {
                try await Task.sleep(for: .seconds(30))
                throw PiError.timeout
            }

            defer {
                group.cancelAll()
                if process.isRunning { process.terminate() }
            }
            return try await group.next()!
        }
    }
}
