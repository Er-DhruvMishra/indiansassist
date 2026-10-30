package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Contract section 13.1 "Ownership of names": the Kotlin constants equal the shared ones, read from
 * packages/shared/test/fixtures/agent/agent-names.json and file-lists.json (siblings of the sec vectors), the same
 * files the TypeScript and Rust tests assert.
 */
class NamesParityTest {
    private fun load(name: String): JsonObject {
        val dir = File(System.getProperty("ia.vectors") ?: "../../packages/shared/test/fixtures/agent/sec-vectors.json").parentFile
        return Wire.parseObject(File(dir, name).readText(Charsets.UTF_8)) ?: error("cannot parse $name")
    }

    private fun JsonObject.strings(key: String): List<String> = (this[key] as JsonArray).map { (it as JsonPrimitive).content }

    private val names by lazy { load("agent-names.json") }

    @Test
    fun secNamesMatchShared() {
        assertEquals(names.strings("p3DataChannelLabels"), Sec.P3_LABELS)
        assertEquals(names.strings("secEncryptedLabels").toSet(), Sec.ENCRYPTED_LABELS)
        assertEquals(names.strings("secFailReasons").toSet(), Sec.FAIL_REASONS)
        val ids = names["secLabelIds"] as JsonObject
        assertEquals(ids.mapValues { (it.value as JsonPrimitive).content.toInt() }, Sec.LABEL_IDS)
        val limits = names["limits"] as JsonObject
        assertEquals(limits.long("secFrameMaxBytes"), Sec.FRAME_MAX_BYTES.toLong())
        assertEquals(limits.long("secHandshakeTimeoutMs"), Sec.HANDSHAKE_TIMEOUT_MS)
        assertEquals(limits.long("fileMaxBytesNative"), FileReceiver.MAX_NATIVE_BYTES)
        assertEquals(limits.long("textBurstChars"), InputAudit.TEXT_BURST_CHARS.toLong())
    }

    @Test
    fun controlNamesMatchShared() {
        assertEquals(names.strings("agentConsentLevels"), AgentControl.LEVEL_ORDER.entries.sortedBy { it.value }.map { it.key })
        assertEquals(names.strings("qualityPresets").toSet(), AgentControl.QUALITY_PRESETS)
        assertEquals(names.strings("navActions").toSet(), AgentControl.NAV_ACTIONS)
        val min = names["agentMinLevels"] as JsonObject
        for ((op, level) in min) assertEquals(op, (level as JsonPrimitive).content, AgentControl.minLevelFor(op))
        assertEquals(names.long("wsCloseHandedOver"), DeskMachine.WS_HANDED_OVER.toLong())
    }

    @Test
    fun capabilitiesMatchShared() {
        assertEquals(names.strings("agentFeatures").toSet(), AgentCapabilities.AGENT_FEATURES)
        val android = names["androidCapabilities"] as JsonObject
        val ours = AgentCapabilities()
        assertEquals(android.strings("features"), ours.features)
        assertEquals(android.strings("encoders"), ours.encoders)
        assertEquals(android.strings("interpreters"), ours.interpreters)
        assertEquals(android.long("monitors"), ours.monitors.toLong())
        assertEquals(android.str("elevation"), ours.elevation)
    }

    @Test
    fun fileListsMatchShared() {
        val lists = load("file-lists.json")
        assertEquals(lists.strings("executableExtensions").toSet(), FileNames.EXECUTABLE_EXTENSIONS)
        assertEquals(lists.strings("passiveRiskExtensions").toSet(), FileNames.PASSIVE_RISK_EXTENSIONS)
    }
}
