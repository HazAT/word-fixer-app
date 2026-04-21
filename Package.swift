// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "WordFixer",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/soffes/HotKey", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "WordFixer",
            dependencies: [
                "HotKey",
            ],
            path: "Sources/WordFixer",
            resources: [.copy("../../Resources/Info.plist")]
        ),
    ]
)
