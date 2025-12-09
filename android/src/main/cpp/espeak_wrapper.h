#ifndef ESPEAK_WRAPPER_H
#define ESPEAK_WRAPPER_H

#include <jni.h>
#include <string>

extern "C" {

/**
 * Phonemize text using espeak-ng
 * @param env JNI environment
 * @param clazz Java class
 * @param text Input text to phonemize
 * @param language Language code (e.g., "en-us", "en-gb")
 * @param dataPath Path to espeak-ng-data directory
 * @return IPA phoneme string
 */
JNIEXPORT jstring JNICALL
Java_com_mhpdev_speech_EspeakNative_phonemize(
    JNIEnv *env,
    jclass clazz,
    jstring text,
    jstring language,
    jstring dataPath
);

} // extern "C"

#endif // ESPEAK_WRAPPER_H
