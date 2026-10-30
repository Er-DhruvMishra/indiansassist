package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Desk session state machine (A section 7.4 from the Desk, C sections 3.2, 3.7, 1.3 step 9, 12.3). */
class DeskMachineTest {
    private val client = DeskClient(version = "0.3.0", platform = ClientPlatform("14", "arm64"), tokenSource = "manual", capabilities = AgentCapabilities())
    private val m = DeskMachine(client, "Rahul")
    private val ice = listOf(obj("urls" to listOf("stun:stun.example:3478")))

    private fun srv(vararg p: Pair<String, Any?>) = m.handle(DeskEvent.Server(obj(*p)))

    private inline fun <reified T> List<DeskEffect>.one(): T = filterIsInstance<T>().single()

    private fun sent(effects: List<DeskEffect>) = effects.filterIsInstance<DeskEffect.Send>().map { it.msg }

    private fun toActive() {
        m.handle(DeskEvent.Start("ia1.x.y.z", "ws://10.0.2.2:4000/signal"))
        m.handle(DeskEvent.SocketOpen(false))
        srv("t" to "desk.hello.ok", "connectionId" to "c", "tokenId" to "t", "tier" to "p3_portable", "technician" to obj("name" to "Asha"), "org" to obj("displayName" to "Acme"), "region" to "in-mum")
        srv("t" to "knock.ok", "sessionId" to "s1", "resumeKey" to "rk", "expiresAt" to "x")
        srv("t" to "session.created", "sessionId" to "s1", "state" to "consent_pending", "consentState" to "pending", "assist" to obj("id" to "u", "name" to "Asha K"), "org" to obj("displayName" to "Acme"), "recordingMode" to "server")
        m.handle(DeskEvent.ConsentAccepted("control"))
        srv("t" to "consent.ok", "sessionId" to "s1", "state" to "active", "consentState" to "granted", "iceServers" to ice)
    }

    @Test
    fun happyPathToActive() {
        val start = m.handle(DeskEvent.Start("ia1.x.y.z", "ws://h/signal"))
        assertEquals(DeskEffect.Connect("ws://h/signal"), start.single())
        val hello = sent(m.handle(DeskEvent.SocketOpen(false))).single()
        assertEquals("desk.hello", hello.str("t"))
        assertEquals("native", hello.objOrNull("client")!!.str("kind"))
        assertEquals("android", hello.objOrNull("client")!!.str("os"))
        assertNull(hello["resumeKey"])
        val ok = srv("t" to "desk.hello.ok", "technician" to null, "org" to obj("displayName" to "Acme"))
        assertEquals("desk.knock", sent(ok).single().str("t"))
        assertTrue(DeskEffect.StartPolling in ok)
        assertEquals(DeskPhase.WAITING, m.phase)
        srv("t" to "knock.held", "technicianOnline" to false)
        assertEquals(DeskPhase.HELD, m.phase)
        assertTrue(DeskEffect.StopPolling in srv("t" to "knock.ok", "sessionId" to "s1", "resumeKey" to "rk"))
        val created = srv("t" to "session.created", "sessionId" to "s1", "state" to "consent_pending", "assist" to obj("name" to "Asha K"), "org" to obj("displayName" to "Acme"), "recordingMode" to "both")
        assertEquals(ConsentInfo("Asha K", "Acme", "both", null), created.one<DeskEffect.ShowConsent>().info)
        // A re-sent session.created never opens a second consent screen.
        assertTrue(srv("t" to "session.created", "sessionId" to "s1", "state" to "consent_pending").isEmpty())
        val consent = sent(m.handle(DeskEvent.ConsentAccepted("control"))).single()
        assertEquals("desk.consent", consent.str("t"))
        assertEquals("monitor", consent.str("surface"))
        assertEquals("control", consent.objOrNull("native")!!.str("level"))
        assertEquals(false, consent.objOrNull("native")!!.bool("clipboard"))
        val media = srv("t" to "consent.ok", "state" to "active", "iceServers" to ice).one<DeskEffect.StartMedia>()
        assertEquals("stun:stun.example:3478", media.ice.single().urls.single())
        assertEquals(DeskPhase.ACTIVE, m.phase)
        assertEquals("control", m.level)
    }

