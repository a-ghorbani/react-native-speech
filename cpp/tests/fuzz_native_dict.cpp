// fuzz_native_dict.cpp — standalone harness that feeds crafted EPD1 blobs
// through NativeDict::open() / lookup() and verifies no case crashes.
//
// Build:
//   g++ -std=c++17 -O1 -Wall -Wextra -I cpp/ \
//       cpp/native_dict.cpp cpp/tests/fuzz_native_dict.cpp \
//       -o /tmp/fuzz_native_dict
// Run:
//   /tmp/fuzz_native_dict
//
// Expected exit 0 — every crafted blob is either opened successfully (with
// correct lookup behaviour) or cleanly rejected without a crash.

#include "native_dict.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr uint32_t kMagic = 0x31445045;  // "EPD1"

struct Header {
  uint32_t magic = kMagic;
  uint32_t version = 1;
  uint32_t n_entries = 0;
  uint32_t pad = 0;
  uint64_t keys_off = 0;
  uint64_t keys_size = 0;
  uint64_t vals_off = 0;
  uint64_t vals_size = 0;
  uint64_t koff_off = 0;
  uint64_t voff_off = 0;
};
static_assert(sizeof(Header) == 64, "EPD1 header is 64 bytes");

void put_u32(std::vector<uint8_t>& b, size_t off, uint32_t v) {
  std::memcpy(b.data() + off, &v, sizeof(v));
}
void put_u64(std::vector<uint8_t>& b, size_t off, uint64_t v) {
  std::memcpy(b.data() + off, &v, sizeof(v));
}

// Build a well-formed EPD1 blob from (key,val) pairs. Sections are 64-byte
// aligned to match scripts/build-dict.mjs.
std::vector<uint8_t> buildGood(
    const std::vector<std::pair<std::string, std::string>>& sorted_pairs) {
  const uint32_t n = static_cast<uint32_t>(sorted_pairs.size());
  uint64_t keys_size = 0, vals_size = 0;
  for (auto& p : sorted_pairs) {
    keys_size += p.first.size();
    vals_size += p.second.size();
  }
  const uint64_t koff_bytes = (static_cast<uint64_t>(n) + 1) * 4;
  const uint64_t voff_bytes = koff_bytes;

  auto align = [](uint64_t x) -> uint64_t { return (x + 63) & ~63ULL; };
  const uint64_t keys_off = align(64);
  const uint64_t vals_off = align(keys_off + keys_size);
  const uint64_t koff_off = align(vals_off + vals_size);
  const uint64_t voff_off = align(koff_off + koff_bytes);
  const uint64_t total = voff_off + voff_bytes;

  std::vector<uint8_t> buf(total, 0);
  put_u32(buf, 0, kMagic);
  put_u32(buf, 4, 1);
  put_u32(buf, 8, n);
  put_u64(buf, 16, keys_off);
  put_u64(buf, 24, keys_size);
  put_u64(buf, 32, vals_off);
  put_u64(buf, 40, vals_size);
  put_u64(buf, 48, koff_off);
  put_u64(buf, 56, voff_off);

  uint32_t kacc = 0, vacc = 0;
  size_t kpos = keys_off, vpos = vals_off;
  for (uint32_t i = 0; i < n; ++i) {
    put_u32(buf, koff_off + i * 4, kacc);
    put_u32(buf, voff_off + i * 4, vacc);
    const auto& k = sorted_pairs[i].first;
    const auto& v = sorted_pairs[i].second;
    std::memcpy(buf.data() + kpos, k.data(), k.size());
    std::memcpy(buf.data() + vpos, v.data(), v.size());
    kpos += k.size();
    vpos += v.size();
    kacc += static_cast<uint32_t>(k.size());
    vacc += static_cast<uint32_t>(v.size());
  }
  put_u32(buf, koff_off + n * 4, kacc);
  put_u32(buf, voff_off + n * 4, vacc);
  return buf;
}

struct Case {
  const char* name;
  std::vector<uint8_t> blob;
  bool expect_open;        // true => open() should succeed
  // Optional lookup checks when expect_open=true:
  std::vector<std::pair<std::string, std::string>> expect_hits;
  std::vector<std::string> expect_miss;
};

int g_failures = 0;

