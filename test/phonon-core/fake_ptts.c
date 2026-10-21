#define _POSIX_C_SOURCE 200809L /* clock_gettime under strict -std=c11 */
#define _DARWIN_C_SOURCE 1      /* ...which macOS otherwise hides */
#include "fake_ptts.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ptts.h"

#define EXPORT __attribute__((visibility("default")))

struct PttsHandle {
  char last_error[256];
  int has_error;
  char language[16];
  char voice[64];
};

static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_cv = PTHREAD_COND_INITIALIZER;
static int g_gate_closed = 0;
static FakePttsState g_state;
static char g_voices[512];
static char g_languages[128];

/* Upstream keeps the last ptts_new failure per thread. */
static _Thread_local char t_new_error[256];
static _Thread_local int t_has_new_error;

static void set_list(char *dst, size_t cap, const char *const *names) {
  size_t off = 0;
  for (; names != NULL && *names != NULL; ++names) {
    size_t len = strlen(*names);
    if (off + len + 2 > cap) break;
    memcpy(dst + off, *names, len + 1);
    off += len + 1;
  }
  dst[off] = '\0';
}

static int in_list(const char *blob, const char *name) {
  for (const char *p = blob; *p != '\0'; p += strlen(p) + 1) {
    if (strcmp(p, name) == 0) return 1;
  }
  return 0;
}

static int valid_lang(const char *lang) {
  static const char *const kLangs[] = {"en", "fr", "de", "es", "pt", "none", NULL};
  for (const char *const *l = kLangs; *l != NULL; ++l) {
    if (strcmp(*l, lang) == 0) return 1;
  }
  return 0;
}

static void copy_str(char *dst, size_t cap, const char *src) {
  snprintf(dst, cap, "%s", src != NULL ? src : "");
}

EXPORT FakePttsState *fake_ptts_state(void) { return &g_state; }

EXPORT void fake_ptts_reset(void) {
  pthread_mutex_lock(&g_mu);
  int live = g_state.live_handles;
  memset(&g_state, 0, sizeof(g_state));
  g_state.live_handles = live; /* handles outlive a reset; leaks stay visible */
  g_state.frames_per_speak = 4;
  g_state.frame_size = 1920;
  g_state.sample_value = 0.25f;
  g_state.cpu_only = 1;
  static const char *const kVoices[] = {"alba", "default", "marius", NULL};
  static const char *const kLanguages[] = {"en", "fr", NULL};
  set_list(g_voices, sizeof(g_voices), kVoices);
  set_list(g_languages, sizeof(g_languages), kLanguages);
  g_gate_closed = 0;
  pthread_cond_broadcast(&g_cv);
  pthread_mutex_unlock(&g_mu);
}

EXPORT void fake_ptts_set_voices(const char *const *names) {
  pthread_mutex_lock(&g_mu);
  set_list(g_voices, sizeof(g_voices), names);
  pthread_mutex_unlock(&g_mu);
}

EXPORT void fake_ptts_set_languages(const char *const *names) {
  pthread_mutex_lock(&g_mu);
  set_list(g_languages, sizeof(g_languages), names);
  pthread_mutex_unlock(&g_mu);
}

EXPORT void fake_ptts_close_gate(void) {
  pthread_mutex_lock(&g_mu);
  g_gate_closed = 1;
  pthread_mutex_unlock(&g_mu);
}

EXPORT void fake_ptts_open_gate(void) {
  pthread_mutex_lock(&g_mu);
  g_gate_closed = 0;
  pthread_cond_broadcast(&g_cv);
  pthread_mutex_unlock(&g_mu);
}

EXPORT int fake_ptts_wait_speaks(int count, int timeout_ms) {
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += timeout_ms / 1000;
  deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
  if (deadline.tv_nsec >= 1000000000L) {
    deadline.tv_sec += 1;
    deadline.tv_nsec -= 1000000000L;
  }
  pthread_mutex_lock(&g_mu);
  int rc = 0;
  while (g_state.speaks < count && rc != ETIMEDOUT) {
    rc = pthread_cond_timedwait(&g_cv, &g_mu, &deadline);
  }
  int ok = g_state.speaks >= count;
  pthread_mutex_unlock(&g_mu);
  return ok;
}

/* ---- ptts.h ---------------------------------------------------------------------------- */

