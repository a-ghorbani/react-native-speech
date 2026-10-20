# ios/phonon/fetch.rb — puts PhononCore.xcframework where RNSpeech.podspec vendors it from
# (docs/phonon/DESIGN.md §3.3). Runs at `pod install` time, only when the Podfile sets
# ENV['RN_SPEECH_PHONON'] = '1'.
#
# Sources, in order:
#   1. ENV['RN_SPEECH_PHONON_XCFRAMEWORK']: a local PhononCore.xcframework directory, or a
#      release zip that contains one (dev override; also the path for pnpm / Yarn PnP, whose
#      read-only stores cannot hold the copy). Not sha-checked: it is the developer's own build.
#   2. The release asset pinned in phonon.lock.json (binaries.release / binaries.ios), downloaded
#      once into the cache (ENV['RN_SPEECH_PHONON_CACHE'], default ~/Library/Caches/rnspeech-phonon)
#      and verified against its sha256 before anything is unpacked.
#
# The framework is then copied to ios/phonon/PhononCore.xcframework (git-ignored, not in the npm
# package): CocoaPods only vendors paths inside the pod. A stamp file inside the copy makes later
# `pod install` runs skip the copy when nothing changed.
require 'digest'
require 'fileutils'
require 'json'
require 'tmpdir'

