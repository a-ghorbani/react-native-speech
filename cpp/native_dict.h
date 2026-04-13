// native_dict.h — mmap'd EPD1 dict reader (cross-platform iOS + Android).
//
// Format described in scripts/build-dict.mjs.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace rnspeech {

class NativeDict {
 public:
  NativeDict() = default;
  ~NativeDict();

  NativeDict(const NativeDict&) = delete;
  NativeDict& operator=(const NativeDict&) = delete;

  // mmap the file. Validates magic + version. On failure leaves dict closed
  // and returns false.
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
  const uint32_t* keys_offsets_ = nullptr;
  const uint32_t* vals_offsets_ = nullptr;
  int fd_ = -1;
};

}  // namespace rnspeech
