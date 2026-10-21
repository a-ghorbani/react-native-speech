// phonon_jni.cpp — JNI shim for com.pocketpalai.speech.phonon.PhononNative.
//
// Cheap probes (ABI, HWCAP, system properties) plus thin wrappers over rnspeech::phonon::Core.
// Never links libptts_ffi.so: nativeLoadLibrary dlopen()s it, only from phononCreate after the
// HWCAP gate, so its initializers never run on a CPU that lacks its features (DESIGN.md §2.1).
//
// No C++ exception reaches the JVM. Strings are converted as real UTF-8 / UTF-16, not JNI's
// Modified UTF-8, so emoji and non-ASCII paths survive.
#include <jni.h>
#include <android/log.h>
#include <sys/auxv.h>
#include <sys/system_properties.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "PhononApi.h"
#include "PhononCore.h"
#include "phonon_required_hwcaps.h"

#define LOG_TAG "Phonon"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

using rnspeech::phonon::Core;
using rnspeech::phonon::Err;

constexpr bool str_eq(const char* a, const char* b) {
  return *a == *b && (*a == '\0' || str_eq(a + 1, b + 1));
}
// The generated HWCAP gate must match the lock (phonon.gradle checks it with a clearer message).
static_assert(str_eq(PHONON_ARM64_FEATURES, RN_SPEECH_PHONON_EXPECTED_FEATURES),
              "phonon_required_hwcaps.h does not match phonon.lock.json arm64Features");

#if defined(__aarch64__)
constexpr const char* kAbi = "arm64-v8a";
#elif defined(__x86_64__)
constexpr const char* kAbi = "x86_64";
#else
#error "the Phonon shim is only built for arm64-v8a and x86_64"
#endif

// Releases GetStringChars even when the conversion below throws (bad_alloc).
class StringChars {
 public:
  StringChars(JNIEnv* env, jstring s) : env_(env), s_(s), chars_(env->GetStringChars(s, nullptr)) {}
  ~StringChars() {
    if (chars_ != nullptr) env_->ReleaseStringChars(s_, chars_);
  }
  StringChars(const StringChars&) = delete;
  StringChars& operator=(const StringChars&) = delete;
  const jchar* get() const { return chars_; }

 private:
  JNIEnv* env_;
  jstring s_;
  const jchar* chars_;
};

std::string toUtf8(JNIEnv* env, jstring s) {
  std::string out;
  if (s == nullptr) return out;
  const jsize len = env->GetStringLength(s);
  const StringChars guard(env, s);
  const jchar* chars = guard.get();
  if (chars == nullptr) return out;
  out.reserve(static_cast<size_t>(len));
  for (jsize i = 0; i < len; ++i) {
    uint32_t cp = chars[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < len && chars[i + 1] >= 0xDC00 &&
        chars[i + 1] <= 0xDFFF) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (chars[i + 1] - 0xDC00);
      ++i;
    } else if (cp >= 0xD800 && cp <= 0xDFFF) {
      cp = 0xFFFD;  // lone surrogate
    }
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  return out;
}

// SetObjectArrayElement + DeleteLocalRef (null values leave the slot null).
void setElement(JNIEnv* env, jobjectArray arr, jsize i, jobject value) {
  if (value == nullptr) return;
  env->SetObjectArrayElement(arr, i, value);
  env->DeleteLocalRef(value);
}

