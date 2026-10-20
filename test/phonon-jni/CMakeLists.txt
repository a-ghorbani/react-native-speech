# Host (Linux/macOS) build of the Android JNI shim, android/src/main/cpp/phonon/phonon_jni.cpp,
# for the JVM test PhononNativeHostTest (android/src/phononTest). Lives outside cpp/ and
# android/ so neither the Android CMake build, the podspec nor npm can pick it up.
# Driven by scripts/test-phonon-jni-host.sh.
cmake_minimum_required(VERSION 3.16)
project(phonon_jni_host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT JNI_INCLUDE OR NOT PHONON_HWCAPS_DIR OR NOT PHONON_ARM64_FEATURES)
  message(FATAL_ERROR "set JNI_INCLUDE, PHONON_HWCAPS_DIR and PHONON_ARM64_FEATURES")
endif()

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
add_library(rnspeech_phonon SHARED
    ${ROOT}/cpp/phonon/PhononApi.cpp
    ${ROOT}/cpp/phonon/PhononCore.cpp
    ${ROOT}/android/src/main/cpp/phonon/phonon_jni.cpp
    fake_android.cpp
)
# include/ (fake android headers) first, then the same order as the Android build.
target_include_directories(rnspeech_phonon PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${ROOT}/cpp/phonon
    ${PHONON_HWCAPS_DIR}
    ${JNI_INCLUDE}
    ${JNI_INCLUDE}/linux
    ${JNI_INCLUDE}/darwin
)
target_compile_definitions(rnspeech_phonon PRIVATE
    RN_SPEECH_PHONON_EXPECTED_FEATURES="${PHONON_ARM64_FEATURES}"
)
target_compile_options(rnspeech_phonon PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
target_link_libraries(rnspeech_phonon ${CMAKE_DL_LIBS})
