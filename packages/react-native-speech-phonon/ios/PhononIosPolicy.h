// iOS bridge decisions as pure C++ (no Apple APIs) so test/ios can host-test them.
// See docs/DESIGN.md §2.2 (support order), §2.4 (capability store, recovery).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rnspeech::phonon::ios {

// §2.2 step 6: a floor, not a measured requirement.
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

// §2.2 steps 2–7 (step 1, not-compiled, is JS finding no RNSpeechPhonon module).
SupportDecision decide_support(const SupportInputs& in);

// True if any "<name>.mlpackage" in a directory listing lacks a sibling "<name>.mlmodelc"
// (upstream Phonon.needsCompiling).
bool needs_compile(const std::vector<std::string>& entries);

// "<name>.mlmodelc" entries with a sibling "<name>.mlpackage", i.e. safe for recovery to delete
// because ptts_new can rebuild them.
std::vector<std::string> recompilable_models(const std::vector<std::string>& entries);

// Whether a PHONON_LOAD_FAILED message is a device capability failure (persisted as
// `load-failed`) rather than an app-fixable path/bundle error. Matches message text because
// ptts_new reports no error category.
bool should_persist_load_error(const std::string& message);

// Volume clamped to [0, 1] like getValidatedOptions; NaN / missing -> 1.
float playback_gain(double volume, bool hasVolume);

// out[i] = clamp(in[i] * gain, -1, 1); NaN → 0. `in` may equal `out`.
void apply_gain_clamp(const float* in, size_t n, float gain, float* out) noexcept;

// The simulator has no Neural Engine, so Core ML runs every request on the CPU there.
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

// A negative record applies only while the key and the failing model's stamp
// (`currentModelStamp`, of record.modelPath now) are unchanged.
bool record_applies(const CapabilityRecord& record, const CapabilityKey& current,
                    const std::string& currentModelStamp);

}  // namespace rnspeech::phonon::ios
