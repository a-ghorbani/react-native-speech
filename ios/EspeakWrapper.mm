#import "EspeakWrapper.h"
#import <espeak-ng/speak_lib.h>

@implementation EspeakWrapper

static BOOL espeakInitialized = NO;
static NSString *currentDataPath = nil;

+ (nullable NSString *)phonemizeText:(NSString *)text
                            language:(NSString *)language
                            dataPath:(NSString *)dataPath
                               error:(NSError **)error {
    @synchronized(self) {
        @try {
            // Initialize espeak-ng if not initialized or data path changed
            if (!espeakInitialized || ![currentDataPath isEqualToString:dataPath]) {
                if (espeakInitialized) {
                    espeak_Terminate();
                    espeakInitialized = NO;
                }

                const char *tempPath = [dataPath UTF8String];

                if (!tempPath) {
                    if (error) {
                        *error = [NSError errorWithDomain:@"EspeakWrapper"
                                                     code:-999
                                                 userInfo:@{
                                                     NSLocalizedDescriptionKey: @"Failed to convert path to UTF8"
                                                 }];
                    }
                    return nil;
                }

                char *path = strdup(tempPath);

                if (!path) {
                    if (error) {
                        *error = [NSError errorWithDomain:@"EspeakWrapper"
                                                     code:-999
                                                 userInfo:@{
                                                     NSLocalizedDescriptionKey: @"Failed to allocate memory for path"
                                                 }];
                    }
                    return nil;
                }

                int result = espeak_Initialize(AUDIO_OUTPUT_RETRIEVAL, 0, path, 0);
                free(path);

                if (result < 0) {
                    if (error) {
                        *error = [NSError errorWithDomain:@"EspeakWrapper"
                                                     code:result
                                                 userInfo:@{
                                                     NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Failed to initialize espeak-ng: %d", result]
                                                 }];
                    }
                    return nil;
                }

                espeakInitialized = YES;
                currentDataPath = dataPath;
            }

            // Set language/voice
            espeak_VOICE voice_spec;
            memset(&voice_spec, 0, sizeof(espeak_VOICE));
            voice_spec.languages = [language UTF8String];

            if (espeak_SetVoiceByProperties(&voice_spec) != EE_OK) {
                // Continue anyway - espeak will use default voice
            }

            // espeak_TextToPhonemes processes ONE CLAUSE at a time
            // We need to call it repeatedly until all text is processed
            const char *textCStr = [text UTF8String];
            const char *textPtr = textCStr;
            NSMutableString *allPhonemes = [NSMutableString string];

            // Keep calling espeak_TextToPhonemes until all text is processed
            while (textPtr && *textPtr != '\0') {
                const char *beforePtr = textPtr;

                const char *phonemes = espeak_TextToPhonemes(
                    (const void **)&textPtr,
                    espeakCHARS_UTF8,
                    espeakPHONEMES_IPA
                );

                if (phonemes && strlen(phonemes) > 0) {
                    NSString *clausePhonemes = [NSString stringWithUTF8String:phonemes];

                    // Trim whitespace
                    clausePhonemes = [clausePhonemes stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];

                    if (clausePhonemes.length > 0) {
                        // Add space between clauses if not first
                        if (allPhonemes.length > 0) {
                            [allPhonemes appendString:@" "];
                        }
                        [allPhonemes appendString:clausePhonemes];
                    }
                }

                // Safety check: if pointer didn't advance, break to avoid infinite loop
                if (textPtr == beforePtr || textPtr == NULL) {
                    break;
                }
            }

            if (allPhonemes.length > 0) {
                return [allPhonemes copy];
            } else {
                if (error) {
                    *error = [NSError errorWithDomain:@"EspeakWrapper"
                                                 code:-1
                                             userInfo:@{
                                                 NSLocalizedDescriptionKey: @"Failed to generate phonemes"
                                             }];
                }
                return nil;
            }
        }
        @catch (NSException *exception) {
            if (error) {
                *error = [NSError errorWithDomain:@"EspeakWrapper"
                                             code:-1
                                         userInfo:@{
                                             NSLocalizedDescriptionKey: exception.reason ?: @"Unknown error"
                                         }];
            }
            return nil;
        }
    }
}

+ (NSString *)ensureDataPath {
    // espeak-ng-data is bundled via Podspec s.resources
    // For iOS, we can use the bundle path directly - no need to copy
    NSString *bundlePath = [[NSBundle mainBundle] pathForResource:@"espeak-ng-data" ofType:nil];

    if (!bundlePath) {
        return nil;
    }

    // Verify essential files exist in bundle
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *phondataPath = [bundlePath stringByAppendingPathComponent:@"phondata"];
    NSString *phontabPath = [bundlePath stringByAppendingPathComponent:@"phontab"];

    if (![fileManager fileExistsAtPath:phondataPath] || ![fileManager fileExistsAtPath:phontabPath]) {
        return nil;
    }

    // Check file sizes to ensure they're not empty
    NSDictionary *phondataAttrs = [fileManager attributesOfItemAtPath:phondataPath error:nil];
    unsigned long long phondataSize = [phondataAttrs fileSize];

    if (phondataSize < 1000) { // phondata should be much larger
        return nil;
    }

    return bundlePath;
}

@end
