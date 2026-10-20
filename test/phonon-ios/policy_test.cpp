// Host tests for ios/phonon/PhononIosPolicy (support order, compile detection, recovery set,
// load-error classification, gain, capability-record matching). Build/run:
// scripts/test-phonon-ios.sh. The same decisions are exercised on iOS by PhononTests.m.
#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "../phonon-core/test_harness.h"
#include "PhononIosPolicy.h"

using namespace rnspeech::phonon::ios;

namespace {

SupportInputs good() {
  SupportInputs in;
  in.osAtLeast18 = true;
  in.physicalMemory = 6ull << 30;  // iPhone 13 Pro
  return in;
}

}  // namespace

TEST(support_ok_on_ios18_arm64) {
  SupportDecision d = decide_support(good());
  CHECK(d.supported);
  CHECK_EQ(d.reason, std::string("ok"));
}

TEST(support_forced_reason_wins_over_everything) {
  SupportInputs in = good();
  in.forcedReason = "low-memory";
  in.recordReason = "load-failed";
  in.osAtLeast18 = false;
  SupportDecision d = decide_support(in);
  CHECK(!d.supported);
  CHECK_EQ(d.reason, std::string("low-memory"));
  CHECK_EQ(d.detail, std::string("forced"));
}

TEST(support_record_before_os_check) {
  SupportInputs in = good();
  in.recordReason = "load-failed";
  in.recordDetail = "compileModelAtURL: E5RT";
  in.osAtLeast18 = false;
  SupportDecision d = decide_support(in);
  CHECK(!d.supported);
  CHECK_EQ(d.reason, std::string("load-failed"));
  CHECK_EQ(d.detail, std::string("compileModelAtURL: E5RT"));
}

TEST(support_os_too_old) {
  SupportInputs in = good();
  in.osAtLeast18 = false;
  in.x86Simulator = true;
  in.physicalMemory = 1;
  CHECK_EQ(decide_support(in).reason, std::string("os-too-old"));
}

TEST(support_x86_simulator_unsupported_abi) {
  SupportInputs in = good();
  in.x86Simulator = true;
  in.physicalMemory = 1;
  SupportDecision d = decide_support(in);
  CHECK(!d.supported);
  CHECK_EQ(d.reason, std::string("unsupported-abi"));
}

TEST(support_low_memory_floor) {
  SupportInputs in = good();
  in.physicalMemory = kMinPhysicalMemory - 1;
  SupportDecision d = decide_support(in);
  CHECK(!d.supported);
  CHECK_EQ(d.reason, std::string("low-memory"));
  CHECK(d.detail.find("MB") != std::string::npos);
  in.physicalMemory = kMinPhysicalMemory;
  CHECK(decide_support(in).supported);
}

TEST(needs_compile_matches_upstream) {
  CHECK(!needs_compile({}));
  CHECK(!needs_compile({"bundle.json", "voices", "tokenizer.json"}));
  // Precompiled mirror: .mlmodelc only.
  CHECK(!needs_compile({"bundle.json", "flow_t1.mlmodelc", "mimi.mlmodelc"}));
  CHECK(needs_compile({"bundle.json", "flow_t1.mlpackage", "mimi.mlpackage", "mimi.mlmodelc"}));
  CHECK(!needs_compile({"flow_t1.mlpackage", "flow_t1.mlmodelc"}));
  // A bare suffix is not a model.
  CHECK(!needs_compile({".mlpackage"}));
}

TEST(recompilable_only_with_package_beside) {
  CHECK(recompilable_models({"a.mlmodelc", "b.mlmodelc"}).empty());
  std::vector<std::string> r =
      recompilable_models({"b.mlmodelc", "b.mlpackage", "a.mlpackage", "a.mlmodelc", "c.mlmodelc"});
  CHECK_EQ(r.size(), size_t(2));
  CHECK_EQ(r[0], std::string("a.mlmodelc"));
  CHECK_EQ(r[1], std::string("b.mlmodelc"));
}

