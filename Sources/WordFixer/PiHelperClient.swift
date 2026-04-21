import Foundation

actor PiHelperClient {
    struct HelperState: Decodable {
        let pid: Int32
        let port: Int
    }

    private let startupTimeout: Duration = .seconds(5)
    private let requestTimeout: Duration = .seconds(30)
    private var helperProcess: Process?
    private var helperState: HelperState?
    private var helperBinaryPath: String?

    func prewarm(config: AppConfig) async {
        do {
            _ = try await ensureRunning(config: config)
        } catch {
            DebugLog.write("PiHelperClient.prewarm failed error=\(error.localizedDescription)")
        }
    }

    func fix(text: String, config: AppConfig) async throws -> PiInvocationResult {
        let state = try await ensureRunning(config: config)
        let url = URL(string: "http://127.0.0.1:\(state.port)/fix")!
        let response = try await post(url: url, body: ["text": text], timeout: requestTimeout)
        guard response.ok else {
            throw PiError.executionFailed(response.error ?? "Unknown helper error")
        }
        guard let output = response.text else {
            throw PiError.executionFailed("Helper returned no corrected text.")
        }
        return PiInvocationResult(text: output, cost: response.cost)
    }

    func shutdown() async {
        guard let state = helperState else {
            stopRememberingHelper()
            return
        }

        do {
            let url = URL(string: "http://127.0.0.1:\(state.port)/shutdown")!
            _ = try await post(url: url, body: [:], timeout: .seconds(2))
        } catch {
            DebugLog.write("PiHelperClient.shutdown request failed error=\(error.localizedDescription)")
        }

        helperProcess?.terminate()
        stopRememberingHelper()
    }

    private func ensureRunning(config: AppConfig) async throws -> HelperState {
        if let state = helperState,
           helperBinaryPath == config.piBinaryPath,
           try await isHealthy(state: state) {
            return state
        }

        if helperBinaryPath != nil, helperBinaryPath != config.piBinaryPath {
            await shutdown()
        }

        if let discovered = try await readHelperState(),
           try await isHealthy(state: discovered) {
            helperState = discovered
            helperBinaryPath = config.piBinaryPath
            DebugLog.write("PiHelperClient.ensureRunning reusing helper pid=\(discovered.pid) port=\(discovered.port)")
            return discovered
        }

        try launchHelper(config: config)
        let state = try await waitForHealthyHelper()
        helperState = state
        helperBinaryPath = config.piBinaryPath
        return state
    }

    private func launchHelper(config: AppConfig) throws {
        let nodePath = try resolveNodePath(config: config)
        let helperScript = try resolveHelperScriptPath()

        try? FileManager.default.removeItem(at: ConfigManager.helperStateFile)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [helperScript]
        process.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

        var environment = ProcessInfo.processInfo.environment
        environment["WORD_FIXER_CONFIG_DIR"] = ConfigManager.configDir.path
        environment["WORD_FIXER_DEBUG"] = config.debugLogging ? "1" : "0"
        environment["WORD_FIXER_HELPER_CWD"] = FileManager.default.currentDirectoryPath
        environment["PATH"] = URL(fileURLWithPath: config.piBinaryPath).deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        process.environment = environment

        if config.debugLogging {
            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            pipeOutput(stdout.fileHandleForReading, prefix: "[helper stdout]")
            pipeOutput(stderr.fileHandleForReading, prefix: "[helper stderr]")
        }

        try process.run()
        helperProcess = process
        DebugLog.write("PiHelperClient.launchHelper pid=\(process.processIdentifier) node=\(nodePath) script=\(helperScript)")
    }

    private func waitForHealthyHelper() async throws -> HelperState {
        let deadline = ContinuousClock.now + startupTimeout

        while ContinuousClock.now < deadline {
            if let state = try await readHelperState(),
               try await isHealthy(state: state) {
                DebugLog.write("PiHelperClient.waitForHealthyHelper ready pid=\(state.pid) port=\(state.port)")
                return state
            }

            if let process = helperProcess, !process.isRunning {
                throw PiError.executionFailed("Helper exited during startup.")
            }

            try await Task.sleep(for: .milliseconds(100))
        }

        throw PiError.executionFailed("Helper failed to become ready.")
    }

    private func resolveNodePath(config: AppConfig) throws -> String {
        let piURL = URL(fileURLWithPath: config.piBinaryPath)
        let candidate = piURL.deletingLastPathComponent().appendingPathComponent("node").path
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        throw PiError.binaryNotFound(candidate)
    }

    private func resolveHelperScriptPath() throws -> String {
        let candidates: [String] = [
            Bundle.main.resourceURL?.appendingPathComponent("helper/word-fixer-helper.mjs").path,
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/helper/word-fixer-helper.mjs").path,
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("helper/word-fixer-helper.mjs").path,
        ].compactMap { $0 }

        for path in candidates where FileManager.default.fileExists(atPath: path) {
            return path
        }

        throw PiError.binaryNotFound(candidates.first ?? "helper/word-fixer-helper.mjs")
    }

    private func readHelperState() async throws -> HelperState? {
        guard FileManager.default.fileExists(atPath: ConfigManager.helperStateFile.path) else {
            return nil
        }
        let data = try Data(contentsOf: ConfigManager.helperStateFile)
        return try JSONDecoder().decode(HelperState.self, from: data)
    }

    private func isHealthy(state: HelperState) async throws -> Bool {
        let url = URL(string: "http://127.0.0.1:\(state.port)/health")!
        do {
            let response = try await post(url: url, body: [:], timeout: .seconds(2))
            return response.ok && response.ready == true
        } catch {
            return false
        }
    }

    private func post(url: URL, body: [String: String], timeout: Duration) async throws -> HelperResponse {
        try await withThrowingTaskGroup(of: HelperResponse.self) { group in
            group.addTask {
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.timeoutInterval = timeout.timeInterval
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, _) = try await URLSession.shared.data(for: request)
                return try JSONDecoder().decode(HelperResponse.self, from: data)
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw PiError.timeout
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private func pipeOutput(_ handle: FileHandle, prefix: String) {
        handle.readabilityHandler = { fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else {
                fileHandle.readabilityHandler = nil
                return
            }
            guard let string = String(data: data, encoding: .utf8) else {
                return
            }
            for line in string.split(whereSeparator: { $0.isNewline }) {
                DebugLog.write("\(prefix) \(line)")
            }
        }
    }

    private func stopRememberingHelper() {
        helperProcess?.terminate()
        helperProcess = nil
        helperState = nil
        helperBinaryPath = nil
    }
}

private struct HelperResponse: Decodable {
    let ok: Bool
    let ready: Bool?
    let pid: Int32?
    let text: String?
    let cost: Double?
    let error: String?
}

private extension Duration {
    var timeInterval: TimeInterval {
        let components = self.components
        return TimeInterval(components.seconds) + TimeInterval(components.attoseconds) / 1_000_000_000_000_000_000
    }
}