module RNSpeechPhonon
  XCFRAMEWORK = 'PhononCore.xcframework'.freeze
  LIBRARY = 'libptts_ffi.a'.freeze
  STAMP = '.rnspeech-phonon-stamp'.freeze
  PLACEHOLDER = 'PLACEHOLDER'.freeze
  DEFAULT_REPO = 'a-ghorbani/react-native-speech'.freeze

  class Error < StandardError; end

  module_function

  def lock(root)
    JSON.parse(File.read(File.join(root, 'phonon.lock.json')))
  end

  # The local override path ('' and unset are the same: no override).
  def local_override(env = ENV)
    path = env['RN_SPEECH_PHONON_XCFRAMEWORK'].to_s.strip
    path.empty? ? nil : File.expand_path(path)
  end

  def ios_sha(lock)
    lock.dig('binaries', 'ios', 'sha256').to_s
  end

  # True when a Phonon build is possible: a local override is set, or the lock pins a real sha.
  # A PLACEHOLDER lock (no release published yet) means "build without Phonon, with a warning".
  def lock_ready?(root, env: ENV)
    return true if local_override(env)

    sha256?(ios_sha(lock(root)))
  end

  def sha256?(value)
    value.match?(/\A[0-9a-f]{64}\z/)
  end

  # '0.4.0-r1' from binaries.release 'phonon-bin-v0.4.0-r1'; '+local' marks the dev override.
  # Reported to JS as PhononSupportInfo.libraryVersion and part of the capability-store key.
  def library_version(root, env: ENV)
    release = lock(root).dig('binaries', 'release').to_s
    version = release.sub(/\Aphonon-bin-v/, '')
    raise Error, "phonon.lock.json binaries.release '#{release}' is not phonon-bin-v<version>" if
      version.empty? || version == release || !version.match?(/\A[0-9A-Za-z.\-]+\z/)

    local_override(env) ? "#{version}+local" : version
  end

  # GitHub repository the binaries are released on: binaries.repo in the lock, else the
  # package.json repository, else the upstream default.
  def release_repo(root, lock)
    repo = lock.dig('binaries', 'repo').to_s
    return repo unless repo.empty?

    pkg = JSON.parse(File.read(File.join(root, 'package.json')))
    url = pkg['repository'].is_a?(Hash) ? pkg['repository']['url'].to_s : pkg['repository'].to_s
    m = url.match(%r{github\.com[/:]([^/]+/[^/.]+?)(?:\.git)?/?\z})
    m ? m[1] : DEFAULT_REPO
  rescue Errno::ENOENT, JSON::ParserError
    DEFAULT_REPO
  end

  # ENV['RN_SPEECH_PHONON_RELEASE_URL'] replaces the release base URL (mirrors, tests).
  def asset_url(root, lock, env: ENV)
    asset = lock.dig('binaries', 'ios', 'asset').to_s
    raise Error, 'phonon.lock.json has no binaries.ios.asset' if asset.empty?

    base = env['RN_SPEECH_PHONON_RELEASE_URL'].to_s
    if base.empty?
      base = "https://github.com/#{release_repo(root, lock)}/releases/download/" \
             "#{lock.dig('binaries', 'release')}"
    end
    "#{base.chomp('/')}/#{asset}"
  end

  def cache_dir(env = ENV)
    dir = env['RN_SPEECH_PHONON_CACHE'].to_s
    dir = File.join(Dir.home, 'Library', 'Caches', 'rnspeech-phonon') if dir.empty?
    File.expand_path(dir)
  end

  def destination(root)
    File.join(root, 'ios', 'phonon', XCFRAMEWORK)
  end

  def file_sha256(path)
    Digest::SHA256.file(path).hexdigest
  end

  # curl: present on every Mac, follows GitHub's redirect to its object store, honours proxies.
  def curl_download(url, out)
    ok = system('curl', '-fsSL', '--retry', '3', '--connect-timeout', '30', '-o', out, url)
    raise Error, "download failed: #{url}" unless ok
  end

  def unzip(zip, dir)
    FileUtils.mkdir_p(dir)
    ok = if system('which ditto >/dev/null 2>&1')
           system('ditto', '-x', '-k', zip, dir)
         else
           system('unzip', '-q', '-o', zip, '-d', dir)
         end
    raise Error, "could not unpack #{zip}" unless ok
  end

  # The repackaged framework (scripts/phonon/package-ios.sh): Info.plist, a device slice
  # ios-arm64 and a simulator slice, each with libptts_ffi.a. Returns warnings (not errors).
  def validate!(xcf)
    plist = File.join(xcf, 'Info.plist')
    raise Error, "#{xcf} is not an xcframework (no Info.plist)" unless File.file?(plist)

    ids = File.read(plist).scan(%r{<key>LibraryIdentifier</key>\s*<string>([^<]+)</string>}).flatten
    ids = Dir.children(xcf).select { |c| File.directory?(File.join(xcf, c)) } if ids.empty?
    device = ids.include?('ios-arm64')
    sim = ids.find { |id| id.start_with?('ios-') && id.end_with?('-simulator') }
    raise Error, "#{xcf} has no ios-arm64 slice" unless device
    raise Error, "#{xcf} has no iOS simulator slice" unless sim

    ['ios-arm64', sim].each do |id|
      lib = File.join(xcf, id, LIBRARY)
      raise Error, "#{xcf} slice #{id} has no #{LIBRARY}" unless File.file?(lib)
    end
    warnings = []
    if ids.any? { |id| File.directory?(File.join(xcf, id, 'Headers')) }
      warnings << "#{xcf} has Headers: it looks like upstream's framework, not the repackaged " \
                  'one (scripts/phonon/package-ios.sh). Its unprelinked Rust symbols can ' \
                  'collide with the app; use the repackaged framework.'
    end
    unless sim.include?('x86_64')
      warnings << "#{xcf} has no x86_64 simulator stub: Intel-Mac simulator builds will not link."
    end
    warnings
  end

  # Digest of every file in a tree (relative path + content), for the local-override stamp.
  def tree_digest(dir)
    d = Digest::SHA256.new
    Dir.glob('**/*', File::FNM_DOTMATCH, base: dir).sort.each do |rel|
      next if File.basename(rel) == STAMP || ['.', '..'].include?(File.basename(rel))

      path = File.join(dir, rel)
      next unless File.file?(path)

      d << rel << "\0" << file_sha256(path) << "\n"
    end
    d.hexdigest
  end

  # Release path: the zip in the cache, verified, unpacked once per sha. Returns the
  # PhononCore.xcframework directory inside the cache.
  def fetch_release(root, lock, env: ENV, downloader: method(:curl_download), log: nil)
    sha = ios_sha(lock)
    raise Error, "phonon.lock.json binaries.ios.sha256 is not a sha256: '#{sha}'" unless sha256?(sha)

    release = lock.dig('binaries', 'release').to_s
    asset = lock.dig('binaries', 'ios', 'asset').to_s
    dir = File.join(cache_dir(env), release)
    FileUtils.mkdir_p(dir)
    zip = File.join(dir, asset)

    if File.file?(zip) && file_sha256(zip) != sha
      log&.call("[RNSpeech] cached #{asset} does not match phonon.lock.json; downloading again")
      FileUtils.rm_f(zip)
    end
    unless File.file?(zip)
      url = asset_url(root, lock, env: env)
      log&.call("[RNSpeech] downloading #{url}")
      tmp = "#{zip}.part-#{Process.pid}"
      begin
        downloader.call(url, tmp)
        have = File.file?(tmp) ? file_sha256(tmp) : '(nothing downloaded)'
        if have != sha
          raise Error, "#{url}: sha256 #{have}, phonon.lock.json pins #{sha}. " \
                       'The download is corrupt or the lock is stale; nothing was installed.'
        end
        File.rename(tmp, zip)
      ensure
        FileUtils.rm_f(tmp)
      end
    end

    unpacked = File.join(dir, "unpacked-#{sha[0, 16]}")
    unless File.directory?(File.join(unpacked, XCFRAMEWORK))
      tmp = "#{unpacked}.tmp-#{Process.pid}"
      FileUtils.rm_rf(tmp)
      begin
        unzip(zip, tmp)
        raise Error, "#{asset} has no #{XCFRAMEWORK} at its root" unless
          File.directory?(File.join(tmp, XCFRAMEWORK))

        FileUtils.rm_rf(unpacked)
        File.rename(tmp, unpacked)
      ensure
        FileUtils.rm_rf(tmp)
      end
    end
    File.join(unpacked, XCFRAMEWORK)
  end

  # Local override: a directory is used as is; a zip is unpacked into the cache by its sha.
  def resolve_local(path, env: ENV)
    raise Error, "RN_SPEECH_PHONON_XCFRAMEWORK=#{path} does not exist" unless File.exist?(path)
    return path if File.directory?(path)

    sha = file_sha256(path)
    unpacked = File.join(cache_dir(env), 'local', sha[0, 16])
    xcf = File.join(unpacked, XCFRAMEWORK)
    unless File.directory?(xcf)
      tmp = "#{unpacked}.tmp-#{Process.pid}"
      FileUtils.rm_rf(tmp)
      begin
        unzip(path, tmp)
        raise Error, "#{path} has no #{XCFRAMEWORK} at its root" unless
          File.directory?(File.join(tmp, XCFRAMEWORK))

        FileUtils.mkdir_p(File.dirname(unpacked))
        FileUtils.rm_rf(unpacked)
        File.rename(tmp, unpacked)
      ensure
        FileUtils.rm_rf(tmp)
      end
    end
    xcf
  end

  # Copies `src` to `dest` unless dest already carries `stamp`. The copy goes to a temporary
  # sibling first, so an interrupted run never leaves a half-copied framework behind a valid stamp.
  def install_copy(src, dest, stamp)
    stamp_file = File.join(dest, STAMP)
    return false if File.file?(stamp_file) && File.read(stamp_file).strip == stamp

    tmp = "#{dest}.tmp-#{Process.pid}"
    FileUtils.rm_rf(tmp)
    FileUtils.mkdir_p(File.dirname(dest))
    begin
      FileUtils.cp_r(src, tmp, preserve: true)
      FileUtils.rm_f(File.join(tmp, STAMP))
      File.write(File.join(tmp, STAMP), "#{stamp}\n")
      FileUtils.rm_rf(dest)
      File.rename(tmp, dest)
    ensure
      FileUtils.rm_rf(tmp)
    end
    true
  end

  # lock -> (local override | cache -> sha256) -> validate -> copy. Returns the vendored path.
  def ensure_xcframework!(root, env: ENV, downloader: method(:curl_download), log: nil)
    log ||= ->(msg) { defined?(Pod::UI) ? Pod::UI.puts(msg) : warn(msg) }
    warn_log = ->(msg) { defined?(Pod::UI) ? Pod::UI.warn(msg) : warn(msg) }
    lk = lock(root)
    local = local_override(env)
    if local
      src = resolve_local(local, env: env)
      stamp = "local:#{tree_digest(src)}"
      log.call("[RNSpeech] Phonon: using local #{src}")
    else
      src = fetch_release(root, lk, env: env, downloader: downloader, log: log)
      stamp = "release:#{lk.dig('binaries', 'release')}:#{ios_sha(lk)}"
    end
    validate!(src).each { |w| warn_log.call("[RNSpeech] #{w}") }
    dest = destination(root)
    log.call("[RNSpeech] Phonon: installed #{XCFRAMEWORK}") if install_copy(src, dest, stamp)
    dest
  end
end
