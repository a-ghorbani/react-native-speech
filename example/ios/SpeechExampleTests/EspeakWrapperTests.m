//
//  EspeakWrapperTests.m
//  RNSpeech Tests
//
//  Tests for espeak-ng phonemization wrapper
//  Test cases loaded from shared fixture: src/engines/kokoro/__tests__/fixtures/phonemization-cases.json
//
//  The fixture contains:
//  - input: Original text
//  - normalized: Text after TextNormalizer (tested in Jest)
//  - chunks: Array of {text, isPunctuation, phoneme} - each non-punctuation chunk is tested HERE
//  - postProcessed: Final output after post-processing (tested in Jest)
//
//  This test validates: chunk.text -> chunk.phoneme (for non-punctuation chunks)
//

#import <XCTest/XCTest.h>
#import <RNSpeech/EspeakWrapper.h>

#pragma mark - Test Class

@interface EspeakWrapperTests : XCTestCase
@property (nonatomic, strong) NSString *dataPath;
@property (nonatomic, strong) NSDictionary *testFixture;
@end

@implementation EspeakWrapperTests

- (void)setUp {
    [super setUp];
    self.dataPath = [EspeakWrapper ensureDataPath];
    XCTAssertNotNil(self.dataPath, @"espeak-ng-data path should exist");

    // Load test fixture from the shared JSON file
    [self loadTestFixture];
}

- (void)loadTestFixture {
    // The fixture is in the source tree - we need to find it relative to the test bundle
    // First try the main bundle (when running in the app)
    NSString *fixturePath = [[NSBundle bundleForClass:[self class]] pathForResource:@"phonemization-cases" ofType:@"json"];

    if (!fixturePath) {
        // Try finding it in the source tree (for development)
        // Go up from the example/ios directory to find src/
        NSString *testBundlePath = [[NSBundle bundleForClass:[self class]] bundlePath];
        NSString *projectRoot = [[[testBundlePath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];

        // Try multiple possible locations
        NSArray *possiblePaths = @[
            [projectRoot stringByAppendingPathComponent:@"src/engines/kokoro/__tests__/fixtures/phonemization-cases.json"],
            [projectRoot stringByAppendingPathComponent:@"../src/engines/kokoro/__tests__/fixtures/phonemization-cases.json"],
            [projectRoot stringByAppendingPathComponent:@"../../src/engines/kokoro/__tests__/fixtures/phonemization-cases.json"],
            @"/Users/aghorbani/codes/react-native-speech/src/engines/kokoro/__tests__/fixtures/phonemization-cases.json"
        ];

        for (NSString *path in possiblePaths) {
            if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
                fixturePath = path;
                break;
            }
        }
    }

    XCTAssertNotNil(fixturePath, @"Could not find phonemization-cases.json fixture file");

    NSData *data = [NSData dataWithContentsOfFile:fixturePath];
    XCTAssertNotNil(data, @"Could not read fixture file");

    NSError *error = nil;
    self.testFixture = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    XCTAssertNil(error, @"Failed to parse fixture JSON: %@", error);
    XCTAssertNotNil(self.testFixture, @"Fixture should be a valid dictionary");
}

#pragma mark - US English (en-us) Tests

- (void)testEnUSPhonemization {
    NSArray *testCases = self.testFixture[@"en-us"];
    XCTAssertNotNil(testCases, @"en-us test cases should exist");
    XCTAssertTrue(testCases.count > 0, @"en-us should have test cases");

    NSUInteger failureCount = 0;
    NSUInteger totalChunks = 0;
    NSMutableArray *failures = [NSMutableArray array];

    NSLog(@"\n\n========== EN-US RAW PHONEMIZATION TEST RESULTS ==========\n");

    for (NSUInteger i = 0; i < testCases.count; i++) {
        NSDictionary *testCase = testCases[i];
        NSString *originalInput = testCase[@"input"];
        NSArray *chunks = testCase[@"chunks"];

        // Test each non-punctuation chunk
        for (NSUInteger j = 0; j < chunks.count; j++) {
            NSDictionary *chunk = chunks[j];
            BOOL isPunctuation = [chunk[@"isPunctuation"] boolValue];

            // Skip punctuation chunks - they pass through unchanged
            if (isPunctuation) {
                continue;
            }

            totalChunks++;
            NSString *chunkText = chunk[@"text"];
            NSString *expected = chunk[@"phoneme"];

            NSError *error = nil;
            NSString *actual = [EspeakWrapper phonemizeText:chunkText
                                                   language:@"en-us"
                                                   dataPath:self.dataPath
                                                      error:&error];

            if (error) {
                failureCount++;
                NSString *msg = [NSString stringWithFormat:@"[%lu.%lu] ERROR phonemizing \"%@\": %@",
                               (unsigned long)i, (unsigned long)j, chunkText, error.localizedDescription];
                [failures addObject:msg];
                NSLog(@"X %@", msg);
                continue;
            }

            if (![actual isEqualToString:expected]) {
                failureCount++;
                NSString *msg = [NSString stringWithFormat:@"[%lu.%lu] \"%@\" chunk \"%@\"\n   expected: %@\n   actual:   %@",
                               (unsigned long)i, (unsigned long)j, originalInput, chunkText, expected, actual];
                [failures addObject:msg];
                NSLog(@"X %@", msg);
            } else {
                NSLog(@"OK [%lu.%lu] \"%@\" -> %@", (unsigned long)i, (unsigned long)j, chunkText, actual);
            }
        }
    }

    NSLog(@"\n========== EN-US SUMMARY: %lu/%lu chunks passed ==========\n",
          (unsigned long)(totalChunks - failureCount),
          (unsigned long)totalChunks);

    if (failureCount > 0) {
        NSLog(@"\nFailed tests:\n%@", [failures componentsJoinedByString:@"\n"]);
    }

    XCTAssertEqual(failureCount, 0, @"en-us phonemization had %lu failures out of %lu chunks",
                   (unsigned long)failureCount, (unsigned long)totalChunks);
}

#pragma mark - British English (en-gb) Tests

- (void)testEnGBPhonemization {
    NSArray *testCases = self.testFixture[@"en-gb"];
    XCTAssertNotNil(testCases, @"en-gb test cases should exist");
    XCTAssertTrue(testCases.count > 0, @"en-gb should have test cases");

    NSUInteger failureCount = 0;
    NSUInteger totalChunks = 0;
    NSMutableArray *failures = [NSMutableArray array];

    NSLog(@"\n\n========== EN-GB RAW PHONEMIZATION TEST RESULTS ==========\n");

    for (NSUInteger i = 0; i < testCases.count; i++) {
        NSDictionary *testCase = testCases[i];
        NSString *originalInput = testCase[@"input"];
        NSArray *chunks = testCase[@"chunks"];

        // Test each non-punctuation chunk
        for (NSUInteger j = 0; j < chunks.count; j++) {
            NSDictionary *chunk = chunks[j];
            BOOL isPunctuation = [chunk[@"isPunctuation"] boolValue];

            // Skip punctuation chunks - they pass through unchanged
            if (isPunctuation) {
                continue;
            }

            totalChunks++;
            NSString *chunkText = chunk[@"text"];
            NSString *expected = chunk[@"phoneme"];

            NSError *error = nil;
            NSString *actual = [EspeakWrapper phonemizeText:chunkText
                                                   language:@"en-gb"
                                                   dataPath:self.dataPath
                                                      error:&error];

            if (error) {
                failureCount++;
                NSString *msg = [NSString stringWithFormat:@"[%lu.%lu] ERROR phonemizing \"%@\": %@",
                               (unsigned long)i, (unsigned long)j, chunkText, error.localizedDescription];
                [failures addObject:msg];
                NSLog(@"X %@", msg);
                continue;
            }

            if (![actual isEqualToString:expected]) {
                failureCount++;
                NSString *msg = [NSString stringWithFormat:@"[%lu.%lu] \"%@\" chunk \"%@\"\n   expected: %@\n   actual:   %@",
                               (unsigned long)i, (unsigned long)j, originalInput, chunkText, expected, actual];
                [failures addObject:msg];
                NSLog(@"X %@", msg);
            } else {
                NSLog(@"OK [%lu.%lu] \"%@\" -> %@", (unsigned long)i, (unsigned long)j, chunkText, actual);
            }
        }
    }

    NSLog(@"\n========== EN-GB SUMMARY: %lu/%lu chunks passed ==========\n",
          (unsigned long)(totalChunks - failureCount),
          (unsigned long)totalChunks);

    if (failureCount > 0) {
        NSLog(@"\nFailed tests:\n%@", [failures componentsJoinedByString:@"\n"]);
    }

    XCTAssertEqual(failureCount, 0, @"en-gb phonemization had %lu failures out of %lu chunks",
                   (unsigned long)failureCount, (unsigned long)totalChunks);
}

#pragma mark - Edge Cases

- (void)testEmptyString {
    // espeak-ng returns an error for empty input - this is expected behavior
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@""
                                             language:@"en-us"
                                             dataPath:self.dataPath
                                                error:&error];

    XCTAssertNotNil(error, @"Empty string should return an error from espeak-ng");
    XCTAssertNil(phonemes, @"Empty string should not produce phonemes");
}

