/* Minimal config.h for espeak-ng iOS builds */
#ifndef ESPEAK_NG_CONFIG_H
#define ESPEAK_NG_CONFIG_H

/* Feature flags - disable optional features for minimal build */
#define HAVE_MKSTEMP 1
#define USE_ASYNC 0
#define USE_KLATT 0
#define USE_LIBPCAUDIO 0
#define USE_LIBSONIC 0
#define USE_MBROLA 0
#define USE_SPEECHPLAYER 0

#define PACKAGE_VERSION "1.51"

/* Increase path buffer size for iOS long bundle paths */
#define N_PATH_HOME 512

/* Increase phoneme list size to handle longer text without truncation */
#define N_PHONEME_LIST 4000  // Increased from default 1000 to support longer text

#endif /* ESPEAK_NG_CONFIG_H */