    @Test
    fun pingIsAnswered() {
        toActive()
        assertEquals("pong", sent(srv("t" to "ping")).single().str("t"))
    }

    @Test
    fun stopTearsDownBeforeSessionEnd() {
        toActive()
        val e = m.handle(DeskEvent.Stop)
        val iCtrl = e.indexOfFirst { it is DeskEffect.SendCtrl }
        val iTear = e.indexOf(DeskEffect.Teardown)
        val iEnd = e.indexOfFirst { it is DeskEffect.Send && it.msg.str("t") == "session.end" }
        assertTrue(iCtrl in 0 until iTear && iTear < iEnd)
        assertEquals("stop.sharing", (e[iCtrl] as DeskEffect.SendCtrl).msg.str("t"))
        assertTrue(DeskEffect.FlushOutbox in e)
        assertEquals(DeskPhase.ENDING, m.phase)
        val ended = srv("t" to "session.ended", "sessionId" to "s1", "endReason" to "desk_stopped", "hashChainTail" to "abc", "reachedActive" to true)
        assertEquals(EndInfo("desk_stopped", local = false, hashChainTail = "abc", reachedActive = true), ended.one<DeskEffect.Ended>().info)
        assertEquals(DeskPhase.ENDED, m.phase)
    }

    @Test
    fun localEndWhileSocketDownIsResentAfterHello() {
        toActive()
        m.handle(DeskEvent.SocketClosed(1006))
        val e = m.handle(DeskEvent.Stop)
        assertTrue(sent(e).isEmpty())
        assertTrue(DeskEffect.StartLocalEndTimer in e)
        val hello = sent(m.handle(DeskEvent.SocketOpen(true))).single()
        assertEquals("rk", hello.str("resumeKey"))
        val after = srv("t" to "desk.hello.ok", "resume" to obj("sessionId" to "s1", "state" to "active", "consentState" to "granted"))
        assertEquals("session.end", sent(after).single().str("t"))
        assertEquals(EndInfo("desk_stopped", local = true, reachedActive = true), m.handle(DeskEvent.LocalEndTimeout).one<DeskEffect.Ended>().info)
    }

    @Test
    fun nativeResumeKeepsActiveAndRebuildsOnIceRefresh() {
        toActive()
        m.handle(DeskEvent.SocketClosed(1006))
        m.handle(DeskEvent.SocketOpen(true))
        assertTrue(srv("t" to "desk.hello.ok", "resume" to obj("sessionId" to "s1", "state" to "active")).isEmpty())
        assertTrue(srv("t" to "session.created", "sessionId" to "s1", "state" to "active").isEmpty())
        assertEquals(DeskPhase.ACTIVE, m.phase)
        val rebuild = srv("t" to "ice.refresh", "sessionId" to "s1", "iceServers" to ice)
        assertTrue(rebuild.single() is DeskEffect.RebuildPeer)
        // A later refresh is only a refresh.
        assertTrue(srv("t" to "ice.refresh", "iceServers" to ice).single() is DeskEffect.RefreshIce)
        assertTrue(srv("t" to "assist.reconnected", "state" to "active", "iceServers" to ice).single() is DeskEffect.RebuildPeer)
    }

    @Test
    fun lostConsentOkStartsOnIceRefresh() {
        m.handle(DeskEvent.Start("t", "u")); m.handle(DeskEvent.SocketOpen(false))
        srv("t" to "desk.hello.ok"); srv("t" to "knock.ok", "sessionId" to "s1", "resumeKey" to "rk")
        srv("t" to "session.created", "sessionId" to "s1", "state" to "consent_pending")
        m.handle(DeskEvent.ConsentAccepted("view"))
        srv("t" to "session.created", "sessionId" to "s1", "state" to "active")
        assertTrue(srv("t" to "ice.refresh", "iceServers" to ice).single() is DeskEffect.StartMedia)
        assertEquals(DeskPhase.ACTIVE, m.phase)
        assertEquals("view", m.level)
    }

    @Test
    fun secFailureChainsThenEndsWithSecNote() {
        toActive()
        val e = m.handle(DeskEvent.SecFailed("mac"))
        val frames = sent(e)
        assertEquals("desk.event", frames[0].str("t"))
        assertEquals("sec.failed", frames[0].str("action"))
        assertEquals("mac", frames[0].objOrNull("data")!!.str("reason"))
        assertEquals("sec:mac", frames.last().str("note"))
        assertTrue(DeskEffect.Teardown in e)
    }

