# Evaluates RNSpeech.podspec with a stand-in for CocoaPods' DSL, flag off and on, so the Phonon
# branches (excludes, vendored framework, defines, placeholder fallback) are checked without
# CocoaPods. Run: ruby test/phonon-ios/podspec_test.rb
require 'minitest/autorun'
require 'digest'
require 'fileutils'
require 'json'
require 'tmpdir'

module Pod
  module UI
    @messages = []
    class << self
      attr_reader :messages

      def warn(msg) = @messages << [:warn, msg]
      def puts(msg) = @messages << [:puts, msg]
    end
  end

  # Records every attribute the podspec sets.
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

    def respond_to_missing?(*) = true
  end
end

def min_ios_version_supported = '15.1'
def install_modules_dependencies(_spec) = nil

# Loaded up front (after the Pod stand-ins) so RNSpeechPhonon::Error exists whatever order
# minitest runs the tests in. The podspec's own require of the symlinked copy resolves to the
# same real path and is a no-op.
require File.join(File.expand_path('../..', __dir__), 'ios', 'phonon', 'fetch.rb')

class PodspecTest < Minitest::Test
  REPO = File.expand_path('../..', __dir__)

  def setup
    @tmp = Dir.mktmpdir('phonon-podspec')
    # A copy of the package files the podspec reads, so tests can edit the lock.
    @root = File.join(@tmp, 'pkg')
    FileUtils.mkdir_p(File.join(@root, 'ios', 'phonon'))
    FileUtils.cp(File.join(REPO, 'RNSpeech.podspec'), @root)
    FileUtils.cp(File.join(REPO, 'package.json'), @root)
    FileUtils.cp(File.join(REPO, 'phonon.lock.json'), @root)
    # Symlinked: `require` dedups by real path, so fetch.rb loads once as under CocoaPods.
    File.symlink(File.join(REPO, 'ios', 'phonon', 'fetch.rb'), File.join(@root, 'ios', 'phonon', 'fetch.rb'))
    @saved = ENV.to_h.slice('RN_SPEECH_PHONON', 'RN_SPEECH_PHONON_XCFRAMEWORK',
                            'RN_SPEECH_PHONON_CACHE', 'RN_SPEECH_TRACE')
    %w[RN_SPEECH_PHONON RN_SPEECH_PHONON_XCFRAMEWORK RN_SPEECH_TRACE].each { |k| ENV.delete(k) }
    ENV['RN_SPEECH_PHONON_CACHE'] = File.join(@tmp, 'cache')
    Pod::UI.messages.clear
  end

  def teardown
    ENV.delete('RN_SPEECH_PHONON')
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
    path = File.join(@root, 'RNSpeech.podspec')
    # __dir__ inside the podspec resolves to its own directory, as under CocoaPods.
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

  def test_flag_off_excludes_all_phonon_sources
    spec = eval_podspec
    assert_includes spec.attrs['exclude_files'], 'ios/phonon/**/*'
    assert_includes spec.attrs['exclude_files'], 'cpp/phonon/**/*'
    assert_nil spec.attrs['vendored_frameworks']
    refute_includes spec.attrs['frameworks'], 'CoreML'
    refute_match(/RN_SPEECH_PHONON/, defines(spec))
    assert_empty Pod::UI.messages
  end

  def test_flag_on_with_placeholder_falls_back_with_warning
    set_ios_sha('PLACEHOLDER')
    ENV['RN_SPEECH_PHONON'] = '1'
    spec = eval_podspec
    assert_includes spec.attrs['exclude_files'], 'cpp/phonon/**/*'
    assert_nil spec.attrs['vendored_frameworks']
    assert(Pod::UI.messages.any? { |kind, m| kind == :warn && m.include?('WITHOUT Phonon') })
  end

  def test_flag_on_with_local_override
    set_ios_sha('PLACEHOLDER')
    ENV['RN_SPEECH_PHONON'] = '1'
    ENV['RN_SPEECH_PHONON_XCFRAMEWORK'] = local_xcf
    spec = eval_podspec
    assert_equal 'ios/phonon/PhononCore.xcframework', spec.attrs['vendored_frameworks']
    refute_includes spec.attrs['exclude_files'], 'cpp/phonon/**/*'
    refute_includes spec.attrs['exclude_files'], 'ios/phonon/**/*'
    # The copied framework itself is never compiled as sources.
    assert_includes spec.attrs['exclude_files'], 'ios/phonon/PhononCore.xcframework/**/*'
    assert_includes spec.attrs['frameworks'], 'CoreML'
    assert_includes spec.attrs['frameworks'], 'CoreVideo'
    refute_includes spec.attrs['frameworks'], 'Accelerate'
    assert_match(/(^| )RN_SPEECH_PHONON=1( |$)/, defines(spec))
    assert_match(/RN_SPEECH_PHONON_VERSION=\d+\.\d+\.\d+-r\d+\+local/, defines(spec))
    assert File.file?(File.join(@root, 'ios', 'phonon', 'PhononCore.xcframework', 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_flag_on_with_sha_mismatch_fails_install
    set_ios_sha('0' * 64)
    ENV['RN_SPEECH_PHONON'] = '1'
    stage = File.join(@tmp, 'mirror')
    FileUtils.mkdir_p(stage)
    File.write(File.join(stage, JSON.parse(File.read(File.join(@root, 'phonon.lock.json')))
      .dig('binaries', 'ios', 'asset')), 'not the pinned zip')
    ENV['RN_SPEECH_PHONON_RELEASE_URL'] = "file://#{stage}"
    assert_raises(RNSpeechPhonon::Error) { eval_podspec }
  ensure
    ENV.delete('RN_SPEECH_PHONON_RELEASE_URL')
  end

  # Host tests must never be inside a podspec source glob (DESIGN.md §3.3).
  def test_sources_never_include_tests
    spec = eval_podspec
    globs = spec.attrs['source_files']
    assert(globs.all? { |g| g.start_with?('ios/', 'cpp/') })
    assert(Dir.glob(File.join(REPO, 'test', '**', '*')).none? { |f| f.start_with?(File.join(REPO, 'ios'), File.join(REPO, 'cpp')) })
    # Exactly one ptts.h in the pod sources.
    hits = globs.flat_map { |g| Dir.glob(File.join(REPO, g)) }.select { |f| File.basename(f) == 'ptts.h' }
    assert_equal [File.join(REPO, 'cpp', 'phonon', 'ptts.h')], hits.uniq
  end
end
