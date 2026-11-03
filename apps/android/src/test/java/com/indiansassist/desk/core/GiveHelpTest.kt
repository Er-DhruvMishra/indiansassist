package com.indiansassist.desk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Phase F section 7.8: the Give help origin choice and launch plan; section 6.1: tappable camera links in the chat. */
class GiveHelpTest {
    @Test
    fun originsPutTheDefaultFirstWithoutDuplicates() {
        val o = GiveHelp.origins(
            "https://in.indiansassist.example/",
            "https://in.indiansassist.example, https://eu.indiansassist.example/ ,,https://us.indiansassist.example",
        )
        assertEquals(listOf("https://in.indiansassist.example", "https://eu.indiansassist.example", "https://us.indiansassist.example"), o)
        assertTrue(GiveHelp.needsPicker(o))
    }

    @Test
    fun oneCompiledOriginNeedsNoPicker() {
        val o = GiveHelp.origins("https://in.indiansassist.example", "https://in.indiansassist.example")
        assertEquals(listOf("https://in.indiansassist.example"), o)
        assertFalse(GiveHelp.needsPicker(o))
    }

    @Test
    fun originsDropAnythingThatIsNotAnHttpOrigin() {
        val o = GiveHelp.origins("http://localhost:4300", "ftp://x.example,https://a.example/path,javascript:alert(1),https://ok.example")
        assertEquals(listOf("http://localhost:4300", "https://ok.example"), o)
    }

    @Test
    fun theConsoleUrlIsTheManifestStartUrl() {
        assertEquals("https://in.indiansassist.example/app/", GiveHelp.consoleUrl("https://in.indiansassist.example/"))
        assertEquals("http://localhost:4300/app/", GiveHelp.consoleUrl("http://localhost:4300"))
    }

    @Test
    fun aCustomTabWhenAProviderExistsOtherwiseTheBrowser() {
        assertEquals(GiveHelp.Plan("https://a.example/app/", GiveHelp.Mode.CUSTOM_TAB), GiveHelp.plan("https://a.example", customTabsAvailable = true))
        assertEquals(GiveHelp.Plan("https://a.example/app/", GiveHelp.Mode.BROWSER), GiveHelp.plan("https://a.example", customTabsAvailable = false))
    }

    @Test
    fun pickerLabelsAreHostsWithNonDefaultPorts() {
        assertEquals("in.indiansassist.example", GiveHelp.label("https://in.indiansassist.example"))
        assertEquals("localhost:4300", GiveHelp.label("http://localhost:4300"))
    }

    @Test
    fun cameraLinksOfServedOriginsAreFound() {
        val text = "Asha: To show me something with your phone's camera, open this on your phone: " +
            "https://in.indiansassist.example/c/7K2M9Q4R8T1V (code 7K2M-9Q4R-8T1V)"
        val r = ChatLinks.cameraLinks(text, listOf("https://in.indiansassist.example"))
        assertEquals(1, r.size)
        assertEquals("https://in.indiansassist.example/c/7K2M9Q4R8T1V", text.substring(r[0]))
    }

    @Test
    fun otherLinksStayPlainText() {
        val origins = listOf("https://in.indiansassist.example", "http://localhost:4300")
        // Another host, a code of the wrong length, a non-Crockford letter (U), a /join link.
        for (t in listOf(
            "https://evil.example/c/7K2M9Q4R8T1V",
            "https://in.indiansassist.example/c/7K2M9Q4R8T1",
            "https://in.indiansassist.example/c/7K2M9Q4R8T1VX",
            "https://in.indiansassist.example/c/7K2M9Q4R8TUV",
            "https://in.indiansassist.example/join#t=abc",
        )) assertTrue(t, ChatLinks.cameraLinks(t, origins).isEmpty())
        assertEquals(1, ChatLinks.cameraLinks("open http://localhost:4300/c/abcdefghjkmn now", origins).size)
        assertTrue(ChatLinks.cameraLinks("https://in.indiansassist.example/c/7K2M9Q4R8T1V", emptyList()).isEmpty())
    }
}