    @Test
    fun indicatorLostEndsWithNote() {
        toActive()
        val e = m.handle(DeskEvent.IndicatorLost)
        assertEquals("indicator_lost", sent(e).single().str("note"))
        assertTrue(e.none { it is DeskEffect.SendCtrl })
        assertTrue(e.indexOf(DeskEffect.Teardown) < e.indexOfFirst { it is DeskEffect.Send })
    }

    @Test
    fun declineAndRevoke() {
        m.handle(DeskEvent.Start("t", "u")); m.handle(DeskEvent.SocketOpen(false))
        srv("t" to "desk.hello.ok"); srv("t" to "knock.ok", "sessionId" to "s1", "resumeKey" to "rk")
        srv("t" to "session.created", "sessionId" to "s1", "state" to "consent_pending")
        val d = sent(m.handle(DeskEvent.ConsentDeclined)).single()
        assertEquals("revoked", d.str("state"))

        val m2 = DeskMachine(client, null)
        m2.handle(DeskEvent.Start("t", "u")); m2.handle(DeskEvent.SocketOpen(false))
        m2.handle(DeskEvent.Server(obj("t" to "desk.hello.ok"))); m2.handle(DeskEvent.Server(obj("t" to "knock.ok", "sessionId" to "s2", "resumeKey" to "k")))
        m2.handle(DeskEvent.Server(obj("t" to "session.created", "sessionId" to "s2", "state" to "consent_pending")))
        m2.handle(DeskEvent.ConsentAccepted("control"))
        m2.handle(DeskEvent.Server(obj("t" to "consent.ok", "state" to "active", "iceServers" to ice)))
        val r = m2.handle(DeskEvent.RevokeConsent)
        assertEquals("consent.revoked", (r.first() as DeskEffect.SendCtrl).msg.str("t"))
        assertEquals("revoked", sent(r).single().str("state"))
    }

    @Test
    fun lowerToViewStopsInputBeforeTheFrame() {
        toActive()
        val e = m.handle(DeskEvent.LowerToView)
        assertEquals(DeskEffect.LevelChanged("view"), e[0])
        assertEquals("desk.consent_level", (e[1] as DeskEffect.Send).msg.str("t"))
        assertEquals("view", m.level)
    }

    @Test
    fun fatalErrorsAndTerminalCloses() {
        m.handle(DeskEvent.Start("t", "u")); m.handle(DeskEvent.SocketOpen(false))
        val e = srv("t" to "error", "code" to "join_unsupported", "message" to "x")
        assertEquals("join_unsupported", e.one<DeskEffect.Ended>().info.error)
        val m2 = DeskMachine(client, null)
        toActiveOn(m2)
        assertTrue(m2.handle(DeskEvent.SocketClosed(4410)).any { it is DeskEffect.Ended })
        assertTrue(m2.handle(DeskEvent.SocketClosed(4410)).isEmpty())
    }

    private fun toActiveOn(x: DeskMachine) {
        x.handle(DeskEvent.Start("t", "u")); x.handle(DeskEvent.SocketOpen(false))
        x.handle(DeskEvent.Server(obj("t" to "desk.hello.ok"))); x.handle(DeskEvent.Server(obj("t" to "knock.ok", "sessionId" to "s", "resumeKey" to "k")))
        x.handle(DeskEvent.Server(obj("t" to "session.created", "sessionId" to "s", "state" to "consent_pending")))
        x.handle(DeskEvent.ConsentAccepted("control"))
        x.handle(DeskEvent.Server(obj("t" to "consent.ok", "state" to "active", "iceServers" to ice)))
    }

    @Test
    fun webrtcFramesOnlyWhileLive() {
        assertTrue(srv("t" to "webrtc.answer", "sessionId" to "s1", "sdp" to "x").isEmpty())
        toActive()
        assertTrue(srv("t" to "webrtc.answer", "sessionId" to "s1", "sdp" to "x").single() is DeskEffect.PeerSignal)
        assertTrue(srv("t" to "session.recording", "recording" to true).single() == DeskEffect.Recording(true))
    }
}
