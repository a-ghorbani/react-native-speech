require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Phonon (opt-in native TTS engine): Podfile `ENV['RN_SPEECH_PHONON'] = '1'`.
# ios/phonon/fetch.rb resolves the binary (docs/phonon/DESIGN.md §3.3). Until
# phonon.lock.json carries a published iOS sha256, the flag falls back to off
# with a warning, unless ENV['RN_SPEECH_PHONON_XCFRAMEWORK'] points at a local
# PhononCore.xcframework (or its release zip): the dev override.
require File.join(__dir__, "ios", "phonon", "fetch.rb")
phonon_requested = ENV['RN_SPEECH_PHONON'] == '1'
phonon = phonon_requested && RNSpeechPhonon.lock_ready?(__dir__)
if phonon_requested && !phonon
  Pod::UI.warn "[RNSpeech] RN_SPEECH_PHONON=1 but phonon.lock.json has no published iOS " \
    "binaries yet (sha256 PLACEHOLDER). Building WITHOUT Phonon. Set " \
    "RN_SPEECH_PHONON_XCFRAMEWORK to a local PhononCore.xcframework to use local binaries."
end

Pod::Spec.new do |s|
  s.name         = "RNSpeech"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/a-ghorbani/react-native-speech.git", :tag => "#{s.version}" }

  # Our module sources (iOS Obj-C++ + shared C++ core in cpp/)
  s.source_files = ["ios/**/*.{h,m,mm,cpp}", "cpp/**/*.{h,cpp}"]
  s.public_header_files = ["ios/NativeDictWrapper.h"]
  excludes = ["ios/generated/**/*", "ios/phonon/PhononCore.xcframework/**/*"]

  preprocessor_definitions = ['$(inherited)']
  preprocessor_definitions << 'RN_SPEECH_TRACE=1' if ENV['RN_SPEECH_TRACE'] == '1'

  # Frameworks
  frameworks = ["AVFoundation", "AudioToolbox"]

  if phonon
    # lock -> cache -> sha256 -> copy (or the local override), see ios/phonon/fetch.rb.
    RNSpeechPhonon.ensure_xcframework!(__dir__)
    s.vendored_frameworks = "ios/phonon/PhononCore.xcframework"
    frameworks += ["CoreML", "CoreVideo"]
    preprocessor_definitions << 'RN_SPEECH_PHONON=1'
    # Stringified in RNSpeechPhonon.mm (libraryVersion, capability-store key).
    preprocessor_definitions << "RN_SPEECH_PHONON_VERSION=#{RNSpeechPhonon.library_version(__dir__)}"
  else
    # Flag off: no Phonon sources, binary or framework links.
    excludes += ["ios/phonon/**/*", "cpp/phonon/**/*"]
  end
  s.exclude_files = excludes

  # Header search paths
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/cpp"'
    ].join(' '),
    'GCC_PREPROCESSOR_DEFINITIONS' => preprocessor_definitions.join(' ')
  }

  s.frameworks = frameworks

  install_modules_dependencies(s)
end
