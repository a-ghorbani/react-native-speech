/* fake_ptts.h — test controls for fake_ptts.c, a stand-in for libptts_ffi.
 *
 * The fake implements the 8 ptts_* symbols with upstream's documented semantics (thread-local
 * ptts_new error, per-handle errors, borrowed NUL-separated lists, set_voice validation, early
 * stop when the callback returns false) and records every call so tests can assert what the
 * core did. Tests reach the controls with dlsym on the handle phonon_load_api opened, or link
 * the fake statically (static-API test).
 */
#ifndef FAKE_PTTS_H
#define FAKE_PTTS_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct FakePttsState {
  /* Call counters. */
  int news, speaks, set_voices, set_languages, frees, last_errors;
  int live_handles;
  /* Behaviour knobs (reset to defaults by fake_ptts_reset). */
  int frames_per_speak; /* default 4 */
  int frame_size;       /* samples per frame, default 1920 (80 ms) */
  float sample_value;   /* default 0.25 */
  int cpu_only;         /* default 1: reject units other than PTTS_UNIT_CPU like cpu.rs */
  /* Last arguments seen. */
  unsigned last_unit;
  char last_dir[256];
  char last_new_lang[16];
  char last_voice[64];
  char last_language[16];
  char last_text[512];
  /* Frames delivered by the last speak and whether the callback stopped it. */
  int last_frames_delivered;
  int last_stopped_by_callback;
  /* Optional: called after every frame the callback accepted (frame index from 0). */
  void (*on_frame)(int index, void *arg);
  void *on_frame_arg;
} FakePttsState;

FakePttsState *fake_ptts_state(void);
void fake_ptts_reset(void);
/* NULL-terminated name arrays; copied into the blobs ptts_voices / ptts_languages return. */
void fake_ptts_set_voices(const char *const *names);
void fake_ptts_set_languages(const char *const *names);
/* Gate: when closed, ptts_speak blocks (after counting the call) until it is opened. */
void fake_ptts_close_gate(void);
void fake_ptts_open_gate(void);
/* Wait until `count` speaks have entered (blocked or not). Returns 0 on timeout. */
int fake_ptts_wait_speaks(int count, int timeout_ms);

#ifdef __cplusplus
}
#endif

#endif
