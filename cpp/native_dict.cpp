// native_dict.cpp — mmap'd EPD1 dict reader.
//
// SECURITY: The input file is UNTRUSTED. All header fields must be
// bounds-checked with overflow-safe arithmetic, and the offset tables must
// be walked once at open() to guarantee every subsequent lookup reads only
// within validated ranges.
#include "native_dict.h"

#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace rnspeech {

namespace {

constexpr uint32_t kMagic = 0x31445045;  // "EPD1" little-endian
constexpr uint32_t kVersion = 1;
constexpr size_t kHeaderSize = 64;

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

// Read a uint32 offset from an offset table without assuming alignment.
inline uint32_t read_off32(const uint8_t* base, uint32_t idx) {
  uint32_t v;
  std::memcpy(&v, base + static_cast<size_t>(idx) * 4, sizeof(v));
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
  keys_size_ = 0;
  vals_size_ = 0;
}

bool NativeDict::open(const std::string& path) {
  close();

  fd_ = ::open(path.c_str(), O_RDONLY);
  if (fd_ < 0) return false;

  struct stat st;
  if (::fstat(fd_, &st) != 0 ||
      st.st_size < static_cast<off_t>(kHeaderSize)) {
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

  // Advise the kernel that access is random — the dict is walked via binary
  // search, so sequential read-ahead is wasted I/O. Non-fatal on failure.
  if (::madvise(const_cast<uint8_t*>(data_), size_, MADV_RANDOM) != 0) {
    // Best-effort hint; do not fail open().
  }

  // ---- Header ----
  if (read_u32(data_ + 0) != kMagic) {
    close();
    return false;
  }
  if (read_u32(data_ + 4) != kVersion) {
    close();
    return false;
  }
  n_entries_ = read_u32(data_ + 8);
  if (n_entries_ > kMaxEntries) {
    close();
    return false;
  }

  const uint64_t keys_off = read_u64(data_ + 16);
  const uint64_t keys_size = read_u64(data_ + 24);
  const uint64_t vals_off = read_u64(data_ + 32);
  const uint64_t vals_size = read_u64(data_ + 40);
  const uint64_t koff_off = read_u64(data_ + 48);
  const uint64_t voff_off = read_u64(data_ + 56);

  // ---- Overflow-safe bounds checks ----
  // For each region: off must be <= size_ AND len must be <= size_ - off.
  const uint64_t file_size = static_cast<uint64_t>(size_);

  if (keys_off > file_size || keys_size > file_size - keys_off) {
    close();
    return false;
  }
  if (vals_off > file_size || vals_size > file_size - vals_off) {
    close();
    return false;
  }

  // koff/voff must be exactly (n_entries + 1) * 4 bytes.
  // (n_entries_ + 1) fits in uint64 because n_entries_ <= kMaxEntries.
  const uint64_t koff_size =
      (static_cast<uint64_t>(n_entries_) + 1ULL) * 4ULL;
  const uint64_t voff_size = koff_size;

  if (koff_off > file_size || koff_size > file_size - koff_off) {
    close();
    return false;
  }
  if (voff_off > file_size || voff_size > file_size - voff_off) {
    close();
    return false;
  }

  // ---- Walk both offset tables once to guarantee monotonic + in-range. ----
  // (EPD1 builder always 64-byte aligns payload sections, so koff_off/voff_off
  // are aligned for uint32 in practice. But inputs are untrusted, so we read
  // via memcpy — no alignment assumption.)
  const uint8_t* koff_ptr = data_ + koff_off;
  const uint8_t* voff_ptr = data_ + voff_off;

  if (n_entries_ > 0) {
    if (read_off32(koff_ptr, 0) != 0) {
      close();
      return false;
    }
    if (read_off32(voff_ptr, 0) != 0) {
      close();
      return false;
    }
    uint32_t prev_k = 0;
    uint32_t prev_v = 0;
    for (uint32_t i = 1; i <= n_entries_; ++i) {
      const uint32_t k = read_off32(koff_ptr, i);
      const uint32_t v = read_off32(voff_ptr, i);
      if (k < prev_k || v < prev_v) {
        close();
        return false;
      }
      prev_k = k;
      prev_v = v;
    }
    if (static_cast<uint64_t>(prev_k) > keys_size ||
        static_cast<uint64_t>(prev_v) > vals_size) {
      close();
      return false;
    }
  } else {
    // Zero-entry dict: the single sentinel offset (if the table has one) must
    // be zero. koff_size == 4 in this case. Accept and lookup always misses.
    if (koff_size >= 4 && read_off32(koff_ptr, 0) != 0) {
      close();
      return false;
    }
    if (voff_size >= 4 && read_off32(voff_ptr, 0) != 0) {
      close();
      return false;
    }
  }

  keys_blob_ = data_ + keys_off;
  vals_blob_ = data_ + vals_off;
  keys_offsets_ = koff_ptr;
  vals_offsets_ = voff_ptr;
  keys_size_ = keys_size;
  vals_size_ = vals_size;
  return true;
}

std::optional<std::string_view> NativeDict::lookup(std::string_view word) const {
  if (data_ == nullptr || n_entries_ == 0) return std::nullopt;

  uint32_t lo = 0;
  uint32_t hi = n_entries_;
  const auto* wbytes = reinterpret_cast<const uint8_t*>(word.data());
  const size_t wlen = word.size();

  while (lo < hi) {
    const uint32_t mid = lo + (hi - lo) / 2;
    // Validated at open(): mid+1 <= n_entries_ since mid < n_entries_,
    // and the offset table has n_entries_+1 slots.
    const uint32_t s = read_off32(keys_offsets_, mid);
    const uint32_t e = read_off32(keys_offsets_, mid + 1);
    // Post-validated range check (cheap defense-in-depth).
    if (s > e || static_cast<uint64_t>(e) > keys_size_) {
      return std::nullopt;
    }
    const size_t klen = static_cast<size_t>(e - s);
    const size_t cmp_len = klen < wlen ? klen : wlen;
    int cmp = cmp_len == 0 ? 0 : std::memcmp(keys_blob_ + s, wbytes, cmp_len);
    if (cmp == 0) {
      if (klen == wlen) {
        const uint32_t vs = read_off32(vals_offsets_, mid);
        const uint32_t ve = read_off32(vals_offsets_, mid + 1);
        if (vs > ve || static_cast<uint64_t>(ve) > vals_size_) {
          return std::nullopt;
        }
        return std::string_view(
            reinterpret_cast<const char*>(vals_blob_ + vs),
            static_cast<size_t>(ve - vs));
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
