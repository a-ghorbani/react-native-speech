require "json"
require File.join(__dir__, "ios", "fetch.rb")

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Pod::Informative prints the message; anything else is reported as a CocoaPods bug.
informative = lambda do |&block|
  block.call
rescue RNSpeechPhonon::Error, SystemCallError => e
  raise Pod::Informative, "[RNSpeechPhonon] #{e.message}"
end

unless informative.call { RNSpeechPhonon.lock_ready?(__dir__) }
  raise Pod::Informative, "[RNSpeechPhonon] phonon.lock.json has no published iOS binaries " \
    "(sha256 PLACEHOLDER). Set RN_SPEECH_PHONON_XCFRAMEWORK to a local PhononCore.xcframework, " \
    "or use a release of this package with published binaries."
end

Pod::Spec.new do |s|
  s.name         = "RNSpeechPhonon"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/a-ghorbani/react-native-speech.git", :tag => "phonon-v#{s.version}" }

  s.source_files = ["ios/**/*.{h,m,mm,cpp}", "cpp/**/*.{h,cpp}"]
  s.private_header_files = ["ios/**/*.h", "cpp/**/*.h"]
  s.exclude_files = ["ios/generated/**/*", "ios/PhononCore.xcframework/**/*"]

  informative.call { RNSpeechPhonon.ensure_xcframework!(__dir__) }
  s.vendored_frameworks = "ios/PhononCore.xcframework"

  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/cpp"',
    'GCC_PREPROCESSOR_DEFINITIONS' =>
      "$(inherited) RN_SPEECH_PHONON_VERSION=#{informative.call { RNSpeechPhonon.library_version(__dir__) }}"
  }

  s.frameworks = "AVFoundation", "CoreML", "CoreVideo"

  s.dependency "RNSpeech"
  install_modules_dependencies(s)
end