void runCase(Case& c) {
  // Write to a temp file and open via NativeDict.
  fs::path tmp = fs::temp_directory_path() /
                 ("fuzz_native_dict_" + std::string(c.name) + ".bin");
  {
    std::ofstream f(tmp, std::ios::binary);
    f.write(reinterpret_cast<const char*>(c.blob.data()),
            static_cast<std::streamsize>(c.blob.size()));
  }

  rnspeech::NativeDict dict;
  bool opened = false;
  try {
    opened = dict.open(tmp.string());
  } catch (...) {
    std::fprintf(stderr, "[FAIL] %s: open() threw\n", c.name);
    ++g_failures;
    fs::remove(tmp);
    return;
  }

  if (opened != c.expect_open) {
    std::fprintf(stderr, "[FAIL] %s: open()=%d expected=%d\n", c.name,
                 opened, c.expect_open);
    ++g_failures;
    fs::remove(tmp);
    return;
  }

  // Always try a lookup — it must never crash, even on a closed dict.
  try {
    (void)dict.lookup("foo");
    (void)dict.lookup("");
    (void)dict.lookup(std::string(4096, 'x'));
  } catch (...) {
    std::fprintf(stderr, "[FAIL] %s: lookup() threw\n", c.name);
    ++g_failures;
    fs::remove(tmp);
    return;
  }

  if (opened) {
    for (auto& kv : c.expect_hits) {
      auto r = dict.lookup(kv.first);
      if (!r || std::string(*r) != kv.second) {
        std::fprintf(stderr, "[FAIL] %s: lookup(%s) expected hit '%s'\n",
                     c.name, kv.first.c_str(), kv.second.c_str());
        ++g_failures;
      }
    }
    for (auto& k : c.expect_miss) {
      auto r = dict.lookup(k);
      if (r) {
        std::fprintf(stderr, "[FAIL] %s: lookup(%s) expected miss\n",
                     c.name, k.c_str());
        ++g_failures;
      }
    }
  }

  std::printf("[ok]   %s\n", c.name);
  fs::remove(tmp);
}

std::vector<uint8_t> tinyBlob(size_t n) { return std::vector<uint8_t>(n, 0xAA); }

}  // namespace

