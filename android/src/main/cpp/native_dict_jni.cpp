// native_dict_jni.cpp — JNI bridge for com.pocketpalai.speech.NativeDict.
#include <jni.h>
#include <android/log.h>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "native_dict.h"

#define LOG_TAG "NativeDict"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {
std::mutex sDictMutex;
std::unique_ptr<rnspeech::NativeDict> sDict;

// Decode a UTF-8 byte string into a vector<jchar> (UTF-16). Used instead of
// JNI's NewStringUTF, because NewStringUTF takes Modified UTF-8 — in
// particular it mis-encodes supplementary-plane codepoints (surrogate pairs
// are represented as a 6-byte sequence instead of the canonical 4-byte UTF-8).
// Values in the dict are IPA strings, which today are all in the BMP, but
// harden for forward compatibility.
//
// Invalid sequences are replaced with U+FFFD (REPLACEMENT CHARACTER). Never
// aborts.
std::vector<jchar> utf8ToUtf16(std::string_view in) {
  std::vector<jchar> out;
  out.reserve(in.size());
  size_t i = 0;
  const size_t n = in.size();
  const auto* p = reinterpret_cast<const uint8_t*>(in.data());

  auto push_replacement = [&]() { out.push_back(0xFFFD); };

  while (i < n) {
    uint8_t b0 = p[i];
    uint32_t cp = 0;
    size_t extra = 0;

    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 & 0xE0) == 0xC0) {
      cp = b0 & 0x1F;
      extra = 1;
      if (b0 < 0xC2) {  // overlong
        push_replacement();
        ++i;
        continue;
      }
    } else if ((b0 & 0xF0) == 0xE0) {
      cp = b0 & 0x0F;
      extra = 2;
    } else if ((b0 & 0xF8) == 0xF0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      push_replacement();
      ++i;
      continue;
    }

    if (i + extra >= n) {
      push_replacement();
      break;
    }

    bool ok = true;
    for (size_t k = 1; k <= extra; ++k) {
      uint8_t bk = p[i + k];
      if ((bk & 0xC0) != 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3F);
    }

    if (!ok) {
      push_replacement();
      ++i;
      continue;
    }

    i += 1 + extra;

    // Reject overlong encodings and UTF-16 surrogates in the input.
    if ((extra == 2 && cp < 0x800) ||
        (extra == 3 && cp < 0x10000) ||
        (cp >= 0xD800 && cp <= 0xDFFF) ||
        cp > 0x10FFFF) {
      push_replacement();
      continue;
    }

    if (cp <= 0xFFFF) {
      out.push_back(static_cast<jchar>(cp));
    } else {
      // Supplementary plane → surrogate pair.
      cp -= 0x10000;
      out.push_back(static_cast<jchar>(0xD800 | (cp >> 10)));
      out.push_back(static_cast<jchar>(0xDC00 | (cp & 0x3FF)));
    }
  }
  return out;
}

jstring makeJString(JNIEnv* env, std::string_view utf8) {
  const auto u16 = utf8ToUtf16(utf8);
  // NewString takes (jchar*, jsize). jsize is int32; dict values are short.
  return env->NewString(u16.empty() ? nullptr : u16.data(),
                        static_cast<jsize>(u16.size()));
}
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

  // Use NewString with decoded UTF-16 rather than NewStringUTF — the latter
  // expects Modified UTF-8 and mis-encodes supplementary-plane characters.
  return makeJString(env, *v);
}
