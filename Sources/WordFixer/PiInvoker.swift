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

actor PiInvoker {
    private let helperClient = PiHelperClient()

    func prewarm(config: AppConfig) async {
        await helperClient.prewarm(config: config)
    }

    func invoke(text: String, config: AppConfig) async throws -> String {
        DebugLog.write("PiInvoker.invoke start inputLength=\(text.count)")
        let output = try await helperClient.fix(text: text, config: config)
        DebugLog.write("PiInvoker.invoke success outputLength=\(output.count)")
        return output
    }
}
