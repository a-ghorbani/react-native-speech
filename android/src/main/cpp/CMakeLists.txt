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

# Phonon JNI shim (RNSpeech_phononEnabled). Never links libptts_ffi.so; it is dlopen()ed after
# the HWCAP gate (docs/phonon/DESIGN.md §2.1). Built only for the 64-bit RN_SPEECH_PHONON_ABIS.
option(RN_SPEECH_PHONON "Build the Phonon JNI shim" OFF)
set(RN_SPEECH_PHONON_ABIS "arm64-v8a" CACHE STRING "ABIs that package libptts_ffi.so")
string(REPLACE "," ";" PHONON_ABI_LIST "${RN_SPEECH_PHONON_ABIS}")
# Checked for every ABI, which also stops CMake warning that 32-bit builds ignore them.
if(RN_SPEECH_PHONON AND (NOT RN_SPEECH_PHONON_INCLUDE_DIR OR NOT RN_SPEECH_PHONON_ARM64_FEATURES))
  message(FATAL_ERROR "RN_SPEECH_PHONON needs RN_SPEECH_PHONON_INCLUDE_DIR and "
                      "RN_SPEECH_PHONON_ARM64_FEATURES (set by android/phonon.gradle)")
endif()
if(RN_SPEECH_PHONON AND ANDROID_ABI MATCHES "^(arm64-v8a|x86_64)$" AND ANDROID_ABI IN_LIST PHONON_ABI_LIST)
  set(PHONON_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp/phonon)

  add_library(rnspeech_phonon SHARED
      ${PHONON_CPP_DIR}/PhononApi.cpp
      ${PHONON_CPP_DIR}/PhononCore.cpp
      phonon/phonon_jni.cpp
  )

  # cpp/phonon first so its ptts.h wins; the include dir only adds phonon_required_hwcaps.h.
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
