# Host build of phonon_jni.cpp for PhononNativeHostTest; outside cpp/ and android/ so no Android
# build, podspec or npm picks it up. Driven by scripts/test-jni-host.sh.
cmake_minimum_required(VERSION 3.16)
project(phonon_jni_host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT JNI_INCLUDE OR NOT PHONON_HWCAPS_DIR OR NOT PHONON_ARM64_FEATURES)
  message(FATAL_ERROR "set JNI_INCLUDE, PHONON_HWCAPS_DIR and PHONON_ARM64_FEATURES")
endif()

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
add_library(rnspeech_phonon SHARED
    ${ROOT}/cpp/PhononApi.cpp
    ${ROOT}/cpp/PhononCore.cpp
    ${ROOT}/android/src/main/cpp/phonon_jni.cpp
    fake_android.cpp
)
# include/ (fake android headers) first, then the same order as the Android build.
target_include_directories(rnspeech_phonon PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${ROOT}/cpp
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
