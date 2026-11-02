import CryptoKit
import Foundation

/// XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha) on CryptoKit's ChaChaPoly: HChaCha20 derives a subkey from the
/// first 16 nonce bytes, the IETF nonce is four zero bytes followed by the last 8.
enum XChaCha20Poly1305 {
    /// Returns ciphertext || 16-byte tag.
    static func seal(key: Data, nonce: Data, aad: Data, plaintext: Data) throws -> Data {
        let (subkey, n) = try split(key: key, nonce: nonce)
        let box = try ChaChaPoly.seal(plaintext, using: subkey, nonce: n, authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func open(key: Data, nonce: Data, aad: Data, sealed: Data) throws -> Data {
        guard sealed.count >= 16 else { throw CryptoKitError.authenticationFailure }
        let (subkey, n) = try split(key: key, nonce: nonce)
        let ct = sealed.prefix(sealed.count - 16)
        let tag = sealed.suffix(16)
        let box = try ChaChaPoly.SealedBox(nonce: n, ciphertext: ct, tag: tag)
        return try ChaChaPoly.open(box, using: subkey, authenticating: aad)
    }

    private static func split(key: Data, nonce: Data) throws -> (SymmetricKey, ChaChaPoly.Nonce) {
        precondition(key.count == 32 && nonce.count == 24)
        let sub = hchacha20(key: [UInt8](key), nonce16: [UInt8](nonce.prefix(16)))
        let n = try ChaChaPoly.Nonce(data: Data([0, 0, 0, 0]) + nonce.suffix(8))
        return (SymmetricKey(data: Data(sub)), n)
    }

    static func hchacha20(key: [UInt8], nonce16: [UInt8]) -> [UInt8] {
        func le(_ b: [UInt8], _ i: Int) -> UInt32 {
            UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
        }
        var s: [UInt32] = [0x6170_7865, 0x3320_646E, 0x7962_2D32, 0x6B20_6574]
        for i in 0..<8 { s.append(le(key, i * 4)) }
        for i in 0..<4 { s.append(le(nonce16, i * 4)) }
        func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
            s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = s[d] << 16 | s[d] >> 16
            s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = s[b] << 12 | s[b] >> 20
            s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = s[d] << 8 | s[d] >> 24
            s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = s[b] << 7 | s[b] >> 25
        }
        for _ in 0..<10 {
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        }
        var out: [UInt8] = []
        for w in [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]] {
            out += [UInt8(w & 0xFF), UInt8(w >> 8 & 0xFF), UInt8(w >> 16 & 0xFF), UInt8(w >> 24)]
        }
        return out
    }
}
