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

  # Our module sources (iOS Obj-C++ + shared C++ core in cpp/)
  s.source_files = ["ios/**/*.{h,m,mm,cpp}", "cpp/**/*.{h,cpp}"]
  s.public_header_files = ["ios/NativeDictWrapper.h"]
  s.exclude_files = "ios/generated/**/*"

  # Header search paths
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/cpp"'
    ].join(' '),
    'GCC_PREPROCESSOR_DEFINITIONS' =>
      ENV['RN_SPEECH_TRACE'] == '1' ? '$(inherited) RN_SPEECH_TRACE=1' : '$(inherited)'
  }

  # Frameworks
  s.frameworks = "AVFoundation", "AudioToolbox"

  install_modules_dependencies(s)
end
