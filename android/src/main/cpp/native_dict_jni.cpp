// native_dict_jni.cpp — JNI bridge for com.pocketpalai.speech.NativeDict.
#include <jni.h>
#include <android/log.h>
#include <memory>
#include <mutex>
#include <string>

#include "native_dict.h"

#define LOG_TAG "NativeDict"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {
std::mutex sDictMutex;
std::unique_ptr<rnspeech::NativeDict> sDict;
}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_pocketpalai_speech_NativeDict_nativeOpen(JNIEnv* env, jclass, jstring path) {
  if (path == nullptr) return JNI_FALSE;
  const char* cpath = env->GetStringUTFChars(path, nullptr);
  if (cpath == nullptr) return JNI_FALSE;
  std::string p(cpath);
  env->ReleaseStringUTFChars(path, cpath);

  std::lock_guard<std::mutex> lock(sDictMutex);
  auto dict = std::make_unique<rnspeech::NativeDict>();
  if (!dict->open(p)) {
    LOGE("Failed to open dict: %s", p.c_str());
    return JNI_FALSE;
  }
  sDict = std::move(dict);
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_pocketpalai_speech_NativeDict_nativeClose(JNIEnv*, jclass) {
  std::lock_guard<std::mutex> lock(sDictMutex);
  sDict.reset();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_NativeDict_nativeLookup(JNIEnv* env, jclass, jstring word) {
  if (word == nullptr) return nullptr;

  const char* cword = env->GetStringUTFChars(word, nullptr);
  if (cword == nullptr) return nullptr;
  std::string w(cword);
  env->ReleaseStringUTFChars(word, cword);

  std::lock_guard<std::mutex> lock(sDictMutex);
  if (!sDict) return nullptr;

  auto v = sDict->lookup(w);
  if (!v) return nullptr;

  // Copy into NUL-terminated buffer for NewStringUTF (UTF-8).
  std::string result(v->data(), v->size());
  return env->NewStringUTF(result.c_str());
}
