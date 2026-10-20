// PhononIosPolicy.h — the iOS bridge's decisions as pure C++, so they are host-tested
// (test/phonon-ios) as well as covered by XCTest. No Apple APIs here: RNSpeechPhonon.mm
// gathers the inputs (OS version, memory, files, env) and applies the results.
// See docs/phonon/DESIGN.md §2.2 (support order), §2.4 (capability store, recovery).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rnspeech::phonon::ios {

// physicalMemory floor (§2.2 step 6): a floor only, not a measured requirement.
constexpr uint64_t kMinPhysicalMemory = 3ull << 30;

struct SupportInputs {
  std::string forcedReason;  // DEBUG-only override ("" = none)
  std::string recordReason;  // applicable negative capability record ("" = none)
  std::string recordDetail;
  bool osAtLeast18 = false;
  bool x86Simulator = false;  // the xcframework's x86_64 simulator slice is a stub
  uint64_t physicalMemory = 0;
};

struct SupportDecision {
  bool supported = false;
  std::string reason;  // PhononSupportInfo.reason
  std::string detail;
};

// §2.2 steps 2–7, in order (step 1, not-compiled, is the flag-off stub in RNSpeech.mm).
SupportDecision decide_support(const SupportInputs& in);

// True if any "<name>.mlpackage" in `entries` (a directory listing) has no "<name>.mlmodelc"
// beside it: ptts_new would compile it first (upstream Phonon.needsCompiling).
bool needs_compile(const std::vector<std::string>& entries);

// The "<name>.mlmodelc" entries that have a "<name>.mlpackage" beside them, i.e. the compiled
// models a recovery may delete because ptts_new can rebuild them. A precompiled-only bundle
// returns nothing: deleting its .mlmodelc would destroy the model.
std::vector<std::string> recompilable_models(const std::vector<std::string>& entries);

// Whether a PHONON_LOAD_FAILED message is a device capability failure worth persisting as
// `load-failed` (Core ML compile / model load / ANE plan), rather than a path or bundle error
// the app can fix (missing file, bad bundle.json, no voices, bad language).
bool should_persist_load_error(const std::string& message);

// Playback gain for phononPlayBuffer: volume clamped to [0, 1] like the OS-TTS path
// (getValidatedOptions); NaN / missing → 1.
float playback_gain(double volume, bool hasVolume);

// out[i] = clamp(in[i] * gain, -1, 1); NaN → 0. `in` may equal `out`.
void apply_gain_clamp(const float* in, size_t n, float gain, float* out) noexcept;

// Effective compute unit reported to JS. The simulator has no Neural Engine: Core ML runs a
// 'neuralEngine' request on the CPU there, so that is what is reported.
std::string effective_compute_unit(const std::string& mapped, bool isSimulator);

struct CapabilityKey {
  std::string machine;  // hw.machine (device) / SIMULATOR_MODEL_IDENTIFIER
  std::string osBuild;  // kern.osversion
  std::string libraryVersion;
  bool operator==(const CapabilityKey& o) const {
    return machine == o.machine && osBuild == o.osBuild && libraryVersion == o.libraryVersion;
  }
};

struct CapabilityRecord {
  CapabilityKey key;
  std::string modelPath;   // model the failure happened with ("" = model independent)
  std::string modelStamp;  // stamp of that model then
  std::string reason;
  std::string detail;
};

// A stored negative record applies only while every key part is unchanged: same device, OS
// build, library version, and the model it failed with still has the same stamp
// (`currentModelStamp` = stamp of record.modelPath now). Any change re-enables the probe.
bool record_applies(const CapabilityRecord& record, const CapabilityKey& current,
                    const std::string& currentModelStamp);

}  // namespace rnspeech::phonon::ios