EXPORT PttsHandle *ptts_new(const char *dir, uint32_t unit, const char *lang) {
  pthread_mutex_lock(&g_mu);
  g_state.news++;
  g_state.last_unit = unit;
  copy_str(g_state.last_dir, sizeof(g_state.last_dir), dir);
  copy_str(g_state.last_new_lang, sizeof(g_state.last_new_lang), lang);
  const int cpu_only = g_state.cpu_only;
  pthread_mutex_unlock(&g_mu);

  const char *fail = NULL;
  char buf[256];
  if (strncmp(dir, "fail:", 5) == 0) {
    fail = dir + 5;
  } else if (cpu_only && unit != PTTS_UNIT_CPU) {
    snprintf(buf, sizeof(buf), "compute unit %u is Apple only; use PTTS_UNIT_CPU", unit);
    fail = buf;
  } else if (!valid_lang(lang)) {
    snprintf(buf, sizeof(buf), "unknown language %s", lang);
    fail = buf;
  }
  if (fail != NULL) {
    copy_str(t_new_error, sizeof(t_new_error), fail);
    t_has_new_error = 1;
    return NULL;
  }

  PttsHandle *h = (PttsHandle *)calloc(1, sizeof(PttsHandle));
  if (h == NULL) return NULL;
  copy_str(h->language, sizeof(h->language), lang);
  pthread_mutex_lock(&g_mu);
  g_state.live_handles++;
  pthread_mutex_unlock(&g_mu);
  return h;
}

EXPORT bool ptts_speak(PttsHandle *h, const char *text, PttsFrameFn cb, void *user,
                       PttsResult *out) {
  pthread_mutex_lock(&g_mu);
  g_state.speaks++;
  copy_str(g_state.last_text, sizeof(g_state.last_text), text);
  pthread_cond_broadcast(&g_cv);
  while (g_gate_closed) pthread_cond_wait(&g_cv, &g_mu);
  const int frames = g_state.frames_per_speak;
  const int frame_size = g_state.frame_size;
  const float value = g_state.sample_value;
  void (*on_frame)(int, void *) = g_state.on_frame;
  void *on_frame_arg = g_state.on_frame_arg;
  pthread_mutex_unlock(&g_mu);

  if (strncmp(text, "fail", 4) == 0) {
    snprintf(h->last_error, sizeof(h->last_error), "speak failed: %s", text);
    h->has_error = 1;
    return false;
  }

  float *pcm = (float *)malloc(sizeof(float) * (size_t)(frame_size > 0 ? frame_size : 1));
  if (pcm == NULL) return false;
  for (int i = 0; i < frame_size; ++i) pcm[i] = value;

  int delivered = 0;
  int stopped = 0;
  for (int f = 0; f < frames; ++f) {
    if (!cb(pcm, (size_t)frame_size, user)) {
      stopped = 1;
      break;
    }
    ++delivered;
    if (on_frame != NULL) on_frame(f, on_frame_arg);
  }
  free(pcm);

  pthread_mutex_lock(&g_mu);
  g_state.last_frames_delivered = delivered;
  g_state.last_stopped_by_callback = stopped;
  pthread_mutex_unlock(&g_mu);

  out->frames = (uint32_t)delivered;
  out->samples = (size_t)delivered * (size_t)frame_size;
  out->ttfa_ms = frames > 0 ? 12.5 : 0;
  out->total_ms = 40.0;
  return true;
}

EXPORT const char *ptts_voices(const PttsHandle *h) {
  (void)h;
  return g_voices;
}

EXPORT bool ptts_set_voice(PttsHandle *h, const char *name) {
  pthread_mutex_lock(&g_mu);
  g_state.set_voices++;
  copy_str(g_state.last_voice, sizeof(g_state.last_voice), name);
  const int known = in_list(g_voices, name);
  pthread_mutex_unlock(&g_mu);
  if (!known) {
    snprintf(h->last_error, sizeof(h->last_error), "no voice named \"%s\"", name);
    h->has_error = 1;
    return false;
  }
  copy_str(h->voice, sizeof(h->voice), name);
  return true;
}

#ifndef FAKE_PTTS_OMIT_SET_LANGUAGE
EXPORT bool ptts_set_language(PttsHandle *h, const char *lang) {
  pthread_mutex_lock(&g_mu);
  g_state.set_languages++;
  copy_str(g_state.last_language, sizeof(g_state.last_language), lang);
  pthread_mutex_unlock(&g_mu);
  if (!valid_lang(lang)) {
    snprintf(h->last_error, sizeof(h->last_error), "unknown language %s", lang);
    h->has_error = 1;
    return false;
  }
  copy_str(h->language, sizeof(h->language), lang);
  return true;
}
#endif

EXPORT const char *ptts_languages(const PttsHandle *h) {
  (void)h;
  return g_languages;
}

EXPORT const char *ptts_last_error(const PttsHandle *h) {
  pthread_mutex_lock(&g_mu);
  g_state.last_errors++;
  pthread_mutex_unlock(&g_mu);
  if (h == NULL) return t_has_new_error ? t_new_error : NULL;
  return h->has_error ? h->last_error : NULL;
}

EXPORT void ptts_free(PttsHandle *h) {
  if (h == NULL) return;
  pthread_mutex_lock(&g_mu);
  g_state.frees++;
  g_state.live_handles--;
  pthread_mutex_unlock(&g_mu);
  free(h);
}
