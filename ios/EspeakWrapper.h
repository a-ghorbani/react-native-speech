#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EspeakWrapper : NSObject

/**
 * Convert text to IPA phonemes using espeak-ng
 * @param text The input text
 * @param language Language code (e.g., "en-us", "en-gb")
 * @param dataPath Path to espeak-ng-data directory
 * @param error Error pointer for error handling
 * @return IPA phoneme string, or nil if error occurred
 */
+ (nullable NSString *)phonemizeText:(NSString *)text
                            language:(NSString *)language
                            dataPath:(NSString *)dataPath
                               error:(NSError **)error;

/**
 * Ensure espeak-ng-data is extracted to Documents directory
 * @return Path to espeak-ng-data directory
 */
+ (NSString *)ensureDataPath;

@end

NS_ASSUME_NONNULL_END
