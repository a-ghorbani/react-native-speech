#include "PhononIosPolicy.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>

namespace rnspeech::phonon::ios {

namespace {

const char kPackage[] = ".mlpackage";
const char kCompiled[] = ".mlmodelc";

bool ends_with(const std::string& s, const std::string& suffix) {
  return s.size() > suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string stem(const std::string& s, size_t suffixLen) { return s.substr(0, s.size() - suffixLen); }

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

bool contains_any(const std::string& haystack, std::initializer_list<const char*> needles) {
  for (const char* n : needles) {
    if (haystack.find(n) != std::string::npos) return true;
  }
  return false;
}

}  // namespace

SupportDecision decide_support(const SupportInputs& in) {
  SupportDecision d;
  if (!in.forcedReason.empty()) {
    d.reason = in.forcedReason;
    d.detail = "forced";
    return d;
  }
  if (!in.recordReason.empty()) {
    d.reason = in.recordReason;
    d.detail = in.recordDetail;
    return d;
  }
  if (!in.osAtLeast18) {
    d.reason = "os-too-old";
    d.detail = "Phonon needs iOS 18 (Core ML 8 programs)";
    return d;
  }
  if (in.x86Simulator) {
    d.reason = "unsupported-abi";
    d.detail = "x86_64 simulator: the Phonon library is a stub on this architecture";
    return d;
  }
  if (in.physicalMemory < kMinPhysicalMemory) {
    d.reason = "low-memory";
    d.detail = "physicalMemory " + std::to_string(in.physicalMemory >> 20) + " MB < " +
               std::to_string(kMinPhysicalMemory >> 20) + " MB";
    return d;
  }
  d.supported = true;
  d.reason = "ok";
  return d;
}

bool needs_compile(const std::vector<std::string>& entries) {
  std::set<std::string> names(entries.begin(), entries.end());
  for (const std::string& e : entries) {
    if (ends_with(e, kPackage) &&
        names.count(stem(e, sizeof(kPackage) - 1) + kCompiled) == 0) {
      return true;
    }
  }
  return false;
}

std::vector<std::string> recompilable_models(const std::vector<std::string>& entries) {
  std::set<std::string> names(entries.begin(), entries.end());
  std::vector<std::string> out;
  for (const std::string& e : entries) {
    if (ends_with(e, kCompiled) && names.count(stem(e, sizeof(kCompiled) - 1) + kPackage) != 0) {
      out.push_back(e);
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

bool should_persist_load_error(const std::string& message) {
  const std::string m = lower(message);
  // App-fixable (path, download, bundle, options): never hide the engine.
  if (contains_any(m, {"no such file", "os error 2", "doesn't exist", "does not exist",
                       "doesn\xe2\x80\x99t exist", "couldn't be opened", "couldn\xe2\x80\x99t be opened",
                       "not found", "bundle.json", "tokenizer", "no voices", "has no `emb`",
                       "unknown compute unit", "language", "permission denied", "os error 13",
                       "no space", "os error 28", "caching "})) {
    return false;
  }
  // Device capability: Core ML could not compile, load or plan the model here.
  return contains_any(m, {"compilemodelaturl", ".mlmodelc", "mlmodel", "coreml", "core ml",
                          "neural engine", "espresso", "e5rt"});
}

float playback_gain(double volume, bool hasVolume) {
  if (!hasVolume || std::isnan(volume)) return 1.0f;
  return static_cast<float>(std::max(0.0, std::min(1.0, volume)));
}

void apply_gain_clamp(const float* in, size_t n, float gain, float* out) noexcept {
  for (size_t i = 0; i < n; ++i) {
    const float v = in[i] * gain;
    out[i] = std::isnan(v) ? 0.0f : std::max(-1.0f, std::min(1.0f, v));
  }
}

std::string effective_compute_unit(const std::string& mapped, bool isSimulator) {
  return isSimulator ? std::string("cpu") : mapped;
}

bool record_applies(const CapabilityRecord& record, const CapabilityKey& current,
                    const std::string& currentModelStamp) {
  if (record.reason.empty() || !(record.key == current)) return false;
  return record.modelPath.empty() || record.modelStamp == currentModelStamp;
}

}  // namespace rnspeech::phonon::ios
