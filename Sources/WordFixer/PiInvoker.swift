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

struct PiInvocationResult {
    let correction: String
    let natural: String
    let feedback: String
    let cost: Double?
}

actor PiInvoker {
    private let helperClient = PiHelperClient()

    func prewarm(config: AppConfig) async {
        await helperClient.prewarm(config: config)
    }

    func invoke(text: String, config: AppConfig) async throws -> PiInvocationResult {
        DebugLog.write("PiInvoker.invoke start inputLength=\(text.count)")
        let result = try await helperClient.review(text: text, config: config)
        let costDescription = result.cost.map { String($0) } ?? "nil"
        DebugLog.write("PiInvoker.invoke success correctionLength=\(result.correction.count) naturalLength=\(result.natural.count) feedbackLength=\(result.feedback.count) cost=\(costDescription)")
        return result
    }
}
