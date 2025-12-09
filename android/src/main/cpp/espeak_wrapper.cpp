#include "espeak_wrapper.h"
#include <espeak-ng/speak_lib.h>
#include <android/log.h>
#include <string>
#include <mutex>

#define LOG_TAG "EspeakWrapper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Global state
static bool espeak_initialized = false;
static std::mutex espeak_mutex;
static std::string current_data_path;

extern "C" JNIEXPORT jstring JNICALL
Java_com_mhpdev_speech_EspeakNative_phonemize(
    JNIEnv *env,
    jclass clazz,
    jstring text,
    jstring language,
    jstring dataPath
) {
    // Thread-safe access
    std::lock_guard<std::mutex> lock(espeak_mutex);

    // Convert Java strings to C strings
    const char *textCStr = env->GetStringUTFChars(text, nullptr);
    const char *langCStr = env->GetStringUTFChars(language, nullptr);
    const char *pathCStr = env->GetStringUTFChars(dataPath, nullptr);

    if (!textCStr || !langCStr || !pathCStr) {
        LOGE("Failed to get UTF chars from Java strings");
        if (textCStr) env->ReleaseStringUTFChars(text, textCStr);
        if (langCStr) env->ReleaseStringUTFChars(language, langCStr);
        if (pathCStr) env->ReleaseStringUTFChars(dataPath, pathCStr);
        return env->NewStringUTF("");
    }

    // Initialize espeak-ng if not already initialized or if data path changed
    std::string new_path(pathCStr);
    if (!espeak_initialized || current_data_path != new_path) {
        if (espeak_initialized) {
            espeak_Terminate();
            espeak_initialized = false;
        }

        int result = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, pathCStr, 0);
        if (result < 0) {
            env->ReleaseStringUTFChars(text, textCStr);
            env->ReleaseStringUTFChars(language, langCStr);
            env->ReleaseStringUTFChars(dataPath, pathCStr);
            return env->NewStringUTF("");
        }

        espeak_initialized = true;
        current_data_path = new_path;
    }

    // Set language/voice
    espeak_VOICE voice_spec;
    memset(&voice_spec, 0, sizeof(espeak_VOICE));
    voice_spec.languages = langCStr;

    if (espeak_SetVoiceByProperties(&voice_spec) != EE_OK) {
        // Continue anyway - espeak will use default voice
    }

    // espeak_TextToPhonemes processes ONE CLAUSE at a time
    // We need to call it repeatedly until all text is processed
    const char *textPtr = textCStr;
    std::string all_phonemes;

    // Keep calling espeak_TextToPhonemes until all text is processed
    while (textPtr && *textPtr != '\0') {
        const char *before_ptr = textPtr;

        const char *phoneme_output = espeak_TextToPhonemes(
            (const void **)&textPtr,
            espeakCHARS_UTF8,
            espeakPHONEMES_IPA
        );

        if (phoneme_output && strlen(phoneme_output) > 0) {
            std::string clause_phonemes(phoneme_output);

            // Trim leading/trailing whitespace
            size_t start = clause_phonemes.find_first_not_of(" \t\n\r");
            size_t end = clause_phonemes.find_last_not_of(" \t\n\r");
            if (start != std::string::npos && end != std::string::npos) {
                clause_phonemes = clause_phonemes.substr(start, end - start + 1);
            }

            if (!clause_phonemes.empty()) {
                // Add space between clauses if not first
                if (!all_phonemes.empty()) {
                    all_phonemes += " ";
                }
                all_phonemes += clause_phonemes;
            }
        }

        // Safety check: if pointer didn't advance, break to avoid infinite loop
        if (textPtr == before_ptr || textPtr == nullptr) {
            break;
        }
    }

    // Cleanup
    env->ReleaseStringUTFChars(text, textCStr);
    env->ReleaseStringUTFChars(language, langCStr);
    env->ReleaseStringUTFChars(dataPath, pathCStr);

    return env->NewStringUTF(all_phonemes.c_str());
}
