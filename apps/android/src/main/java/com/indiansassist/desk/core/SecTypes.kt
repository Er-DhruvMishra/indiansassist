package com.indiansassist.desk.core

/** Section 1.3 names shared by the handshake and the frame codec. */
object Sec {
    const val SUITE = "x25519-xchacha20poly1305-hkdfsha256"
    const val HANDSHAKE_TIMEOUT_MS = 10_000L
    const val FRAME_MAX_BYTES = 131_072
    const val HEADER_BYTES = 10
    const val TAG_BYTES = 16
    const val MAX_PLAINTEXT = FRAME_MAX_BYTES - HEADER_BYTES - TAG_BYTES

    /** `SEC_LABEL_IDS`: the nonce's label byte. */
    val LABEL_IDS: Map<String, Int> = linkedMapOf(
        "ia.control" to 1, "ia.file" to 2, "ia.playbook" to 3, "ia.chat" to 4, "ia.annot" to 5, "ia.ctrl" to 6,
    )

    /** `P3_DATA_CHANNEL_LABELS`, in creation order. */
    val P3_LABELS = listOf("ia.sec", "ia.chat", "ia.annot", "ia.file", "ia.ctrl", "ia.control", "ia.playbook")

    /** `SEC_ENCRYPTED_LABELS`: every label except `ia.sec`. */
    val ENCRYPTED_LABELS: Set<String> = LABEL_IDS.keys

    /** `SEC_FAIL_REASONS`. */
    val FAIL_REASONS = setOf("suite", "commit", "fingerprint", "key", "mac", "timeout", "replay", "decrypt", "oversize", "channel")
}

enum class Side(val wire: String) {
    DESK("desk"), ASSIST("assist");

    val peer: Side get() = if (this == DESK) ASSIST else DESK
}

enum class Direction(val byte: Int) { DESK_TO_ASSIST(0), ASSIST_TO_DESK(1) }

/** A section 1.3 failure; [reason] is one of [Sec.FAIL_REASONS]. */
class SecFailure(val reason: String, message: String = reason) : Exception(message) {
    init {
        require(reason in Sec.FAIL_REASONS) { "unknown sec.fail reason $reason" }
    }
}

/**
 * The per-generation keys of one peer connection. [channel] hands out exactly one [SecChannel] per label: a second
 * one under the same keys would restart `seq` at 0 (section 1.3 "refuses to start at seq 0 twice").
 */
class SecKeys(val sessionId: String, val gen: Int, val kD2A: ByteArray, val kA2D: ByteArray, val sas: String, val localSide: Side) {
    private val opened = HashSet<String>()

    @Synchronized
    fun channel(label: String): SecChannel {
        require(label in Sec.ENCRYPTED_LABELS) { "not an encrypted label: $label" }
        check(opened.add(label)) { "a SecChannel for $label already started at seq 0 under generation $gen" }
        return SecChannel(this, label)
    }

    fun zeroise() = Bytes.zeroise(kD2A, kA2D)

    /** "483 920" (section 1.3 step 5). */
    val sasDisplay: String get() = "${sas.substring(0, 3)} ${sas.substring(3)}"
}
