// pv-touchid — Touch ID-protected secrets for PassVault, without Apple
// entitlements.
//
// The data-protection Keychain can tie an item to Touch ID only for signed
// builds with a keychain-access-groups entitlement (see the helper's
// internal/keychain). This tool gives unsigned builds the same guarantee from
// the Secure Enclave directly (CryptoKit, public API, no entitlement):
//
//   wrap:   a new Secure Enclave P-256 key whose use requires a current
//           Touch ID match (.biometryCurrentSet; device passcode set, this
//           device only). An ephemeral P-256 key agrees with its public key,
//           HKDF-SHA256 derives an AES-256-GCM key, the secret is sealed. The
//           file keeps the enclave key's wrapped blob (usable only by this
//           Mac's Secure Enclave), the ephemeral public key and the box.
//   unwrap: Touch ID, then the enclave performs the key agreement and the box
//           is opened. Without the fingerprint the enclave refuses; the file
//           alone is worthless. Changing enrolled fingerprints invalidates it.
//
// Two ways in, each with its own namespace so one caller can never read
// another's secrets:
//   pv-touchid --helper                 one JSON request on stdin (PassVault's
//                                       desktop helper; namespace "desktop")
//   pv-touchid chrome-extension://<id>/ Chrome native messaging (namespace =
//                                       the calling extension's origin, which
//                                       Chrome passes and enforces)
//
// Files: ~/Library/Application Support/PassVault/touchid/<sha256>.json (0600).

import CryptoKit
import Foundation
import LocalAuthentication

let hostName = "io.passvault.touchid"
let maxMessage = 64 * 1024

struct Failure: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) -> Failure { Failure(code: code, message: message) }

// ---------------------------------------------------------------- storage

let storeDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/PassVault/touchid", isDirectory: true)

func recordURL(_ ns: String, _ account: String) -> URL {
    let digest = SHA256.hash(data: Data((ns + "\u{0}" + account).utf8))
    return storeDir.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined() + ".json")
}

struct Record: Codable {
    var v: Int
    var key: String  // Secure Enclave key, wrapped by the enclave (base64)
    var eph: String  // ephemeral public key, X9.63 (base64)
    var box: String  // AES-GCM combined nonce|ciphertext|tag (base64)
}

func validAccount(_ a: String) -> Bool {
    a.count >= 1 && a.count <= 160 && a.range(of: "^[A-Za-z0-9._:@-]+$", options: .regularExpression) != nil
}

func boxKey(_ shared: SharedSecret, _ ns: String, _ account: String) -> SymmetricKey {
    shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("PassVault pv-touchid v1".utf8),
                                   sharedInfo: Data((ns + "\u{0}" + account).utf8), outputByteCount: 32)
}

// ---------------------------------------------------------------- Touch ID

func biometricStatus() -> (Bool, String?) {
    guard SecureEnclave.isAvailable else { return (false, "this Mac has no Secure Enclave") }
    let ctx = LAContext()
    var err: NSError?
    if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) { return (true, nil) }
    switch LAError.Code(rawValue: err?.code ?? 0) {
    case .passcodeNotSet: return (false, "no device passcode is set")
    case .biometryNotEnrolled: return (false, "no fingerprints are enrolled")
    case .biometryLockout: return (false, "Touch ID is locked out; unlock with your password first")
    default: return (false, "Touch ID is not available on this Mac")
    }
}

/// Shows the system Touch ID prompt. The evaluated context is then handed to
/// the Secure Enclave, which itself checks it before using the key.
func authenticate(_ reason: String) throws -> LAContext {
    let ctx = LAContext()
    ctx.localizedCancelTitle = "Use Master Password"
    let done = DispatchSemaphore(value: 0)
    var result: Result<Void, Error> = .failure(fail("denied", "Touch ID did not complete"))
    ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
        result = ok ? .success(()) : .failure(err ?? fail("denied", "Touch ID failed"))
        done.signal()
    }
    done.wait()
    switch result {
    case .success: return ctx
    case .failure(let e as LAError):
        switch e.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback, .authenticationFailed:
            throw fail("denied", "Touch ID was cancelled or did not match")
        default:
            throw fail("unavailable", "Touch ID is not available (\(e.code.rawValue))")
        }
    case .failure(let e): throw e
    }
}

