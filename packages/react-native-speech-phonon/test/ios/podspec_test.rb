# Evaluates RNSpeechPhonon.podspec against a stand-in CocoaPods DSL. Run: ruby test/ios/podspec_test.rb
require 'minitest/autorun'
require 'digest'
require 'fileutils'
require 'json'
require 'tmpdir'

module Pod
  class Informative < StandardError; end

  class Spec
    attr_reader :attrs

    def initialize
      @attrs = {}
      yield self
    end

    def method_missing(name, *args)
      key = name.to_s
      return @attrs[key.chomp('=')] = args.first if key.end_with?('=')
      return @attrs[key] if args.empty? && @attrs.key?(key)

      super
    end

    def dependency(name, *) = (@attrs['dependency'] ||= []) << name

    def respond_to_missing?(*) = true
  end
end

def min_ios_version_supported = '15.1'
def install_modules_dependencies(_spec) = nil

# Loaded up front so RNSpeechPhonon::Error exists in any test order; the podspec's require of the
# symlinked copy resolves to the same real path.
require File.join(File.expand_path('../..', __dir__), 'ios', 'fetch.rb')

class PodspecTest < Minitest::Test
  REPO = File.expand_path('../..', __dir__)

  def setup
    @tmp = Dir.mktmpdir('phonon-podspec')
    # Copied so tests can edit the lock.
    @root = File.join(@tmp, 'pkg')
    FileUtils.mkdir_p(File.join(@root, 'ios'))
    FileUtils.cp(File.join(REPO, 'RNSpeechPhonon.podspec'), @root)
    FileUtils.cp(File.join(REPO, 'package.json'), @root)
    FileUtils.cp(File.join(REPO, 'phonon.lock.json'), @root)
    # Symlinked: `require` dedups by real path.
    File.symlink(File.join(REPO, 'ios', 'fetch.rb'), File.join(@root, 'ios', 'fetch.rb'))
    @saved = ENV.to_h.slice('RN_SPEECH_PHONON_XCFRAMEWORK', 'RN_SPEECH_PHONON_CACHE')
    ENV.delete('RN_SPEECH_PHONON_XCFRAMEWORK')
    ENV['RN_SPEECH_PHONON_CACHE'] = File.join(@tmp, 'cache')
  end

  def teardown
    ENV.delete('RN_SPEECH_PHONON_XCFRAMEWORK')
    ENV.delete('RN_SPEECH_PHONON_CACHE')
    @saved.each { |k, v| ENV[k] = v }
    FileUtils.rm_rf(@tmp)
  end

  def set_ios_sha(sha)
    path = File.join(@root, 'phonon.lock.json')
    lock = JSON.parse(File.read(path))
    lock['binaries']['ios']['sha256'] = sha
    File.write(path, JSON.dump(lock))
  end

  def eval_podspec
    path = File.join(@root, 'RNSpeechPhonon.podspec')
    eval(File.read(path), TOPLEVEL_BINDING.dup, path) # rubocop:disable Security/Eval
  end

  def local_xcf
    xcf = File.join(@tmp, 'local', 'PhononCore.xcframework')
    %w[ios-arm64 ios-arm64_x86_64-simulator].each do |id|
      FileUtils.mkdir_p(File.join(xcf, id))
      File.write(File.join(xcf, id, 'libptts_ffi.a'), id)
    end
    File.write(File.join(xcf, 'Info.plist'),
               '<key>LibraryIdentifier</key><string>ios-arm64</string>' \
               '<key>LibraryIdentifier</key><string>ios-arm64_x86_64-simulator</string>')
    xcf
  end

  def defines(spec) = spec.attrs['pod_target_xcconfig']['GCC_PREPROCESSOR_DEFINITIONS']

  def test_placeholder_lock_fails_pod_install
    set_ios_sha('PLACEHOLDER')
    err = assert_raises(Pod::Informative) { eval_podspec }
    assert_includes err.message, 'sha256 PLACEHOLDER'
    assert_includes err.message, 'RN_SPEECH_PHONON_XCFRAMEWORK'
  end

  def test_local_override
    set_ios_sha('PLACEHOLDER')
    ENV['RN_SPEECH_PHONON_XCFRAMEWORK'] = local_xcf
    spec = eval_podspec
    assert_equal 'RNSpeechPhonon', spec.attrs['name']
    assert_equal ['RNSpeech'], spec.attrs['dependency']
    assert_equal 'ios/PhononCore.xcframework', spec.attrs['vendored_frameworks']
    # The copied framework itself is never compiled as sources.
    assert_includes spec.attrs['exclude_files'], 'ios/PhononCore.xcframework/**/*'
    assert_includes spec.attrs['frameworks'], 'CoreML'
    assert_includes spec.attrs['frameworks'], 'CoreVideo'
    refute_includes spec.attrs['frameworks'], 'Accelerate'
    refute_match(/RN_SPEECH_PHONON=/, defines(spec))
    assert_match(/RN_SPEECH_PHONON_VERSION=\d+\.\d+\.\d+-r\d+\+local/, defines(spec))
    assert File.file?(File.join(@root, 'ios', 'PhononCore.xcframework', 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_sha_mismatch_fails_install
    set_ios_sha('0' * 64)
    stage = File.join(@tmp, 'mirror')
    FileUtils.mkdir_p(stage)
    File.write(File.join(stage, JSON.parse(File.read(File.join(@root, 'phonon.lock.json')))
      .dig('binaries', 'ios', 'asset')), 'not the pinned zip')
    ENV['RN_SPEECH_PHONON_RELEASE_URL'] = "file://#{stage}"
    err = assert_raises(Pod::Informative) { eval_podspec }
    assert_match(/\A\[RNSpeechPhonon\] .*sha256 .* pins 0{64}/, err.message)
  ensure
    ENV.delete('RN_SPEECH_PHONON_RELEASE_URL')
  end

  def test_failed_download_fails_install
    set_ios_sha('0' * 64)
    ENV['RN_SPEECH_PHONON_RELEASE_URL'] = "file://#{File.join(@tmp, 'nowhere')}"
    err = assert_raises(Pod::Informative) { eval_podspec }
    assert_match(/\A\[RNSpeechPhonon\] download failed: file:/, err.message)
  ensure
    ENV.delete('RN_SPEECH_PHONON_RELEASE_URL')
  end

  def test_read_only_package_fails_install
    skip 'root ignores file modes' if Process.uid.zero?
    ENV['RN_SPEECH_PHONON_XCFRAMEWORK'] = local_xcf
    FileUtils.chmod(0o555, File.join(@root, 'ios'))
    err = assert_raises(Pod::Informative) { eval_podspec }
    assert_match(/\A\[RNSpeechPhonon\] Permission denied/, err.message)
  ensure
    FileUtils.chmod(0o755, File.join(@root, 'ios'))
  end

  def test_sources_never_include_tests
    ENV['RN_SPEECH_PHONON_XCFRAMEWORK'] = local_xcf
    spec = eval_podspec
    globs = spec.attrs['source_files']
    assert(globs.all? { |g| g.start_with?('ios/', 'cpp/') })
    assert(Dir.glob(File.join(REPO, 'test', '**', '*')).none? { |f| f.start_with?(File.join(REPO, 'ios'), File.join(REPO, 'cpp')) })
    hits = globs.flat_map { |g| Dir.glob(File.join(REPO, g)) }.select { |f| File.basename(f) == 'ptts.h' }
    assert_equal [File.join(REPO, 'cpp', 'ptts.h')], hits.uniq
  end
end
