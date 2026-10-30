package com.indiansassist.desk.rtc

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpCapabilities
import org.webrtc.RtpSender
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Google's libwebrtc for Android (stream-webrtc-android, contracts section 1.2 c): one factory, the MediaProjection
 * screen track (`ScreenCapturerAndroid`, section 12.2) and the muted microphone track (section 6.3). Hardware
 * encoders come from `DefaultVideoEncoderFactory` (MediaCodec through `HardwareVideoEncoderFactory`, software VP8
 * fallback); VP8 is preferred, H.264 offered where present.
 */
class RtcEngine(private val context: Context) {
    val egl: EglBase = EglBase.create()
    val factory: PeerConnectionFactory
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    var videoTrack: VideoTrack? = null
        private set
    var audioTrack: AudioTrack? = null
        private set
    var width = 0
        private set
    var height = 0
        private set
    val hwEncoder: Boolean

    init {
        initialiseOnce(context)
        val enc = DefaultVideoEncoderFactory(egl.eglBaseContext, true, false)
        hwEncoder = enc.supportedCodecs.any { it.name.equals("H264", true) }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(enc)
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .setAudioDeviceModule(
                JavaAudioDeviceModule.builder(context).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true).createAudioDeviceModule(),
            )
            .createPeerConnectionFactory()
    }

    /**
     * Starts the screen capture from the MediaProjection consent result. Must run after the foreground service
     * started with the mediaProjection type (Android 14 ties the projection to it). [onStopped] fires when the
     * user stops casting from the system UI.
     */
    fun startCapture(projectionData: Intent, w: Int, h: Int, onStopped: () -> Unit) {
        width = w
        height = h
        val cap = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
            override fun onStop() = onStopped()
        })
        val src = factory.createVideoSource(true)
        val th = SurfaceTextureHelper.create("ia-capture", egl.eglBaseContext)
        cap.initialize(th, context, src.capturerObserver)
        cap.startCapture(w, h, 30)
        capturer = cap
        helper = th
        videoSource = src
        videoTrack = factory.createVideoTrack("monitor-1", src)
        audioSource = factory.createAudioSource(MediaConstraints())
        audioTrack = factory.createAudioTrack("mic-1", audioSource).apply { setEnabled(false) }
    }

    val capturedFrames: Long get() = capturer?.numCapturedFrames ?: 0

    /** Codec order for the video sender: VP8 first, then H.264, then the rest (section 12.2). */
    fun preferredVideoCodecs(): List<RtpCapabilities.CodecCapability> {
        val caps = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
        fun rank(c: RtpCapabilities.CodecCapability) = when (c.name.uppercase()) {
            "VP8" -> 0
            "H264" -> 1
            "RTX", "RED", "ULPFEC" -> 3
            else -> 2
        }
        return caps.sortedBy { rank(it) }
    }

    /** `os.quality` through `RtpParameters` encodings (section 4.3 ladder, Android form). */
    fun applyQuality(sender: RtpSender?, preset: String) {
        val s = sender ?: return
        val p = s.parameters
        for (e in p.encodings) {
            when (preset) {
                "floor" -> { e.maxBitrateBps = 250_000; e.maxFramerate = 5; e.scaleResolutionDownBy = 2.0 }
                "sharp" -> { e.maxBitrateBps = 2_500_000; e.maxFramerate = 15; e.scaleResolutionDownBy = 1.0 }
                "smooth" -> { e.maxBitrateBps = 2_500_000; e.maxFramerate = 30; e.scaleResolutionDownBy = 1.5 }
                else -> { e.maxBitrateBps = 2_500_000; e.maxFramerate = 30; e.scaleResolutionDownBy = 1.0 }
            }
        }
        s.parameters = p
    }

    /** Hard rule 2 for the media: stop the capture and every track, end the projection. */
    fun stopCapture() {
        try {
            capturer?.stopCapture()
        } catch (_: Exception) {
        }
        capturer?.dispose()
        capturer = null
        videoTrack?.dispose()
        videoTrack = null
        audioTrack?.dispose()
        audioTrack = null
        videoSource?.dispose()
        videoSource = null
        audioSource?.dispose()
        audioSource = null
        helper?.dispose()
        helper = null
    }

    fun dispose() {
        stopCapture()
        factory.dispose()
        egl.release()
    }

    companion object {
        @Volatile private var initialised = false

        @Synchronized
        fun initialiseOnce(context: Context) {
            if (initialised) return
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
            initialised = true
        }
    }
}
