#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * NativeDictWrapper — Objective-C++ singleton around the C++ NativeDict
 * (mmap'd EPD1 phonemizer dict). One open dict at a time; opening a new
 * dict replaces any currently-open one.
 */
@interface NativeDictWrapper : NSObject

/** Open a dict file. Returns YES on success. */
+ (BOOL)openDict:(NSString *)path error:(NSError * _Nullable * _Nullable)error;

/** Close any currently-open dict. No-op if none open. */
+ (void)closeDict;

/** Look up a word. Returns nil on miss or if no dict open. */
+ (nullable NSString *)lookupWord:(NSString *)word;

@end

NS_ASSUME_NONNULL_END
