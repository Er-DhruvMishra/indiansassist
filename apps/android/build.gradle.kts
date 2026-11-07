// IndiansAssist Android host (Phase C contracts section 12). Single Gradle module, application id
// com.indiansassist.desk, min SDK 29. Every dependency below is listed with its licence in docs/LICENSE-REGISTER.md.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application") version "9.0.1"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.20"
}

// Compiled region origins (contracts section 2.1): the app joins only through these. Debug builds add the
// emulator's view of the host (10.0.2.2) so `pnpm dev` works; release builds carry production origins only.
val releaseOrigins = "https://in.indiansassist.example"
// `IA_DEV_API` (env) or `-PiaDevApi=` moves the debug build's default api, e.g. http://localhost:4300 behind
// `adb reverse tcp:4300 tcp:4300` for the live emulator e2e (tools/android-e2e.mjs); it joins the debug origins.
val devApi = ((findProperty("iaDevApi") as String?) ?: System.getenv("IA_DEV_API") ?: "http://10.0.2.2:4000").trimEnd('/')
val debugOrigins = listOf(devApi, "http://10.0.2.2:4000", "http://localhost:4000", "https://in.indiansassist.example").distinct().joinToString(",")

// Release signing (docs/release.md section 4.5). The keystore and its passwords never enter the repository: they come
// from apps/android/keystore.properties (git-ignored; see keystore.properties.example) or from the environment
// (IA_ANDROID_KEYSTORE, IA_ANDROID_KEYSTORE_PASSWORD, IA_ANDROID_KEY_ALIAS, IA_ANDROID_KEY_PASSWORD). Without them the
// release APK is built unsigned, as before; debug builds keep the debug key.
val signingProps = java.util.Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(prop: String, env: String): String? =
    (signingProps.getProperty(prop) ?: System.getenv(env))?.takeIf { it.isNotBlank() }
val releaseStoreFile = signingValue("storeFile", "IA_ANDROID_KEYSTORE")
val releaseStorePassword = signingValue("storePassword", "IA_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "IA_ANDROID_KEY_ALIAS") ?: "indiansassist"
val releaseKeyPassword = signingValue("keyPassword", "IA_ANDROID_KEY_PASSWORD") ?: releaseStorePassword

android {
    namespace = "com.indiansassist.desk"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.indiansassist.desk"
        minSdk = 29
        targetSdk = 36
        versionCode = 300
        versionName = "0.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // One universal APK (section 2.6): phones, old 32-bit phones and the x86_64 emulator.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        buildConfigField("String", "WEB_HOST", "\"in.indiansassist.example\"")
        // Instrumented smoke (section 15.3) is gated on IA_EMULATOR=1, passed through as a runner argument.
        testInstrumentationRunnerArguments["IA_EMULATOR"] = System.getenv("IA_EMULATOR") ?: "0"
        testInstrumentationRunnerArguments["IA_TOKEN"] = System.getenv("IA_TOKEN") ?: ""
    }

    signingConfigs {
        if (releaseStoreFile != null && releaseStorePassword != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "REGION_ORIGINS", "\"$debugOrigins\"")
            buildConfigField("String", "DEFAULT_API_ORIGIN", "\"$devApi\"")
            buildConfigField("boolean", "DEV", "true")
            manifestPlaceholders["cleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "REGION_ORIGINS", "\"$releaseOrigins\"")
            buildConfigField("String", "DEFAULT_API_ORIGIN", "\"https://in.indiansassist.example\"")
            buildConfigField("boolean", "DEV", "false")
            manifestPlaceholders["cleartext"] = "false"
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += listOf("META-INF/*.kotlin_module", "META-INF/versions/**", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            // Cross-language vectors (packages/shared/test/fixtures/agent/sec-vectors.json) are read from the repository, never copied.
            it.systemProperty("ia.vectors", rootProject.file("../../packages/shared/test/fixtures/agent/sec-vectors.json").absolutePath)
            it.systemProperty("ia.sharedFixtures", rootProject.file("../../packages/shared/test/fixtures/agent").absolutePath)
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("io.getstream:stream-webrtc-android:1.3.10")
    implementation("com.google.crypto.tink:tink-android:1.18.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Phase F section 7.8 (Give help): Custom Tabs, Apache-2.0 (Google Maven POM, 2 Nov 2026).
    implementation("androidx.browser:browser:1.10.0")

    testImplementation("junit:junit:4.13.2")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
