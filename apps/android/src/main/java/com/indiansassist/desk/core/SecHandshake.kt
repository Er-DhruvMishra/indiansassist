package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonObject

/**
 * The section 1.3 `ia.sec` handshake for one peer connection and one key generation: commit first, hello only once
 * the peer's commit is held, commit and fingerprint checks, X25519 + HKDF-SHA256 key schedule, SAS, key
 * confirmation. Pure: the caller moves the JSON over `ia.sec` and runs step 9 on a [SecFailure].
 */
class SecHandshake(
    val sessionId: String,
    val gen: Int,
    val localSide: Side,
    private val localFpr: String,
    private val remoteFpr: String,
    private val clock: () -> Long = System::currentTimeMillis,
    esk: ByteArray? = null,
) {
    /** What to send after a step, and the keys once `established`. */
    class Step(val send: List<JsonObject>, val established: SecKeys? = null)

    private val esk: ByteArray = esk?.copyOf() ?: SecCrypto.generatePrivateKey()
    val epk: String = Bytes.b64u(SecCrypto.publicFromPrivate(this.esk))
    val commitH: String = commitHash(localSide, Sec.SUITE, epk, localFpr)
    private val peerSide = localSide.peer
    private var startedAt = -1L
    private var peerCommit: String? = null
    private var helloSent = false
    private var peerHelloSeen = false
    private var transcriptHash: ByteArray? = null
    private var kConf: ByteArray? = null
    private var pendingKeys: SecKeys? = null
    private var peerConfirmed = false
    var keys: SecKeys? = null
        private set

    val isEstablished: Boolean get() = keys != null

    /** On `ia.sec` open: send the commit (step 2a). */
    fun start(): List<JsonObject> {
        startedAt = clock()
        return listOf(obj("t" to "sec.commit", "v" to 1, "sessionId" to sessionId, "side" to localSide.wire, "h" to commitH, "gen" to gen, "ts" to clock()))
    }

    /** Step 8: throws `timeout` 10 s after [start] without `established`. */
    fun checkTimeout(now: Long = clock()) {
        if (!isEstablished && startedAt >= 0 && now - startedAt >= Sec.HANDSHAKE_TIMEOUT_MS) throw SecFailure("timeout")
    }

    /** Handles one inbound `ia.sec` message. A peer's `sec.fail` surfaces as a [SecFailure] with its reason. */
    fun receive(msg: JsonObject): Step = when (msg.str("t")) {
        "sec.commit" -> onCommit(msg)
        "sec.hello" -> onHello(msg)
        "sec.confirm" -> onConfirm(msg)
        "sec.fail" -> throw SecFailure(msg.str("reason")?.takeIf { it in Sec.FAIL_REASONS } ?: "commit", "peer sent sec.fail")
        else -> throw SecFailure("commit", "unexpected ia.sec message")
    }

    private fun onCommit(m: JsonObject): Step {
        if (peerCommit != null) throw SecFailure("commit", "second sec.commit")
        if (m.int("v") != 1 || m.str("sessionId") != sessionId || m.str("side") != peerSide.wire || m.int("gen") != gen) {
            throw SecFailure("commit", "commit for another session, side or generation")
        }
        val h = m.str("h") ?: throw SecFailure("commit", "missing h")
        if (Bytes.unb64u(h)?.size != 32) throw SecFailure("commit", "bad h")
        peerCommit = h
        return Step(sendHelloIfDue())
    }

    private fun sendHelloIfDue(): List<JsonObject> {
        if (helloSent || peerCommit == null) return emptyList()
        helloSent = true
        return listOf(obj("t" to "sec.hello", "v" to 1, "sessionId" to sessionId, "side" to localSide.wire, "suite" to Sec.SUITE, "epk" to epk, "fpr" to localFpr, "ts" to clock()))
    }

    private fun onHello(m: JsonObject): Step {
        val committed = peerCommit ?: throw SecFailure("commit", "sec.hello before sec.commit")
        if (peerHelloSeen) throw SecFailure("commit", "second sec.hello")
        peerHelloSeen = true
        val suite = m.str("suite")
        if (suite != Sec.SUITE || m.int("v") != 1) throw SecFailure("suite")
        if (m.str("sessionId") != sessionId || m.str("side") != peerSide.wire) throw SecFailure("commit", "hello for another session or side")
        val peerEpk = m.str("epk") ?: throw SecFailure("key")
        val peerFpr = m.str("fpr") ?: throw SecFailure("fingerprint")
        val peerPub = Bytes.unb64u(peerEpk)?.takeIf { it.size == 32 } ?: throw SecFailure("key")
        if (!Bytes.constantTimeEquals(commitHash(peerSide, suite, peerEpk, peerFpr), committed)) throw SecFailure("commit")
        if (!Bytes.constantTimeEquals(peerFpr, remoteFpr)) throw SecFailure("fingerprint")
        val ss = SecCrypto.sharedSecret(esk, peerPub) ?: throw SecFailure("key")
        val mine = Triple(commitH, epk, localFpr)
        val theirs = Triple(committed, peerEpk, peerFpr)
        val desk = if (localSide == Side.DESK) mine else theirs
        val assist = if (localSide == Side.DESK) theirs else mine
        val t = Bytes.sha256(Bytes.utf8(transcript(sessionId, gen, desk, assist)))
        val kD2A = SecCrypto.hkdf(ss, t, "ia-sec-v1 desk->assist", 32)
        val kA2D = SecCrypto.hkdf(ss, t, "ia-sec-v1 assist->desk", 32)
        val conf = SecCrypto.hkdf(ss, t, "ia-sec-v1 confirm", 32)
        val sas = sasFrom(SecCrypto.hkdf(ss, t, "ia-sec-v1 sas", 4))
        Bytes.zeroise(ss, esk)
        transcriptHash = t
        kConf = conf
        pendingKeys = SecKeys(sessionId, gen, kD2A, kA2D, sas, localSide)
        val confirm = obj("t" to "sec.confirm", "mac" to Bytes.b64u(confirmMac(conf, localSide, t)), "ts" to clock())
        return Step(listOf(confirm), finishIfDone())
    }

    private fun onConfirm(m: JsonObject): Step {
        val conf = kConf ?: throw SecFailure("mac", "sec.confirm before keys")
        if (peerConfirmed) throw SecFailure("mac", "second sec.confirm")
        val mac = m.str("mac")?.let { Bytes.unb64u(it) } ?: throw SecFailure("mac")
        if (!Bytes.constantTimeEquals(mac, confirmMac(conf, peerSide, transcriptHash!!))) throw SecFailure("mac")
        peerConfirmed = true
        return Step(emptyList(), finishIfDone())
    }

    private fun finishIfDone(): SecKeys? {
        val k = pendingKeys ?: return null
        if (!peerConfirmed) return null
        Bytes.zeroise(kConf)
        kConf = null
        keys = k
        return k
    }

    fun failMessage(reason: String): JsonObject = obj("t" to "sec.fail", "reason" to reason, "ts" to clock())

    companion object {
        /** `commitHash(side, suite, epk, fpr)` = base64url(sha256(canonicalJson({ side, suite, epk, fpr }))). */
        fun commitHash(side: Side, suite: String, epk: String, fpr: String): String =
            Bytes.b64u(Bytes.sha256(Bytes.utf8(CanonicalJson.encode(obj("side" to side.wire, "suite" to suite, "epk" to epk, "fpr" to fpr)))))

        /** The step 4 transcript (canonical JSON); `T` is its sha256. Triples are (h, epk, fpr). */
        fun transcript(sessionId: String, gen: Int, desk: Triple<String, String, String>, assist: Triple<String, String, String>): String =
            CanonicalJson.encode(
                obj(
                    "v" to 1, "sessionId" to sessionId, "suite" to Sec.SUITE, "gen" to gen,
                    "desk" to obj("h" to desk.first, "epk" to desk.second, "fpr" to desk.third),
                    "assist" to obj("h" to assist.first, "epk" to assist.second, "fpr" to assist.third),
                ),
            )

        fun confirmMac(kConf: ByteArray, side: Side, t: ByteArray): ByteArray = Bytes.hmacSha256(kConf, Bytes.concat(Bytes.utf8(side.wire), t))

        /** u32be(4 bytes) mod 1 000 000, zero-padded to six digits. */
        fun sasFrom(raw: ByteArray): String = (Bytes.u32be(raw) % 1_000_000L).toString().padStart(6, '0')
    }
}