// ---------------------------------------------------------------- operations

func wrap(_ ns: String, _ account: String, _ secret: Data) throws {
    guard validAccount(account) else { throw fail("bad_request", "invalid account") }
    guard !secret.isEmpty, secret.count <= 4096 else { throw fail("bad_request", "invalid secret") }
    let (ok, reason) = biometricStatus()
    guard ok else { throw fail("unavailable", reason ?? "Touch ID is not available") }
    var cfErr: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                   [.privateKeyUsage, .biometryCurrentSet], &cfErr) else {
        throw fail("unavailable", "could not create the access control")
    }
    let enclave = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
    let eph = P256.KeyAgreement.PrivateKey()
    // Sealing needs only the enclave's public key: no prompt.
    let shared = try eph.sharedSecretFromKeyAgreement(with: enclave.publicKey)
    let aad = Data((ns + "\u{0}" + account).utf8)
    guard let box = try AES.GCM.seal(secret, using: boxKey(shared, ns, account), authenticating: aad).combined else {
        throw fail("io_error", "sealing failed")
    }
    let rec = Record(v: 1, key: enclave.dataRepresentation.base64EncodedString(),
                     eph: eph.publicKey.x963Representation.base64EncodedString(), box: box.base64EncodedString())
    try FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let url = recordURL(ns, account)
    let tmp = storeDir.appendingPathComponent(".tmp-\(UUID().uuidString)")
    let data = try JSONEncoder().encode(rec)
    guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
        throw fail("io_error", "could not write the Touch ID record")
    }
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
}

func unwrap(_ ns: String, _ account: String, _ reason: String) throws -> Data {
    guard validAccount(account) else { throw fail("bad_request", "invalid account") }
    let url = recordURL(ns, account)
    guard let raw = try? Data(contentsOf: url) else { throw fail("not_found", "Touch ID unlock is not set up") }
    guard let rec = try? JSONDecoder().decode(Record.self, from: raw), rec.v == 1,
          let keyBlob = Data(base64Encoded: rec.key), let ephRaw = Data(base64Encoded: rec.eph),
          let boxRaw = Data(base64Encoded: rec.box) else {
        throw fail("io_error", "the Touch ID record is damaged; set Touch ID up again")
    }
    let ctx = try authenticate(String(reason.prefix(160)))
    do {
        let enclave = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: keyBlob, authenticationContext: ctx)
        let shared = try enclave.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: ephRaw))
        let aad = Data((ns + "\u{0}" + account).utf8)
        return try AES.GCM.open(AES.GCM.SealedBox(combined: boxRaw), using: boxKey(shared, ns, account), authenticating: aad)
    } catch {
        // Typically: fingerprints were added or removed since setup (.biometryCurrentSet).
        throw fail("not_found", "Touch ID changed since setup; unlock with your master password and turn Touch ID on again")
    }
}

func remove(_ ns: String, _ account: String) throws {
    guard validAccount(account) else { throw fail("bad_request", "invalid account") }
    let url = recordURL(ns, account)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
}

// ---------------------------------------------------------------- browser registration

/// Native-messaging host manifests for Chromium browsers that exist on this Mac.
let browserDirs = [
    "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium",
    "BraveSoftware/Brave-Browser", "Microsoft Edge", "Vivaldi", "Arc/User Data",
]

func manifestURLs() -> [URL] {
    let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
    return browserDirs.compactMap { d in
        let dir = base.appendingPathComponent(d, isDirectory: true)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        return dir.appendingPathComponent("NativeMessagingHosts/\(hostName).json")
    }
}

func register(_ origins: [String]) throws -> [String] {
    let valid = origins.filter { $0.range(of: "^chrome-extension://[a-p]{32}/$", options: .regularExpression) != nil }
    guard !valid.isEmpty, valid.count == origins.count, valid.count <= 8 else { throw fail("bad_request", "invalid extension origins") }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    let manifest: [String: Any] = [
        "name": hostName, "description": "PassVault Touch ID unlock", "path": exe, "type": "stdio", "allowed_origins": valid,
    ]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    var done: [String] = []
    for url in manifestURLs() {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        done.append(url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent)
    }
    return done
}

