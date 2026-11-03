// swift-tools-version:5.9
// Phase F §17.4: the library targets of the iOS app. `IASec` is the Phase C §1.3 `ia.sec` handshake and frame
// format ported to Swift (CryptoKit only), checked against `packages/shared/test/fixtures/agent/sec-vectors.json`,
// the same file the TypeScript, Rust and Kotlin tests load.
import PackageDescription

let package = Package(
    name: "IndiansAssistKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "IASec", targets: ["IASec"]),
        .library(name: "IASession", targets: ["IASession"]),
    ],
    targets: [
        .target(name: "IASec"),
        .testTarget(name: "IASecTests", dependencies: ["IASec"]),
        // The Desk session logic of the broadcast extension, unit-tested here because a broadcast cannot be driven
        // end to end on the simulator (A5).
        .target(name: "IASession", dependencies: ["IASec"]),
        .testTarget(name: "IASessionTests", dependencies: ["IASession", "IASec"]),
    ]
)