TEST(load_error_classification) {
  // Path / bundle errors (upstream ptts-ffi coreml.rs messages): fixable, never persisted.
  CHECK(!should_persist_load_error("bundle.json: No such file or directory (os error 2)"));
  CHECK(!should_persist_load_error("bundle.json has no ctx"));
  CHECK(!should_persist_load_error("no voices in the bundle"));
  CHECK(!should_persist_load_error("voice x has no `emb` tensor"));
  CHECK(!should_persist_load_error("unknown compute unit 7"));
  CHECK(!should_persist_load_error(
      "/m/flow_t1.mlmodelc: Error Domain=com.apple.CoreML Code=3 \"The file doesn't exist.\""));
  CHECK(!should_persist_load_error(
      "compileModelAtURL: Error Domain=NSCocoaErrorDomain Code=260 \"The file couldn\xe2\x80\x99t be opened\""));
  CHECK(!should_persist_load_error("caching /m/flow_t1.mlmodelc: No space left on device (os error 28)"));
  CHECK(!should_persist_load_error(""));
  CHECK(!should_persist_load_error("ptts_new failed"));
  // Device capability failures: persisted.
  CHECK(should_persist_load_error(
      "compileModelAtURL: Error Domain=com.apple.CoreML Code=0 \"Failed to compile the model\""));
  CHECK(should_persist_load_error(
      "/m/flow_t48.mlmodelc: Error Domain=com.apple.CoreML Code=0 \"E5RT: Unable to plan program\""));
  CHECK(should_persist_load_error("ANE program load failed: Espresso exception"));
  CHECK(should_persist_load_error("MLModel load failed for Neural Engine"));
}

TEST(gain_and_clamp) {
  CHECK_EQ(playback_gain(0.5, true), 0.5f);
  CHECK_EQ(playback_gain(2.0, true), 1.0f);
  CHECK_EQ(playback_gain(-1.0, true), 0.0f);
  CHECK_EQ(playback_gain(0.3, false), 1.0f);
  CHECK_EQ(playback_gain(std::nan(""), true), 1.0f);

  const float nan = std::numeric_limits<float>::quiet_NaN();
  std::vector<float> v = {0.5f, -0.5f, 1.5f, -3.0f, nan, 0.0f};
  apply_gain_clamp(v.data(), v.size(), 2.0f, v.data());  // in place
  CHECK_EQ(v[0], 1.0f);
  CHECK_EQ(v[1], -1.0f);
  CHECK_EQ(v[2], 1.0f);
  CHECK_EQ(v[3], -1.0f);
  CHECK_EQ(v[4], 0.0f);
  CHECK_EQ(v[5], 0.0f);
  std::vector<float> in = {0.25f}, out(1);
  apply_gain_clamp(in.data(), 1, 0.5f, out.data());
  CHECK_EQ(out[0], 0.125f);
  apply_gain_clamp(nullptr, 0, 1.0f, nullptr);  // empty is fine
}

TEST(effective_unit_on_simulator_is_cpu) {
  CHECK_EQ(effective_compute_unit("neuralEngine", false), std::string("neuralEngine"));
  CHECK_EQ(effective_compute_unit("cpu", false), std::string("cpu"));
  CHECK_EQ(effective_compute_unit("neuralEngine", true), std::string("cpu"));
}

TEST(capability_record_matching) {
  CapabilityKey key{"iPhone14,2", "23H31", "0.4.0-r1"};
  CapabilityRecord rec;
  rec.key = key;
  rec.reason = "load-failed";
  rec.modelPath = "/m";
  rec.modelStamp = "sha-a";
  CHECK(record_applies(rec, key, "sha-a"));
  // Model changed (re-downloaded / updated) -> re-evaluate.
  CHECK(!record_applies(rec, key, "sha-b"));
  CHECK(!record_applies(rec, key, "none"));
  // OS update, other library release, other device -> re-evaluate.
  CHECK(!record_applies(rec, CapabilityKey{"iPhone14,2", "23H40", "0.4.0-r1"}, "sha-a"));
  CHECK(!record_applies(rec, CapabilityKey{"iPhone14,2", "23H31", "0.4.0-r2"}, "sha-a"));
  CHECK(!record_applies(rec, CapabilityKey{"iPhone15,2", "23H31", "0.4.0-r1"}, "sha-a"));
  // Model-independent record (no path): matches on the key alone.
  rec.modelPath.clear();
  CHECK(record_applies(rec, key, "anything"));
  // Empty reason never applies.
  rec.reason.clear();
  CHECK(!record_applies(rec, key, ""));
}

int main(int argc, char** argv) { return harness::run_all(argc > 1 ? argv[1] : nullptr); }