func unregister() {
    for url in manifestURLs() { try? FileManager.default.removeItem(at: url) }
}

func registered() -> Bool {
    manifestURLs().contains { FileManager.default.fileExists(atPath: $0.path) }
}

// ---------------------------------------------------------------- requests

func handle(_ req: [String: Any], ns: String, helper: Bool) -> [String: Any] {
    let op = req["op"] as? String ?? ""
    let account = req["account"] as? String ?? ""
    do {
        switch op {
        case "status":
            let (ok, reason) = biometricStatus()
            var r: [String: Any] = ["ok": true, "available": ok]
            if let reason { r["reason"] = reason }
            if !account.isEmpty, validAccount(account) {
                r["enrolled"] = FileManager.default.fileExists(atPath: recordURL(ns, account).path)
            }
            if helper { r["registered"] = registered() }
            return r
        case "wrap", "enroll":
            guard let b64 = req["secretB64"] as? String, let secret = Data(base64Encoded: b64) else {
                throw fail("bad_request", "invalid secret")
            }
            try wrap(ns, account, secret)
            return ["ok": true]
        case "unwrap", "unlock":
            // The prompt text is fixed here, never taken from the caller: any program can start
            // this tool, so it must not be able to word the Touch ID prompt.
            let secret = try unwrap(ns, account, helper ? "unlock PassVault" : "unlock PassVault in your browser")
            return ["ok": true, "secretB64": secret.base64EncodedString()]
        case "delete", "remove":
            try remove(ns, account)
            return ["ok": true]
        case "register" where helper:
            let browsers = try register(req["origins"] as? [String] ?? [])
            return ["ok": true, "browsers": browsers]
        case "unregister" where helper:
            unregister()
            return ["ok": true]
        default:
            throw fail("bad_request", "unknown operation")
        }
    } catch let f as Failure {
        return ["ok": false, "code": f.code, "message": f.message]
    } catch {
        return ["ok": false, "code": "io_error", "message": "Touch ID operation failed"]
    }
}

func readExactly(_ n: Int) -> Data? {
    var out = Data()
    while out.count < n {
        let chunk = FileHandle.standardInput.readData(ofLength: n - out.count)
        if chunk.isEmpty { return nil }
        out.append(chunk)
    }
    return out
}

func writeMessage(_ obj: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var len = UInt32(body.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &len, count: 4))
    FileHandle.standardOutput.write(body)
}

let args = CommandLine.arguments
if args.count >= 2, args[1] == "--helper" {
    // One request from the desktop helper: JSON on stdin, JSON on stdout.
    let input = FileHandle.standardInput.readData(ofLength: maxMessage + 1)
    let req = (input.count <= maxMessage ? (try? JSONSerialization.jsonObject(with: input)) : nil) as? [String: Any]
    let res = req.map { handle($0, ns: "desktop", helper: true) } ?? ["ok": false, "code": "bad_request", "message": "invalid request"]
    if let out = try? JSONSerialization.data(withJSONObject: res) { FileHandle.standardOutput.write(out) }
    exit(0)
} else if args.count >= 2, args[1].range(of: "^chrome-extension://[a-p]{32}/$", options: .regularExpression) != nil {
    // Chrome native messaging: 4-byte little-endian length + JSON, both ways.
    let ns = args[1]
    while let head = readExactly(4) {
        let n = Int(head.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian })
        guard n > 0, n <= maxMessage, let body = readExactly(n),
              let req = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            writeMessage(["ok": false, "code": "bad_request", "message": "invalid message"])
            exit(1)
        }
        writeMessage(handle(req, ns: ns, helper: false))
    }
    exit(0)
} else {
    FileHandle.standardError.write(Data("pv-touchid: started by PassVault and its browser extension only\n".utf8))
    exit(2)
}
