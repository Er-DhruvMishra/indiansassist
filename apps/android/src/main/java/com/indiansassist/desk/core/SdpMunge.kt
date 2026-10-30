package com.indiansassist.desk.core

/** Local SDP adjustments the host applies before `setLocalDescription` (contracts section 1.3 message-size interop). */
object SdpMunge {
    const val MAX_MESSAGE_SIZE = 131_072

    /**
     * Ensures the `m=application` section advertises `a=max-message-size:131072` (libwebrtc's Java API exposes no
     * SCTP message-size option, so the line is set in the offer the way webrtc-rs sets it through its SettingEngine).
     */
    fun withMaxMessageSize(sdp: String, size: Int = MAX_MESSAGE_SIZE): String {
        val eol = if (sdp.contains("\r\n")) "\r\n" else "\n"
        val lines = sdp.split(eol).toMutableList()
        val app = lines.indexOfFirst { it.startsWith("m=application") }
        if (app < 0) return sdp
        var end = (app + 1 until lines.size).firstOrNull { lines[it].startsWith("m=") } ?: lines.size
        if (end == lines.size && lines.last().isEmpty()) end = lines.size - 1
        val existing = (app + 1 until end).firstOrNull { lines[it].startsWith("a=max-message-size:") }
        if (existing != null) {
            lines[existing] = "a=max-message-size:$size"
        } else {
            val anchor = (app + 1 until end).firstOrNull { lines[it].startsWith("a=sctp-port:") } ?: (end - 1)
            lines.add(anchor + 1, "a=max-message-size:$size")
        }
        return lines.joinToString(eol)
    }

    /** True when the SDP carries a data channel section (A.2 N3: such a recorder offer is ignored). */
    fun hasApplication(sdp: String): Boolean = sdp.lineSequence().any { it.startsWith("m=application") }
}
