#import "NativeDictWrapper.h"
#include "native_dict.h"

#include <memory>
#include <mutex>
#include <string>

@implementation NativeDictWrapper

static std::mutex sDictMutex;
static std::unique_ptr<rnspeech::NativeDict> sDict;

+ (BOOL)openDict:(NSString *)path error:(NSError * _Nullable * _Nullable)error {
  if (path.length == 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeDictWrapper"
                                   code:-1
                               userInfo:@{NSLocalizedDescriptionKey: @"Empty path"}];
    }
    return NO;
  }

  std::lock_guard<std::mutex> lock(sDictMutex);
  auto dict = std::make_unique<rnspeech::NativeDict>();
  std::string p([path UTF8String] ?: "");
  if (!dict->open(p)) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeDictWrapper"
                                   code:-2
                               userInfo:@{NSLocalizedDescriptionKey:
                                            [NSString stringWithFormat:@"Failed to mmap dict at %@", path]}];
    }
    return NO;
  }
  sDict = std::move(dict);
  return YES;
}

+ (void)closeDict {
  std::lock_guard<std::mutex> lock(sDictMutex);
  sDict.reset();
}

+ (nullable NSString *)lookupWord:(NSString *)word {
  if (word.length == 0) return nil;

  std::lock_guard<std::mutex> lock(sDictMutex);
  if (!sDict) return nil;

  const char *cstr = [word UTF8String];
  if (!cstr) return nil;
  std::string_view w(cstr, strlen(cstr));
  auto v = sDict->lookup(w);
  if (!v) return nil;
  return [[NSString alloc] initWithBytes:v->data()
                                  length:v->size()
                                encoding:NSUTF8StringEncoding];
}

@end
