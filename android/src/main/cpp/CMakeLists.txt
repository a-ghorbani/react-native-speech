cmake_minimum_required(VERSION 3.22.1)
project(react-native-speech)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions -frtti")

# Find system libraries
find_library(log-lib log)

# --- native_dict (mmap'd phonemizer dict) ---
add_library(native_dict SHARED
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp/native_dict.cpp
    native_dict_jni.cpp
)

target_include_directories(native_dict PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp
)

target_link_libraries(native_dict
    ${log-lib}
)

# 16 KB page-size alignment for Android 15+ devices. AGP 8.12+ only injects this
# for the consumer app's own CMake targets, not for library-module builds like
# this one, so we have to set it explicitly regardless of the consumer's AGP.
target_link_options(native_dict PRIVATE "-Wl,-z,max-page-size=16384")

# --- Phonon JNI shim (opt-in, RNSpeech_phononEnabled) ---
# librnspeech_phonon.so never links libptts_ffi.so: it dlopen()s it lazily from phononCreate,
# after the HWCAP gate (docs/phonon/DESIGN.md §2.1). 64-bit ABIs only; on any other ABI
# System.loadLibrary fails and getSupport reports unsupported-abi.
option(RN_SPEECH_PHONON "Build the Phonon JNI shim" OFF)
# Checked for every ABI (also so CMake does not warn that 32-bit builds ignore them).
if(RN_SPEECH_PHONON AND (NOT RN_SPEECH_PHONON_INCLUDE_DIR OR NOT RN_SPEECH_PHONON_ARM64_FEATURES))
  message(FATAL_ERROR "RN_SPEECH_PHONON needs RN_SPEECH_PHONON_INCLUDE_DIR and "
                      "RN_SPEECH_PHONON_ARM64_FEATURES (set by android/phonon.gradle)")
endif()
if(RN_SPEECH_PHONON AND ANDROID_ABI MATCHES "^(arm64-v8a|x86_64)$")
  set(PHONON_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp/phonon)

  add_library(rnspeech_phonon SHARED
      ${PHONON_CPP_DIR}/PhononApi.cpp
      ${PHONON_CPP_DIR}/PhononCore.cpp
      phonon/phonon_jni.cpp
  )

  # cpp/phonon first: its ptts.h is the only one compiled against. The include dir only adds
  # the generated phonon_required_hwcaps.h.
  target_include_directories(rnspeech_phonon PRIVATE
      ${PHONON_CPP_DIR}
      ${RN_SPEECH_PHONON_INCLUDE_DIR}
  )
  target_compile_definitions(rnspeech_phonon PRIVATE
      RN_SPEECH_PHONON_EXPECTED_FEATURES="${RN_SPEECH_PHONON_ARM64_FEATURES}"
  )
  target_compile_options(rnspeech_phonon PRIVATE -Wall -Wextra -fvisibility=hidden)

  target_link_libraries(rnspeech_phonon ${log-lib} dl)
  target_link_options(rnspeech_phonon PRIVATE "-Wl,-z,max-page-size=16384")
endif()
