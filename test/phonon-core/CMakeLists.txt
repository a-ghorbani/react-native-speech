# Host tests for cpp/phonon (DESIGN.md §1.4, WP3). Lives outside cpp/ so neither the Android
# CMake build, the podspec glob nor npm can pick it up. Run via scripts/test-phonon-core.sh.
cmake_minimum_required(VERSION 3.16)
project(phonon_core_test C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

option(PHONON_SANITIZE "Build with AddressSanitizer + UndefinedBehaviorSanitizer" ON)
option(PHONON_TSAN "Build with ThreadSanitizer instead (overrides PHONON_SANITIZE)" OFF)

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(CORE_DIR "${REPO_ROOT}/cpp/phonon")

add_compile_options(-Wall -Wextra -Werror -g -O1)
if(PHONON_TSAN)
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer)
  add_link_options(-fsanitize=thread)
elseif(PHONON_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all
                      -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# Fake libptts_ffi: all 8 symbols, and a variant without ptts_set_language.
foreach(variant fake_ptts fake_ptts_nosym)
  add_library(${variant} SHARED fake_ptts.c)
  target_include_directories(${variant} PRIVATE "${CORE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}")
  set_target_properties(${variant} PROPERTIES C_VISIBILITY_PRESET hidden)
  find_package(Threads REQUIRED)
  target_link_libraries(${variant} PRIVATE Threads::Threads)
endforeach()
target_compile_definitions(fake_ptts_nosym PRIVATE FAKE_PTTS_OMIT_SET_LANGUAGE=1)

set(CORE_SOURCES
  "${CORE_DIR}/PhononApi.cpp"
  "${CORE_DIR}/PhononCore.cpp"
  "${CORE_DIR}/PhononWorker.cpp")

# Android-style binding: dlopen + dlsym of the fake.
add_executable(core_test core_test.cpp ${CORE_SOURCES})
target_include_directories(core_test PRIVATE "${CORE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(core_test PRIVATE
  FAKE_PTTS_LIB="$<TARGET_FILE:fake_ptts>"
  FAKE_PTTS_NOSYM_LIB="$<TARGET_FILE:fake_ptts_nosym>")
target_link_libraries(core_test PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
add_dependencies(core_test fake_ptts fake_ptts_nosym)

# iOS-style binding: ptts_* linked into the binary.
add_executable(static_api_test static_api_test.cpp fake_ptts.c ${CORE_SOURCES})
target_include_directories(static_api_test PRIVATE "${CORE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(static_api_test PRIVATE RN_SPEECH_PHONON_STATIC_API=1)
target_link_libraries(static_api_test PRIVATE Threads::Threads)

enable_testing()
add_test(NAME core_test COMMAND core_test)
add_test(NAME static_api_test COMMAND static_api_test)
