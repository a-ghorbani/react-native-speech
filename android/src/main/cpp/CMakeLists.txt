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
