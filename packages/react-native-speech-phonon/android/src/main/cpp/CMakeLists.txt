cmake_minimum_required(VERSION 3.22.1)
project(react-native-speech-phonon)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions -frtti")

find_library(log-lib log)

# Phonon JNI shim. Never links libptts_ffi.so; it is dlopen()ed after the HWCAP gate
# (docs/DESIGN.md §2.1). Built only for the 64-bit RN_SPEECH_PHONON_ABIS.
set(RN_SPEECH_PHONON_ABIS "arm64-v8a" CACHE STRING "ABIs that package libptts_ffi.so")
string(REPLACE "," ";" PHONON_ABI_LIST "${RN_SPEECH_PHONON_ABIS}")
# Checked for every ABI, which also stops CMake warning that 32-bit builds ignore them.
if(NOT RN_SPEECH_PHONON_INCLUDE_DIR OR NOT RN_SPEECH_PHONON_ARM64_FEATURES)
  message(FATAL_ERROR "The Phonon shim needs RN_SPEECH_PHONON_INCLUDE_DIR and "
                      "RN_SPEECH_PHONON_ARM64_FEATURES (set by android/phonon.gradle)")
endif()
if(ANDROID_ABI MATCHES "^(arm64-v8a|x86_64)$" AND ANDROID_ABI IN_LIST PHONON_ABI_LIST)
  set(PHONON_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp)

  add_library(rnspeech_phonon SHARED
      ${PHONON_CPP_DIR}/PhononApi.cpp
      ${PHONON_CPP_DIR}/PhononCore.cpp
      phonon_jni.cpp
  )

  # cpp/ first so its ptts.h wins; the include dir only adds phonon_required_hwcaps.h.
  target_include_directories(rnspeech_phonon PRIVATE
      ${PHONON_CPP_DIR}
      ${RN_SPEECH_PHONON_INCLUDE_DIR}
  )
  target_compile_definitions(rnspeech_phonon PRIVATE
      RN_SPEECH_PHONON_EXPECTED_FEATURES="${RN_SPEECH_PHONON_ARM64_FEATURES}"
  )
  target_compile_options(rnspeech_phonon PRIVATE -Wall -Wextra -fvisibility=hidden)

  target_link_libraries(rnspeech_phonon ${log-lib} dl)
  # 16 KB page-size alignment for Android 15+ devices.
  target_link_options(rnspeech_phonon PRIVATE "-Wl,-z,max-page-size=16384")
endif()