int main() {
  std::vector<Case> cases;

  // 1. Truncated (< 64 bytes)
  cases.push_back({"truncated_32", tinyBlob(32), false, {}, {}});

  // 2. Bad magic
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u32(b, 0, 0xDEADBEEF);
    cases.push_back({"bad_magic", std::move(b), false, {}, {}});
  }

  // 3. Wrong version
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u32(b, 4, 2);
    cases.push_back({"wrong_version", std::move(b), false, {}, {}});
  }

  // 4. keys_off = UINT64_MAX
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u64(b, 16, UINT64_MAX);
    cases.push_back({"off_uint64_max", std::move(b), false, {}, {}});
  }

  // 4b. keys_size = UINT64_MAX
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u64(b, 24, UINT64_MAX);
    cases.push_back({"size_uint64_max", std::move(b), false, {}, {}});
  }

  // 4c. keys_off + keys_size overflow (off near max, size small, wraps)
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u64(b, 16, UINT64_MAX - 2);
    put_u64(b, 24, 100);
    cases.push_back({"off_plus_size_overflow", std::move(b), false, {}, {}});
  }

  // 5. n_entries = UINT32_MAX
  {
    auto b = buildGood({{"apple", "AE1"}});
    put_u32(b, 8, UINT32_MAX);
    cases.push_back({"n_entries_uint32_max", std::move(b), false, {}, {}});
  }

  // 6. koff_size != (n+1)*4 — shrink koff region by lying about its offset,
  // placing it so only 4 bytes remain in file.
  {
    auto b = buildGood({{"apple", "AE1"}, {"banana", "B"}});
    // Force koff_off near end so (n+1)*4 = 12 bytes won't fit.
    put_u64(b, 48, b.size() - 4);
    cases.push_back({"koff_size_short", std::move(b), false, {}, {}});
  }

  // 7. Decreasing offsets in key table
  {
    auto b = buildGood({{"apple", "AE1"}, {"banana", "B"}, {"cherry", "C"}});
    const uint64_t koff_off = 0;
    uint64_t v; std::memcpy(&v, b.data() + 48, 8);
    const uint64_t ko = v;
    (void)koff_off;
    // Write decreasing: slot[1] > slot[2]
    put_u32(b, ko + 1 * 4, 100);
    put_u32(b, ko + 2 * 4, 5);
    cases.push_back({"decreasing_offsets", std::move(b), false, {}, {}});
  }

  // 8. Offsets past keys_size (last sentinel > keys_size)
  {
    auto b = buildGood({{"apple", "AE1"}});
    uint64_t ko; std::memcpy(&ko, b.data() + 48, 8);
    put_u32(b, ko + 1 * 4, 0xFFFFFFFF);
    cases.push_back({"offset_past_eof", std::move(b), false, {}, {}});
  }

  // 9. Unaligned koff_off. EPD1 builder always 64-byte aligns, but we want
  // to confirm the memcpy-based parser tolerates unaligned input (should open
  // successfully).
  {
    auto good = buildGood({{"apple", "AE1"}, {"banana", "B"}});
    // Shift whole blob by 1 byte is messy; instead point koff_off at an
    // odd offset we control. We rebuild manually: place koff table at an
    // odd offset by inserting 1 extra pad byte before it.
    //
    // Simpler approach: rebuild with hand-chosen layout.
    std::vector<std::pair<std::string, std::string>> kv = {
        {"apple", "AE1"}, {"banana", "B"}};
    const uint32_t n = 2;
    std::string keys_blob, vals_blob;
    std::vector<uint32_t> kofs = {0}, vofs = {0};
    for (auto& p : kv) {
      keys_blob += p.first;
      vals_blob += p.second;
      kofs.push_back(static_cast<uint32_t>(keys_blob.size()));
      vofs.push_back(static_cast<uint32_t>(vals_blob.size()));
    }
    // Layout: header(64) | keys | vals | 1-byte pad | koff | voff
    const uint64_t keys_off = 64;
    const uint64_t vals_off = keys_off + keys_blob.size();
    const uint64_t koff_off = vals_off + vals_blob.size() + 1;  // odd
    const uint64_t voff_off = koff_off + (n + 1) * 4;
    const uint64_t total = voff_off + (n + 1) * 4;

    std::vector<uint8_t> b(total, 0);
    put_u32(b, 0, kMagic);
    put_u32(b, 4, 1);
    put_u32(b, 8, n);
    put_u64(b, 16, keys_off);
    put_u64(b, 24, keys_blob.size());
    put_u64(b, 32, vals_off);
    put_u64(b, 40, vals_blob.size());
    put_u64(b, 48, koff_off);
    put_u64(b, 56, voff_off);
    std::memcpy(b.data() + keys_off, keys_blob.data(), keys_blob.size());
    std::memcpy(b.data() + vals_off, vals_blob.data(), vals_blob.size());
    for (uint32_t i = 0; i <= n; ++i) {
      put_u32(b, koff_off + i * 4, kofs[i]);
      put_u32(b, voff_off + i * 4, vofs[i]);
    }
    cases.push_back({"unaligned_koff_ok", std::move(b), true,
                     {{"apple", "AE1"}, {"banana", "B"}},
                     {"cherry", "zzz"}});
  }

  // 10. Zero entries
  {
    auto b = buildGood({});
    cases.push_back({"zero_entries", std::move(b), true, {},
                     {"anything", "foo"}});
  }

  // 11. Single valid entry
  {
    auto b = buildGood({{"hello", "H EH1 L OW0"}});
    cases.push_back({"single_entry", std::move(b), true,
                     {{"hello", "H EH1 L OW0"}},
                     {"world"}});
  }

  // 12. Normal multi-entry (must be sorted bytewise)
  {
    std::vector<std::pair<std::string, std::string>> kv = {
        {"apple", "AE1 P AH0 L"},
        {"banana", "B AH0 N AE1 N AH0"},
        {"cherry", "CH EH1 R IY0"},
        {"date", "D EY1 T"},
        {"elderberry", "EH1 L D ER0 B EH2 R IY0"},
    };
    std::sort(kv.begin(), kv.end());
    auto b = buildGood(kv);
    cases.push_back({"normal_multi", std::move(b), true,
                     {{"apple", "AE1 P AH0 L"},
                      {"cherry", "CH EH1 R IY0"},
                      {"elderberry", "EH1 L D ER0 B EH2 R IY0"}},
                     {"fig", "", "zebra"}});
  }

  // 13. Random garbage of various sizes — must never crash.
  for (size_t sz : {0u, 1u, 63u, 64u, 128u, 1024u}) {
    std::vector<uint8_t> b(sz);
    for (size_t i = 0; i < sz; ++i) b[i] = static_cast<uint8_t>(i * 31 + 7);
    std::string name = "garbage_" + std::to_string(sz);
    cases.push_back({strdup(name.c_str()), std::move(b), false, {}, {}});
  }

  for (auto& c : cases) runCase(c);

  std::printf("\n%zu cases, %d failure(s)\n", cases.size(), g_failures);
  return g_failures == 0 ? 0 : 1;
}