// UTF-8 → jstring; invalid sequences become U+FFFD.
jstring toJString(JNIEnv* env, const std::string& in) {
  std::vector<jchar> out;
  out.reserve(in.size());
  const auto* p = reinterpret_cast<const uint8_t*>(in.data());
  const size_t n = in.size();
  size_t i = 0;
  while (i < n) {
    const uint8_t b0 = p[i];
    uint32_t cp;
    size_t need;
    if (b0 < 0x80) {
      cp = b0;
      need = 0;
    } else if ((b0 & 0xE0) == 0xC0) {
      cp = b0 & 0x1F;
      need = 1;
    } else if ((b0 & 0xF0) == 0xE0) {
      cp = b0 & 0x0F;
      need = 2;
    } else if ((b0 & 0xF8) == 0xF0) {
      cp = b0 & 0x07;
      need = 3;
    } else {
      out.push_back(0xFFFD);
      ++i;
      continue;
    }
    bool ok = true;
    for (size_t k = 1; k <= need; ++k) {
      if (i + k >= n || (p[i + k] & 0xC0) != 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (p[i + k] & 0x3F);
    }
    if (!ok) {
      out.push_back(0xFFFD);
      ++i;
      continue;
    }
    i += need + 1;
    if (cp >= 0x10000 && cp <= 0x10FFFF) {
      cp -= 0x10000;
      out.push_back(static_cast<jchar>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<jchar>(0xDC00 + (cp & 0x3FF)));
    } else if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      out.push_back(0xFFFD);
    } else {
      out.push_back(static_cast<jchar>(cp));
    }
  }
  return env->NewString(out.data(), static_cast<jsize>(out.size()));
}

jobjectArray toStringArray(JNIEnv* env, const std::vector<std::string>& items) {
  jclass stringClass = env->FindClass("java/lang/String");
  if (stringClass == nullptr) return nullptr;
  jobjectArray arr = env->NewObjectArray(static_cast<jsize>(items.size()), stringClass, nullptr);
  env->DeleteLocalRef(stringClass);
  if (arr == nullptr) return nullptr;
  for (size_t i = 0; i < items.size(); ++i) {
    jstring s = toJString(env, items[i]);
    if (s == nullptr) return nullptr;
    env->SetObjectArrayElement(arr, static_cast<jsize>(i), s);
    env->DeleteLocalRef(s);
  }
  return arr;
}

jobjectArray codeAndMessage(JNIEnv* env, const char* code, const std::string& message) {
  return toStringArray(env, {code, message});
}

const char* kInternal = "PHONON_INTERNAL";

}  // namespace

