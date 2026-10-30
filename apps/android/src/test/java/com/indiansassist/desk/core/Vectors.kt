package com.indiansassist.desk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.io.File

/** Loads packages/shared/test/fixtures/agent/sec-vectors.json (path from the `ia.vectors` system property set in build.gradle.kts). */
object Vectors {
    val root: JsonObject by lazy {
        val path = System.getProperty("ia.vectors") ?: "../../packages/shared/test/fixtures/agent/sec-vectors.json"
        Wire.parseObject(File(path).readText(Charsets.UTF_8)) ?: error("cannot parse $path")
    }

    fun list(key: String): List<JsonObject> = (root[key] as JsonArray).map { it as JsonObject }

    fun handshake(name: String): JsonObject = list("handshakes").first { it.str("name") == name }
}
