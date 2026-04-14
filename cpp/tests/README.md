# native_dict fuzz target

Standalone harness that feeds crafted EPD1 blobs through `NativeDict` and
verifies no case crashes. No libFuzzer / AFL dependency — plain C++17.

## Build & run

From the repo root:

```sh
g++ -std=c++17 -O1 -Wall -Wextra -I cpp/ \
    cpp/native_dict.cpp cpp/tests/fuzz_native_dict.cpp \
    -o /tmp/fuzz_native_dict

/tmp/fuzz_native_dict
```

Expected exit code `0` — every case is handled without a crash. Any non-zero
exit indicates either a wrong open() verdict or an uncaught exception.

## Coverage

- Truncated blob (<64 bytes)
- Bad magic / wrong version
- `offset = UINT64_MAX`, `size = UINT64_MAX`, `offset+size` overflow
- `n_entries = UINT32_MAX`
- `koff_size != (n+1)*4`
- Decreasing offsets in key table
- Offsets past EOF
- Unaligned `koff_off` (EPD1 builder 64-byte aligns, but parser uses memcpy
  so it must still open correctly)
- Zero-entry dict (opens; lookup always misses)
- Single valid entry
- Multi-entry sorted dict (lookup hits + misses)
- Random garbage at several sizes