extern "C" {

// Probes: cheap, safe before the HWCAP gate.

JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeAbi(JNIEnv* env, jclass) {
  return env->NewStringUTF(kAbi);
}

JNIEXPORT jlong JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeHwcap(JNIEnv*, jclass) {
  return static_cast<jlong>(getauxval(AT_HWCAP));
}

JNIEXPORT jlong JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeHwcap2(JNIEnv*, jclass) {
#ifdef AT_HWCAP2
  return static_cast<jlong>(getauxval(AT_HWCAP2));
#else
  return 0;
#endif
}

// "<word>:<bit>:<name>" per required HWCAP bit (empty off aarch64).
JNIEXPORT jobjectArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeRequiredHwcaps(JNIEnv* env, jclass) {
  try {
    std::vector<std::string> out;
#define RN_PHONON_REQ(word, bit, name) \
  out.push_back(std::to_string(word) + ":" + std::to_string(static_cast<uint64_t>(bit)) + ":" + name);
    PHONON_REQUIRED_HWCAP_LIST(RN_PHONON_REQ)
#undef RN_PHONON_REQ
    return toStringArray(env, out);
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeArm64Features(JNIEnv* env, jclass) {
  return env->NewStringUTF(PHONON_ARM64_FEATURES);
}

JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeSystemProperty(JNIEnv* env, jclass,
                                                                     jstring name) {
  try {
    char value[PROP_VALUE_MAX] = {0};
    const std::string key = toUtf8(env, name);
    __system_property_get(key.c_str(), value);
    return toJString(env, value);
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jdouble JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeMonotonicMs(JNIEnv*, jclass) {
  return rnspeech::phonon::monotonic_ms();
}

// Library: only after the gate.

// dlopen + dlsym. Returns [reason, detail], reason "ok" | "library-missing" | "symbols-missing"
// | "load-failed".
// Idempotent once loaded. Call on the synth thread.
JNIEXPORT jobjectArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeLoadLibrary(JNIEnv* env, jclass,
                                                                  jstring soname) {
  try {
    Core& core = Core::get();
    if (core.libraryLoaded()) return codeAndMessage(env, "ok", "");
    rnspeech::phonon::PttsApi api;
    std::string err;
    const std::string name = toUtf8(env, soname);
    const auto status = rnspeech::phonon::phonon_load_api(&api, name.c_str(), &err);
    if (status == rnspeech::phonon::ApiStatus::Ok) core.setApi(api);
    return codeAndMessage(env, rnspeech::phonon::api_status_reason(status), err);
  } catch (...) {
    return codeAndMessage(env, "load-failed", "exception while loading the library");
  }
}

JNIEXPORT jboolean JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeLibraryLoaded(JNIEnv*, jclass) {
  return Core::get().libraryLoaded() ? JNI_TRUE : JNI_FALSE;
}

// Returns [code, message, defaultVoice, voices: String[], languages: String[],
//          numbers: double[handleId, sampleRate, loadMs], effectiveUnit]. code "" = ok.
JNIEXPORT jobjectArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeCreate(JNIEnv* env, jclass, jstring dir,
                                                             jstring lang,
                                                             jstring computeUnit) {
  std::string code = kInternal;
  std::string message;
  rnspeech::phonon::LoadResult res;
  std::string unitName;
  try {
    const uint32_t unit = rnspeech::phonon::map_compute_unit(
        rnspeech::phonon::Platform::Android, toUtf8(env, computeUnit), &unitName);
    const Err e = Core::get().create(toUtf8(env, dir), unit, toUtf8(env, lang), &res, &message);
    code = rnspeech::phonon::err_code(e);
  } catch (...) {
    code = kInternal;
    message = "exception in create";
  }
  jclass objectClass = env->FindClass("java/lang/Object");
  if (objectClass == nullptr) return nullptr;
  jobjectArray out = env->NewObjectArray(7, objectClass, nullptr);
  env->DeleteLocalRef(objectClass);
  if (out == nullptr) return nullptr;
  try {
    setElement(env, out, 0, toJString(env, code));
    setElement(env, out, 1, toJString(env, message));
    setElement(env, out, 2, toJString(env, res.defaultVoice));
    setElement(env, out, 3, toStringArray(env, res.voices));
    setElement(env, out, 4, toStringArray(env, res.languages));
    jdoubleArray nums = env->NewDoubleArray(3);
    if (nums != nullptr) {
      const jdouble v[3] = {static_cast<jdouble>(res.handleId),
                            static_cast<jdouble>(res.sampleRate), res.loadMs};
      env->SetDoubleArrayRegion(nums, 0, 3, v);
      setElement(env, out, 5, nums);
    }
    setElement(env, out, 6, toJString(env, unitName));
  } catch (...) {
    return nullptr;
  }
  return out;
}

// Fills `out` (length >= 11): requestId, bufferId, samples, sampleRate, ttfaMs, totalMs,
// queuedMs, voiceChanged, cancelled, startedAtMs, finishedAtMs. Returns [code, message].
JNIEXPORT jobjectArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeSynthesize(
    JNIEnv* env, jclass, jlong handleId, jlong requestId, jstring text, jstring voice,
    jstring lang, jdouble enqueuedAtMs, jdoubleArray out) {
  std::string message;
  const char* code = kInternal;
  rnspeech::phonon::SynthResult r;
  try {
    const Err e = Core::get().synthesize(handleId, requestId, toUtf8(env, text),
                                         toUtf8(env, voice), toUtf8(env, lang), &r, &message,
                                         enqueuedAtMs);
    code = rnspeech::phonon::err_code(e);
  } catch (...) {
    message = "exception in synthesize";
  }
  if (out != nullptr && env->GetArrayLength(out) >= 11) {
    const jdouble v[11] = {static_cast<jdouble>(r.requestId), static_cast<jdouble>(r.bufferId),
                           static_cast<jdouble>(r.samples),   static_cast<jdouble>(r.sampleRate),
                           r.ttfaMs,                          r.totalMs,
                           r.queuedMs,                        r.voiceChanged ? 1.0 : 0.0,
                           r.cancelled ? 1.0 : 0.0,           r.startedAtMs,
                           r.finishedAtMs};
    env->SetDoubleArrayRegion(out, 0, 11, v);
  }
  return codeAndMessage(env, code, message);
}

JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeDestroy(JNIEnv* env, jclass,
                                                              jlong handleId) {
  try {
    return env->NewStringUTF(rnspeech::phonon::err_code(Core::get().destroy(handleId)));
  } catch (...) {
    return env->NewStringUTF(kInternal);
  }
}

// Ids and cancel: lock-free, any thread (the JS thread calls these synchronously).

JNIEXPORT jlong JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeAllocRequestId(JNIEnv*, jclass) {
  return Core::get().allocRequestId();
}

JNIEXPORT void JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeCancelUpTo(JNIEnv*, jclass, jlong id) {
  Core::get().cancelUpTo(id);
}

JNIEXPORT void JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeCancelAll(JNIEnv*, jclass) {
  Core::get().cancelAll();
}

// Consumes the buffer as little-endian PCM16 scaled by `gain`; null if the id is unknown.
JNIEXPORT jbyteArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeTakePcm16(JNIEnv* env, jclass,
                                                                jlong bufferId, jfloat gain) {
  try {
    std::vector<float> samples;
    if (!Core::get().takeBuffer(bufferId, &samples)) return nullptr;
    std::vector<int16_t> pcm(samples.size());
    rnspeech::phonon::float_to_pcm16(samples.data(), samples.size(), gain, pcm.data());
    const jsize bytes = static_cast<jsize>(pcm.size() * sizeof(int16_t));
    jbyteArray arr = env->NewByteArray(bytes);
    if (arr == nullptr) return nullptr;  // OutOfMemoryError pending
    // Android is little-endian on every ABI, so int16 memory is already LE PCM16.
    env->SetByteArrayRegion(arr, 0, bytes, reinterpret_cast<const jbyte*>(pcm.data()));
    return arr;
  } catch (...) {
    LOGE("takePcm16 failed for buffer %lld", static_cast<long long>(bufferId));
    return nullptr;
  }
}

// Little-endian float32 copy; does not consume. null if the id is unknown.
JNIEXPORT jbyteArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeCopyFloat32(JNIEnv* env, jclass,
                                                                  jlong bufferId) {
  try {
    std::vector<float> samples;
    if (!Core::get().copyBuffer(bufferId, &samples)) return nullptr;
    const jsize bytes = static_cast<jsize>(samples.size() * sizeof(float));
    jbyteArray arr = env->NewByteArray(bytes);
    if (arr == nullptr) return nullptr;
    env->SetByteArrayRegion(arr, 0, bytes, reinterpret_cast<const jbyte*>(samples.data()));
    return arr;
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jboolean JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeReleaseBuffer(JNIEnv*, jclass,
                                                                    jlong bufferId) {
  try {
    return Core::get().releaseBuffer(bufferId) ? JNI_TRUE : JNI_FALSE;
  } catch (...) {
    return JNI_FALSE;
  }
}

JNIEXPORT jint JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeReleaseOrphans(JNIEnv*, jclass) {
  try {
    return static_cast<jint>(Core::get().releaseOrphans());
  } catch (...) {
    return 0;
  }
}

// [libraryLoaded, handleOpen, liveBuffers, orphanBuffers, lastIssuedId, cancelWatermark]
JNIEXPORT jlongArray JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeDiagnostics(JNIEnv* env, jclass) {
  try {
    const auto d = Core::get().diagnostics();
    const jlong v[6] = {d.libraryLoaded ? 1 : 0,
                        d.handleOpen ? 1 : 0,
                        static_cast<jlong>(d.liveBuffers),
                        static_cast<jlong>(d.orphanBuffers),
                        d.lastIssuedId,
                        d.cancelWatermark};
    jlongArray arr = env->NewLongArray(6);
    if (arr != nullptr) env->SetLongArrayRegion(arr, 0, 6, v);
    return arr;
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jstring JNICALL
Java_com_pocketpalai_speech_phonon_PhononNative_nativeBusy(JNIEnv* env, jclass) {
  try {
    return env->NewStringUTF(Core::get().diagnostics().busy.c_str());
  } catch (...) {
    return env->NewStringUTF("idle");
  }
}

}  // extern "C"
