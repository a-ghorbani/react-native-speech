# Run: ruby test/phonon-ios/fetch_test.rb (needs ruby >= 2.7, minitest, zip/unzip).
require 'minitest/autorun'
require 'digest'
require 'fileutils'
require 'json'
require 'tmpdir'
require_relative '../../ios/phonon/fetch'

class PhononFetchTest < Minitest::Test
  PLIST = <<~XML.freeze
    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict><key>AvailableLibraries</key><array>
    <dict><key>LibraryIdentifier</key><string>ios-arm64</string>
    <key>LibraryPath</key><string>libptts_ffi.a</string></dict>
    <dict><key>LibraryIdentifier</key><string>%<sim>s</string>
    <key>LibraryPath</key><string>libptts_ffi.a</string></dict>
    </array></dict></plist>
  XML

  def setup
    @tmp = Dir.mktmpdir('phonon-fetch')
    @root = File.join(@tmp, 'pkg')
    FileUtils.mkdir_p(File.join(@root, 'ios', 'phonon'))
    File.write(File.join(@root, 'package.json'),
               JSON.dump('repository' => { 'url' => 'git+https://github.com/acme/speech.git' }))
    @cache = File.join(@tmp, 'cache')
    @env = { 'RN_SPEECH_PHONON_CACHE' => @cache }
    @logs = []
    @log = ->(m) { @logs << m }
    write_lock('PLACEHOLDER')
  end

  def teardown
    FileUtils.rm_rf(@tmp)
  end

  def write_lock(sha, release: 'phonon-bin-v0.4.0-r1', extra: {})
    lock = {
      'upstream' => { 'repo' => 'gradium-ai/xn-ptts', 'tag' => 'v0.4.0' },
      'binaries' => {
        'release' => release,
        'ios' => { 'asset' => 'phonon-ios-0.4.0-r1.xcframework.zip', 'sha256' => sha }
      }.merge(extra)
    }
    File.write(File.join(@root, 'phonon.lock.json'), JSON.pretty_generate(lock))
  end

  def make_xcf(dir, sim: 'ios-arm64_x86_64-simulator', headers: false, content: 'lib')
    xcf = File.join(dir, RNSpeechPhonon::XCFRAMEWORK)
    FileUtils.mkdir_p(xcf)
    File.write(File.join(xcf, 'Info.plist'), format(PLIST, sim: sim))
    ['ios-arm64', sim].each do |id|
      FileUtils.mkdir_p(File.join(xcf, id))
      File.write(File.join(xcf, id, 'libptts_ffi.a'), "#{content}-#{id}")
      FileUtils.mkdir_p(File.join(xcf, id, 'Headers')) if headers
    end
    xcf
  end

  def make_zip(name = 'release.zip', **kw)
    stage = File.join(@tmp, "stage-#{name}")
    make_xcf(stage, **kw)
    FileUtils.mkdir_p(File.join(stage, 'licenses'))
    File.write(File.join(stage, 'licenses', 'xn-ptts-LICENSE-MIT'), 'MIT')
    zip = File.join(@tmp, name)
    Dir.chdir(stage) { system('zip', '-qr', zip, '.') || raise('zip failed') }
    zip
  end

  def file_downloader(zip, calls)
    lambda do |url, out|
      calls << url
      FileUtils.cp(zip, out)
    end
  end

  def dest
    RNSpeechPhonon.destination(@root)
  end


  def test_placeholder_lock_is_not_ready
    refute RNSpeechPhonon.lock_ready?(@root, env: @env)
  end

  def test_real_sha_is_ready
    write_lock('a' * 64)
    assert RNSpeechPhonon.lock_ready?(@root, env: @env)
  end

  def test_malformed_sha_is_not_ready
    write_lock('abc')
    refute RNSpeechPhonon.lock_ready?(@root, env: @env)
  end

  def test_local_override_makes_placeholder_ready
    assert RNSpeechPhonon.lock_ready?(@root, env: @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => '/x'))
    refute RNSpeechPhonon.lock_ready?(@root, env: @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => '  '))
  end

  def test_library_version
    assert_equal '0.4.0-r1', RNSpeechPhonon.library_version(@root, env: @env)
    assert_equal '0.4.0-r1+local',
                 RNSpeechPhonon.library_version(@root, env: @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => '/x'))
  end

  def test_library_version_rejects_bad_release
    write_lock('PLACEHOLDER', release: 'v0.4.0 "quoted"')
    assert_raises(RNSpeechPhonon::Error) { RNSpeechPhonon.library_version(@root, env: @env) }
  end

  def test_asset_url_from_package_repository
    lock = RNSpeechPhonon.lock(@root)
    assert_equal 'https://github.com/acme/speech/releases/download/phonon-bin-v0.4.0-r1/' \
                 'phonon-ios-0.4.0-r1.xcframework.zip',
                 RNSpeechPhonon.asset_url(@root, lock, env: @env)
  end

  def test_asset_url_lock_repo_and_env_override
    write_lock('PLACEHOLDER', extra: { 'repo' => 'org/other' })
    lock = RNSpeechPhonon.lock(@root)
    assert_match %r{\Ahttps://github.com/org/other/}, RNSpeechPhonon.asset_url(@root, lock, env: @env)
    env = @env.merge('RN_SPEECH_PHONON_RELEASE_URL' => 'https://mirror.example/bin/')
    assert_equal 'https://mirror.example/bin/phonon-ios-0.4.0-r1.xcframework.zip',
                 RNSpeechPhonon.asset_url(@root, lock, env: env)
  end

  def test_default_cache_dir
    assert_equal File.join(Dir.home, 'Library', 'Caches', 'rnspeech-phonon'), RNSpeechPhonon.cache_dir({})
  end


  def test_release_download_verifies_and_installs
    zip = make_zip
    write_lock(Digest::SHA256.file(zip).hexdigest)
    calls = []
    out = RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip, calls), log: @log)
    assert_equal dest, out
    assert_equal 1, calls.size
    assert File.file?(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
    assert File.file?(File.join(dest, 'ios-arm64_x86_64-simulator', 'libptts_ffi.a'))
    assert File.file?(File.join(@cache, 'phonon-bin-v0.4.0-r1', 'phonon-ios-0.4.0-r1.xcframework.zip'))
    refute Dir.exist?("#{dest}.tmp-#{Process.pid}")

    # Cache hit, stamp unchanged: no download, no copy.
    calls.clear
    @logs.clear
    RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip, calls), log: @log)
    assert_empty calls
    refute(@logs.any? { |l| l.include?('installed') })
  end

  def test_release_download_via_curl_file_url
    zip = make_zip
    write_lock(Digest::SHA256.file(zip).hexdigest)
    env = @env.merge('RN_SPEECH_PHONON_RELEASE_URL' => "file://#{File.dirname(zip)}")
    FileUtils.mv(zip, File.join(File.dirname(zip), 'phonon-ios-0.4.0-r1.xcframework.zip'))
    RNSpeechPhonon.ensure_xcframework!(@root, env: env, log: @log)
    assert File.file?(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_sha_mismatch_fails_and_installs_nothing
    zip = make_zip
    write_lock('0' * 64)
    err = assert_raises(RNSpeechPhonon::Error) do
      RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip, []), log: @log)
    end
    assert_match(/sha256 .* pins 0{64}/, err.message)
    refute Dir.exist?(dest)
    assert_empty Dir.glob(File.join(@cache, '**', '*.zip*'))
  end

  def test_failed_download_cleans_up
    write_lock('0' * 64)
    failing = ->(_url, out) { File.write(out, 'partial'); raise RNSpeechPhonon::Error, 'download failed: x' }
    assert_raises(RNSpeechPhonon::Error) do
      RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: failing, log: @log)
    end
    assert_empty Dir.glob(File.join(@cache, '**', '*part*'))
  end

  def test_corrupt_cached_zip_is_redownloaded
    zip = make_zip
    sha = Digest::SHA256.file(zip).hexdigest
    write_lock(sha)
    cached = File.join(@cache, 'phonon-bin-v0.4.0-r1', 'phonon-ios-0.4.0-r1.xcframework.zip')
    FileUtils.mkdir_p(File.dirname(cached))
    File.write(cached, 'corrupt')
    calls = []
    RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip, calls), log: @log)
    assert_equal 1, calls.size
    assert_equal sha, Digest::SHA256.file(cached).hexdigest
  end

  def test_new_release_replaces_old_copy
    zip1 = make_zip('one.zip', content: 'one')
    write_lock(Digest::SHA256.file(zip1).hexdigest)
    RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip1, []), log: @log)
    zip2 = make_zip('two.zip', content: 'two')
    write_lock(Digest::SHA256.file(zip2).hexdigest, release: 'phonon-bin-v0.4.0-r2')
    RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip2, []), log: @log)
    assert_equal 'two-ios-arm64', File.read(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_zip_without_framework_fails
    stage = File.join(@tmp, 'bad')
    FileUtils.mkdir_p(stage)
    File.write(File.join(stage, 'README'), 'x')
    zip = File.join(@tmp, 'bad.zip')
    Dir.chdir(stage) { system('zip', '-qr', zip, '.') }
    write_lock(Digest::SHA256.file(zip).hexdigest)
    err = assert_raises(RNSpeechPhonon::Error) do
      RNSpeechPhonon.ensure_xcframework!(@root, env: @env, downloader: file_downloader(zip, []), log: @log)
    end
    assert_match(/no PhononCore.xcframework/, err.message)
    refute Dir.exist?(dest)
  end

  def test_placeholder_sha_never_downloads
    lock = RNSpeechPhonon.lock(@root)
    assert_raises(RNSpeechPhonon::Error) do
      RNSpeechPhonon.fetch_release(@root, lock, env: @env, downloader: ->(*) { flunk 'downloaded' })
    end
  end


  def test_local_directory_override
    xcf = make_xcf(File.join(@tmp, 'local'))
    env = @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => xcf)
    RNSpeechPhonon.ensure_xcframework!(@root, env: env, downloader: ->(*) { flunk 'downloaded' }, log: @log)
    assert_equal 'lib-ios-arm64', File.read(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
    assert_match(/\Alocal:[0-9a-f]{64}\z/, File.read(File.join(dest, RNSpeechPhonon::STAMP)).strip)

    # Unchanged -> no copy; changed -> copied again.
    @logs.clear
    RNSpeechPhonon.ensure_xcframework!(@root, env: env, log: @log)
    refute(@logs.any? { |l| l.include?('installed') })
    File.write(File.join(xcf, 'ios-arm64', 'libptts_ffi.a'), 'rebuilt')
    RNSpeechPhonon.ensure_xcframework!(@root, env: env, log: @log)
    assert_equal 'rebuilt', File.read(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_local_zip_override
    zip = make_zip('local.zip')
    env = @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => zip)
    RNSpeechPhonon.ensure_xcframework!(@root, env: env, log: @log)
    assert File.file?(File.join(dest, 'ios-arm64', 'libptts_ffi.a'))
  end

  def test_local_override_missing_path
    env = @env.merge('RN_SPEECH_PHONON_XCFRAMEWORK' => File.join(@tmp, 'nope'))
    assert_raises(RNSpeechPhonon::Error) { RNSpeechPhonon.ensure_xcframework!(@root, env: env, log: @log) }
  end


  def test_validate_requires_slices
    xcf = make_xcf(File.join(@tmp, 'v'))
    FileUtils.rm(File.join(xcf, 'ios-arm64', 'libptts_ffi.a'))
    assert_raises(RNSpeechPhonon::Error) { RNSpeechPhonon.validate!(xcf) }
  end

  def test_validate_requires_plist
    dir = File.join(@tmp, 'NotA.xcframework')
    FileUtils.mkdir_p(dir)
    assert_raises(RNSpeechPhonon::Error) { RNSpeechPhonon.validate!(dir) }
  end

  def test_validate_rejects_missing_simulator
    xcf = make_xcf(File.join(@tmp, 'v'), sim: 'macos-arm64')
    err = assert_raises(RNSpeechPhonon::Error) { RNSpeechPhonon.validate!(xcf) }
    assert_match(/simulator/, err.message)
  end

  def test_validate_warns_for_upstream_framework
    xcf = make_xcf(File.join(@tmp, 'v'), sim: 'ios-arm64-simulator', headers: true)
    warnings = RNSpeechPhonon.validate!(xcf)
    assert(warnings.any? { |w| w.include?('Headers') })
    assert(warnings.any? { |w| w.include?('x86_64') })
  end

  def test_validate_repackaged_has_no_warnings
    assert_empty RNSpeechPhonon.validate!(make_xcf(File.join(@tmp, 'v')))
  end


  # Holds whether the repository lock is still PLACEHOLDER or published.
  def test_repository_lock_parses
    repo = File.expand_path('../..', __dir__)
    lock = RNSpeechPhonon.lock(repo)
    assert_match(/\A[0-9A-Za-z.\-]+\z/, RNSpeechPhonon.library_version(repo, env: {}))
    sha = RNSpeechPhonon.ios_sha(lock)
    assert_equal RNSpeechPhonon.sha256?(sha), RNSpeechPhonon.lock_ready?(repo, env: {})
  end
end
