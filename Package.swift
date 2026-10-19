// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TeleDesk",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "TeleDesk", targets: ["TeleDesk"]),
    ],
    targets: [
        .target(name: "TeleDesk", path: "ios/Sources/TeleDesk"),
        .testTarget(name: "TeleDeskTests", dependencies: ["TeleDesk"], path: "ios/Tests/TeleDeskTests"),
    ]
)
