// native_dict.h — mmap'd EPD1 dict reader (cross-platform iOS + Android).
//
// Format described in scripts/build-dict.mjs.
//
// NOTE: This parser treats the input binary as UNTRUSTED.
// Consumer apps may load dicts downloaded from the network.
// All bounds checks must be overflow-safe.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace rnspeech {

class NativeDict {
 public:
  // Hard cap on entry count (defensive; a real dict is ~200k entries).
  static constexpr uint32_t kMaxEntries = 10'000'000;

  NativeDict() = default;
  ~NativeDict();

  NativeDict(const NativeDict&) = delete;
  NativeDict& operator=(const NativeDict&) = delete;

  // mmap the file. Validates magic, version, and ALL section offsets/sizes
  // against the file size with overflow-safe arithmetic. Additionally walks
  // both offset tables to verify they are monotonic and within the blob.
  // On any failure the dict is left closed and returns false.
  bool open(const std::string& path);

  // Release the mmap (no-op if not open).
  void close();

  bool is_open() const { return data_ != nullptr; }

  uint32_t entry_count() const { return n_entries_; }

  // Binary search; returns nullopt on miss or if no dict open. The returned
  // string_view points into the mmap'd region — valid while the dict stays
  // open. Callers should copy if they need to retain it past close().
  std::optional<std::string_view> lookup(std::string_view word) const;

 private:
  const uint8_t* data_ = nullptr;
  size_t size_ = 0;
  uint32_t n_entries_ = 0;
  const uint8_t* keys_blob_ = nullptr;
  const uint8_t* vals_blob_ = nullptr;
  // Offset tables. Stored as raw byte pointers to avoid relying on mmap
  // alignment; read via memcpy in read_off32().
  const uint8_t* keys_offsets_ = nullptr;
  const uint8_t* vals_offsets_ = nullptr;
  uint64_t keys_size_ = 0;
  uint64_t vals_size_ = 0;
  int fd_ = -1;
};

}  // namespace rnspeech