- (void)testWhitespaceOnly {
    // espeak-ng returns an error for whitespace-only input - this is expected behavior
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@"   "
                                             language:@"en-us"
                                             dataPath:self.dataPath
                                                error:&error];

    XCTAssertNotNil(error, @"Whitespace-only string should return an error from espeak-ng");
    XCTAssertNil(phonemes, @"Whitespace-only string should not produce phonemes");
}

- (void)testLongText {
    NSString *longText = @"This is a very long sentence with many words to test that the phonemizer can handle longer inputs without truncation or errors.";
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:longText
                                             language:@"en-us"
                                             dataPath:self.dataPath
                                                error:&error];

    XCTAssertNil(error);
    XCTAssertNotNil(phonemes);
    XCTAssertTrue(phonemes.length > 0, @"Should produce phonemes for long text");
}

#pragma mark - Error Handling

- (void)testInvalidLanguage {
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@"Hello"
                                             language:@"invalid-lang"
                                             dataPath:self.dataPath
                                                error:&error];

    // espeak-ng may fall back to default language or return error
    // Either is acceptable behavior
    if (error) {
        XCTAssertNotNil(error, @"Should return error for invalid language");
    } else {
        XCTAssertNotNil(phonemes, @"Or should fall back and return phonemes");
    }
}

- (void)testNilDataPath {
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@"Hello"
                                             language:@"en-us"
                                             dataPath:nil
                                                error:&error];

    // Should either use default path or return error
    XCTAssertTrue(error != nil || phonemes != nil,
                  @"Should handle nil dataPath gracefully");
}

@end
