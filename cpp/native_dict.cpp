// native_dict.cpp — mmap'd EPD1 dict reader.
#include "native_dict.h"

#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace rnspeech {

namespace {

constexpr uint32_t kMagic = 0x31445045;  // "EPD1" little-endian
constexpr uint32_t kVersion = 1;

inline uint32_t read_u32(const uint8_t* p) {
  uint32_t v;
  std::memcpy(&v, p, sizeof(v));
  return v;
}

inline uint64_t read_u64(const uint8_t* p) {
  uint64_t v;
  std::memcpy(&v, p, sizeof(v));
  return v;
}

}  // namespace

NativeDict::~NativeDict() { close(); }

void NativeDict::close() {
  if (data_ != nullptr) {
    munmap(const_cast<uint8_t*>(data_), size_);
    data_ = nullptr;
    size_ = 0;
  }
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  n_entries_ = 0;
  keys_blob_ = nullptr;
  vals_blob_ = nullptr;
  keys_offsets_ = nullptr;
  vals_offsets_ = nullptr;
}

bool NativeDict::open(const std::string& path) {
  close();

  fd_ = ::open(path.c_str(), O_RDONLY);
  if (fd_ < 0) return false;

  struct stat st;
  if (::fstat(fd_, &st) != 0 || st.st_size < 64) {
    close();
    return false;
  }
  size_ = static_cast<size_t>(st.st_size);

  void* m = ::mmap(nullptr, size_, PROT_READ, MAP_PRIVATE, fd_, 0);
  if (m == MAP_FAILED) {
    close();
    return false;
  }
  data_ = static_cast<const uint8_t*>(m);

  // Header
  if (read_u32(data_ + 0) != kMagic) {
    close();
    return false;
  }
  if (read_u32(data_ + 4) != kVersion) {
    close();
    return false;
  }
  n_entries_ = read_u32(data_ + 8);

  uint64_t keys_off = read_u64(data_ + 16);
  uint64_t keys_size = read_u64(data_ + 24);
  uint64_t vals_off = read_u64(data_ + 32);
  uint64_t vals_size = read_u64(data_ + 40);
  uint64_t koff_off = read_u64(data_ + 48);
  uint64_t voff_off = read_u64(data_ + 56);

  // Bounds check
  uint64_t koff_size = static_cast<uint64_t>(n_entries_ + 1) * 4;
  uint64_t voff_size = koff_size;
  if (keys_off + keys_size > size_ || vals_off + vals_size > size_ ||
      koff_off + koff_size > size_ || voff_off + voff_size > size_) {
    close();
    return false;
  }

  keys_blob_ = data_ + keys_off;
  vals_blob_ = data_ + vals_off;
  keys_offsets_ = reinterpret_cast<const uint32_t*>(data_ + koff_off);
  vals_offsets_ = reinterpret_cast<const uint32_t*>(data_ + voff_off);
  return true;
}

std::optional<std::string_view> NativeDict::lookup(std::string_view word) const {
  if (data_ == nullptr || n_entries_ == 0) return std::nullopt;

  uint32_t lo = 0;
  uint32_t hi = n_entries_;
  const auto* wbytes = reinterpret_cast<const uint8_t*>(word.data());
  size_t wlen = word.size();

  while (lo < hi) {
    uint32_t mid = lo + (hi - lo) / 2;
    uint32_t s = keys_offsets_[mid];
    uint32_t e = keys_offsets_[mid + 1];
    size_t klen = e - s;
    size_t cmp_len = klen < wlen ? klen : wlen;
    int cmp = std::memcmp(keys_blob_ + s, wbytes, cmp_len);
    if (cmp == 0) {
      if (klen == wlen) {
        uint32_t vs = vals_offsets_[mid];
        uint32_t ve = vals_offsets_[mid + 1];
        return std::string_view(
            reinterpret_cast<const char*>(vals_blob_ + vs), ve - vs);
      }
      cmp = klen < wlen ? -1 : 1;
    }
    if (cmp < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return std::nullopt;
}

}  // namespace rnspeech
