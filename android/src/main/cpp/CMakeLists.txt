cmake_minimum_required(VERSION 3.22.1)
project(react-native-speech)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions -frtti")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -w")  # Suppress espeak-ng warnings

# Find system libraries
find_library(log-lib log)

# espeak-ng source directory (from git submodule)
set(ESPEAK_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../third-party/espeak-ng/src)

# Collect espeak-ng source files
file(GLOB ESPEAK_SOURCES
    "${ESPEAK_SRC_DIR}/libespeak-ng/*.c"
)

# Collect ucd-tools source files (required for Unicode character classification)
file(GLOB UCD_SOURCES
    "${ESPEAK_SRC_DIR}/ucd-tools/src/*.c"
)

# Exclude files we don't need (matching iOS podspec exclusions)
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*espeak_command\\.c$")      # CLI tool
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*compiledict\\.c$")         # Build-time only
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*compilembrola\\.c$")       # Build-time only
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*compiledata\\.c$")         # Build-time only
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*sPlayer\\.c$")             # Requires speechPlayer.h (not available)
list(FILTER ESPEAK_SOURCES EXCLUDE REGEX ".*klatt\\.c$")               # Klatt synthesizer (not needed for phonemization)

# Build espeak-ng as static library
add_library(espeak-ng STATIC ${ESPEAK_SOURCES} ${UCD_SOURCES})

# espeak-ng include paths
target_include_directories(espeak-ng PUBLIC
    ${ESPEAK_SRC_DIR}/include
    ${ESPEAK_SRC_DIR}/libespeak-ng
    ${ESPEAK_SRC_DIR}/ucd-tools/src/include
)

# espeak-ng compile definitions
target_compile_definitions(espeak-ng PRIVATE
    LIBESPEAK_NG_EXPORT=
    N_PHONEME_LIST=4000  # Increased from default 1000 to support longer text
    PATH_ESPEAK_DATA=""  # Data path is set at runtime via espeak_Initialize()
)

# Build the wrapper library
add_library(espeak-wrapper SHARED
    espeak_wrapper.cpp
)

# Link wrapper with espeak-ng
target_link_libraries(espeak-wrapper
    espeak-ng
    ${log-lib}
)
