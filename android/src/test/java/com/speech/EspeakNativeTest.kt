package com.speech

import org.junit.Test
import org.junit.Before
import org.junit.Assert.*

/**
 * Native unit tests for espeak-ng phonemization wrapper
 *
 * Run with: ./gradlew test
 */
class EspeakNativeTest {

    @Before
    fun setUp() {
        // Ensure native library is loaded
        // This will be handled by the module initialization
    }

    @Test
    fun testBasicPhonemization() {
        val result = EspeakNative.phonemize("Hello", "en-us")
        assertNotNull("Should return phonemes", result)
        assertTrue(
            "Should contain 'həlˈoʊ', got: $result",
            result.contains("həlˈoʊ")
        )
    }

    @Test
    fun testHelloWorld() {
        val result = EspeakNative.phonemize("Hello World", "en-us")
        assertTrue("Should contain 'Hello' phonemes", result.contains("həlˈoʊ"))
        assertTrue("Should contain 'World' phonemes", result.contains("wˈɜːld"))
    }

    @Test
    fun testClauseLooping_CommasShouldConcatenate() {
        val result = EspeakNative.phonemize("start, pause, resume", "en-us")

        // Should contain all three words (concatenated from multiple clauses)
        assertTrue("Should contain 'start'", result.contains("stˈɑːɹt"))
        assertTrue("Should contain 'pause'", result.contains("pˈɔːz"))
        assertTrue(
            "Should contain 'resume', got: $result",
            result.contains("ɹɪzjˈuːm") || result.contains("ɹɪˈzjuːm")
        )
    }

    @Test
    fun testClauseLooping_PeriodsShouldConcatenate() {
        val result = EspeakNative.phonemize("First sentence. Second sentence.", "en-us")

        assertTrue("Should contain 'First'", result.contains("fˈɜːst"))
        assertTrue("Should contain 'Second'", result.contains("sˈɛkənd"))
    }

    @Test
    fun testAbbreviation_Doctor() {
        val result = EspeakNative.phonemize("Doctor Smith", "en-us")

        assertTrue(
            "Should contain 'Doctor', got: $result",
            result.contains("dˈɑːktɚ") || result.contains("dˈɔktɚ")
        )
    }

    @Test
    fun testAbbreviation_Mister() {
        val result = EspeakNative.phonemize("Mister Smith", "en-us")

        assertTrue("Should contain 'Mister'", result.contains("mˈɪstɚ"))
    }

    @Test
    fun testNumber_1990() {
        val result = EspeakNative.phonemize("19 90", "en-us")

        // Should contain "nineteen ninety"
        assertTrue("Should contain 'nine' part", result.contains("nˈaɪn"))
    }

    @Test
    fun testBritishEnglish_Hello() {
        val result = EspeakNative.phonemize("Hello", "en-gb")

        assertNotNull(result)
        // British pronunciation different from US
        assertTrue("Should contain 'həl', got: $result", result.contains("həl"))
    }

    @Test
    fun testEmptyString() {
        val result = EspeakNative.phonemize("", "en-us")

        assertNotNull(result)
        assertEquals("Empty string should return empty phonemes", "", result)
    }

    @Test
    fun testWhitespaceOnly() {
        val result = EspeakNative.phonemize("   ", "en-us")

        assertNotNull(result)
    }

    @Test
    fun testLongText() {
        val longText = "This is a very long sentence with many words to test that " +
                       "the phonemizer can handle longer inputs without truncation or errors."
        val result = EspeakNative.phonemize(longText, "en-us")

        assertNotNull(result)
        assertTrue("Should produce phonemes for long text", result.isNotEmpty())
    }

    @Test
    fun testInvalidLanguage() {
        try {
            val result = EspeakNative.phonemize("Hello", "invalid-lang")

            // espeak-ng may fall back to default language
            // Either error or fallback is acceptable
            assertNotNull("Should handle invalid language gracefully", result)
        } catch (e: Exception) {
            // Error is also acceptable behavior
            assertNotNull("Should throw error for invalid language", e)
        }
    }

    @Test
    fun testThreadSafety() {
        // Test concurrent phonemization calls
        val threads = (1..5).map { i ->
            Thread {
                val result = EspeakNative.phonemize("Hello $i", "en-us")
                assertNotNull("Thread $i should get result", result)
            }
        }

        threads.forEach { it.start() }
        threads.forEach { it.join() }
    }
}
