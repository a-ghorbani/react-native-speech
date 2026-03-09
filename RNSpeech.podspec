require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RNSpeech"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/mhpdev-com/react-native-speech.git", :tag => "#{s.version}" }

  # Our module sources
  s.source_files = "ios/**/*.{h,m,mm,cpp}"
  s.public_header_files = "ios/EspeakWrapper.h"
  s.exclude_files = "ios/generated/**/*"

  # Use script_phase to build espeak-ng as a static library before compilation
  s.script_phases = [
    {
      :name => 'Build espeak-ng static library',
      :execution_position => :before_compile,
      :script => <<-SCRIPT
        set -e
        ESPEAK_SRC="${PODS_TARGET_SRCROOT}/third-party/espeak-ng/src"
        BUILD_DIR="${PODS_TARGET_SRCROOT}/ios/build-espeak"

        # Skip if already built
        if [ -d "${BUILD_DIR}/libespeak-ng.xcframework" ]; then
          echo "espeak-ng already built, skipping..."
          exit 0
        fi

        mkdir -p "${BUILD_DIR}"
        cd "${BUILD_DIR}"

        # Copy config.h
        cp "${PODS_TARGET_SRCROOT}/ios/espeak-config.h" config.h
        cp config.h "${ESPEAK_SRC}/libespeak-ng/config.h"

        echo "Compiling espeak-ng for multiple architectures..."

        # Build for iOS device (arm64)
        mkdir -p device
        cd device

        # Compile espeak-ng library files
        find "${ESPEAK_SRC}/libespeak-ng" -name "*.c" \
          -not -name "espeak_command.c" \
          -not -name "compilembrola.c" \
          -not -name "compiledata.c" \
          -not -name "sPlayer.c" \
          -not -name "klatt.c" | while read file; do
          xcrun -sdk iphoneos clang -c "$file" \
            -x c \
            -arch arm64 \
            -mios-version-min=13.0 \
            -DLIBESPEAK_NG_EXPORT= \
            -DN_PHONEME_LIST=4000 \
            -I"${ESPEAK_SRC}/include" \
            -I"${ESPEAK_SRC}/libespeak-ng" \
            -I"${ESPEAK_SRC}/ucd-tools/src/include" \
            -Wno-everything
        done

        # Compile ucd-tools files
        find "${ESPEAK_SRC}/ucd-tools/src" -name "*.c" | while read file; do
          xcrun -sdk iphoneos clang -c "$file" \
            -x c \
            -arch arm64 \
            -mios-version-min=13.0 \
            -I"${ESPEAK_SRC}/ucd-tools/src/include" \
            -Wno-everything
        done

        xcrun -sdk iphoneos ar rcs libespeak-ng.a *.o
        cd ..

        # Build for iOS simulator (arm64 and x86_64)
        mkdir -p simulator
        cd simulator

        # Compile espeak-ng library files
        find "${ESPEAK_SRC}/libespeak-ng" -name "*.c" \
          -not -name "espeak_command.c" \
          -not -name "compilembrola.c" \
          -not -name "compiledata.c" \
          -not -name "sPlayer.c" \
          -not -name "klatt.c" | while read file; do
          xcrun -sdk iphonesimulator clang -c "$file" \
            -x c \
            -arch arm64 -arch x86_64 \
            -mios-simulator-version-min=13.0 \
            -DLIBESPEAK_NG_EXPORT= \
            -DN_PHONEME_LIST=4000 \
            -I"${ESPEAK_SRC}/include" \
            -I"${ESPEAK_SRC}/libespeak-ng" \
            -I"${ESPEAK_SRC}/ucd-tools/src/include" \
            -Wno-everything
        done

        # Compile ucd-tools files
        find "${ESPEAK_SRC}/ucd-tools/src" -name "*.c" | while read file; do
          xcrun -sdk iphonesimulator clang -c "$file" \
            -x c \
            -arch arm64 -arch x86_64 \
            -mios-simulator-version-min=13.0 \
            -I"${ESPEAK_SRC}/ucd-tools/src/include" \
            -Wno-everything
        done

        xcrun -sdk iphonesimulator ar rcs libespeak-ng.a *.o
        cd ..

        # Create XCFramework (universal library for all platforms)
        xcodebuild -create-xcframework \
          -library device/libespeak-ng.a \
          -library simulator/libespeak-ng.a \
          -output libespeak-ng.xcframework

        echo "espeak-ng XCFramework built successfully"
      SCRIPT
    }
  ]

  # Link the XCFramework
  s.vendored_frameworks = 'ios/build-espeak/libespeak-ng.xcframework'

  # Header search paths
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/third-party/espeak-ng/src/include"',
      '"$(PODS_TARGET_SRCROOT)/third-party/espeak-ng/src/libespeak-ng"',
      '"$(PODS_TARGET_SRCROOT)/third-party/espeak-ng/src/ucd-tools/src/include"'
    ].join(' '),
    'GCC_PREPROCESSOR_DEFINITIONS' =>
      ENV['RN_SPEECH_TRACE'] == '1' ? '$(inherited) RN_SPEECH_TRACE=1' : '$(inherited)'
  }

  # Bundle espeak-ng-data as resource
  # Use resources instead of resource_bundles to preserve directory structure
  s.resources = ['third-party/espeak-ng/espeak-ng-data']

  # Frameworks
  s.frameworks = "AVFoundation", "AudioToolbox"

  install_modules_dependencies(s)
end
