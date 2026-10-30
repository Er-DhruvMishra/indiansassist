package com.indiansassist.desk.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/** JSON configuration and small builders shared by the signaling and data-channel codecs. */
object Wire {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    fun parseObject(text: String): JsonObject? = try {
        json.parseToJsonElement(text) as? JsonObject
    } catch (_: Exception) {
        null
    }

    fun encode(o: JsonObject): String = o.toString()
}

/** Builds a JsonObject; `null` values are dropped (camelCase wire keys, no `undefined`). */
fun obj(vararg pairs: Pair<String, Any?>): JsonObject =
    JsonObject(pairs.mapNotNull { (k, v) -> if (v == null) null else k to toJson(v) }.toMap())

fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Int -> JsonPrimitive(v)
    is Long -> JsonPrimitive(v)
    is Double -> JsonPrimitive(v)
    is Float -> JsonPrimitive(v)
    is Map<*, *> -> JsonObject(v.entries.mapNotNull { (k, x) -> if (x == null) null else k.toString() to toJson(x) }.toMap())
    is Iterable<*> -> JsonArray(v.map { toJson(it) })
    is Array<*> -> JsonArray(v.map { toJson(it) })
    is IntArray -> JsonArray(v.map { JsonPrimitive(it) })
    else -> throw IllegalArgumentException("unsupported JSON value ${v::class}")
}

fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
fun JsonObject.objOrNull(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
