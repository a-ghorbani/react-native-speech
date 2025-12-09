# Build Scripts

Automated build scripts for espeak-ng integration.

## Available Scripts

### `setup-espeak.sh` - Main Setup Script

**Interactive setup for both platforms**

```bash
./scripts/setup-espeak.sh
```

- Initializes git submodules
- Asks which platform(s) to build for
- Runs appropriate build scripts
- Handles all automation

**Recommended for first-time setup.**

---

### `build-espeak-android.sh` - Android Build

**Builds espeak-ng for Android (all ABIs)**

```bash
./scripts/build-espeak-android.sh
```

**What it does:**
- Cross-compiles espeak-ng for Android (arm64-v8a, armeabi-v7a, x86, x86_64)
- Creates static libraries (.a files)
- Copies to `android/libs/espeak-ng/`
- Extracts espeak-ng-data to assets
- Optionally removes non-English languages

**Requirements:**
- Android NDK (set `ANDROID_NDK_HOME`)
- Build tools: autoconf, automake, libtool, pkg-config

**Time:** ~5-10 minutes

---

### `build-espeak-ios-framework.sh` - iOS XCFramework Build

**Builds espeak-ng as XCFramework for iOS (professional distribution)**

```bash
./scripts/build-espeak-ios-framework.sh
```

**What it does:**
- Builds espeak-ng for iOS device (arm64)
- Builds espeak-ng for iOS simulator (x86_64 + arm64)
- Creates universal XCFramework at `ios/espeak-ng.xcframework/`
- Copies espeak-ng-data to `ios/espeak-ng-data/`
- Optionally removes non-English languages
- **Users just run `pod install` - no manual Xcode configuration needed!**

**Requirements:**
- macOS with Xcode 15 or later
- Build tools: autoconf, automake, libtool, pkg-config

**Time:** ~10-15 minutes

---

## Quick Reference

| Need | Command |
|------|---------|
| **First time setup** | `./scripts/setup-espeak.sh` |
| **Android only** | `./scripts/build-espeak-android.sh` |
| **iOS only** | `./scripts/build-espeak-ios-framework.sh` |
| **Rebuild all** | `./scripts/setup-espeak.sh` → choose "Both" |
| **Update espeak-ng** | `git submodule update --remote` then rebuild |

---

## Troubleshooting

### Script not executable

```bash
chmod +x scripts/*.sh
```

### Build fails

1. Check prerequisites are installed
2. Check `ANDROID_NDK_HOME` is set (Android)
3. Run `git submodule update --init --recursive`
4. Check detailed logs in terminal

### Clean and rebuild

```bash
# Clean espeak-ng
cd third-party/espeak-ng
make clean
cd ../..

# Rebuild
./scripts/setup-espeak.sh
```

---

## CI/CD Usage

```yaml
# GitHub Actions example
- name: Setup espeak-ng
  run: |
    git submodule update --init --recursive
    export ANDROID_NDK_HOME=$ANDROID_NDK_ROOT
    ./scripts/build-espeak-android.sh
```

---

## Advanced

### Custom Build Options

Edit the build scripts to customize:
- Target ABIs
- Compiler flags
- Data bundling
- Language selection

### Parallel Builds

Speed up Android builds:

```bash
# Edit build-espeak-android.sh
# Change: make -j$(nproc)
# To:     make -j8  # or your preferred number
```

---

## Support

See [ESPEAK_SETUP.md](../ESPEAK_SETUP.md) for detailed documentation.
