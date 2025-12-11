//
//  EspeakWrapperTests.m
//  RNSpeech Tests
//
//  Tests for espeak-ng phonemization wrapper
//  Based on: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/tests/phonemize.test.js
//

#import <XCTest/XCTest.h>
#import <RNSpeech/EspeakWrapper.h>

#pragma mark - Test Case Definitions

// US English test cases (voice "a")
// Format: @[input, expected]
static NSArray<NSArray<NSString *> *> *A_TEST_CASES(void) {
    return @[
        @[@"'Hello'", @"həlˈoʊ"],
        @[@"'Test' and 'Example'", @"tˈɛst ænd ɛɡzˈæmpəl"],
        @[@"«Bonjour»", @"\"bɔːnʒˈʊɹ\""],
        @[@"«Test «nested» quotes»", @"\"tˈɛst \"nˈɛstᵻd\" kwˈoʊts\""],
        @[@"(Hello)", @"«həlˈoʊ»"],
        @[@"(Nested (Parentheses))", @"«nˈɛstᵻd «pɚɹˈɛnθəsˌiːz»»"],
        @[@"こんにちは、世界！", @"dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ, tʃˈaɪniːzlˌɛɾɚ tʃˈaɪniːzlˌɛɾɚ!"],
        @[@"これはテストです：はい？", @"dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ: dʒˈæpəniːzlˌɛɾɚ dʒˈæpəniːzlˌɛɾɚ?"],
        @[@"Hello World", @"həlˈoʊ wˈɜːld"],
        @[@"Hello   World", @"həlˈoʊ wˈɜːld"],
        @[@"Hello\n   \nWorld", @"həlˈoʊ wˈɜːld"],
        @[@"Dr. Smith", @"dˈɑːktɚ smˈɪθ"],
        @[@"DR. Brown", @"dˈɑːktɚ bɹˈaʊn"],
        @[@"Mr. Smith", @"mˈɪstɚ smˈɪθ"],
        @[@"MR. Anderson", @"mˈɪstɚɹ ˈændɚsən"],
        @[@"Ms. Taylor", @"mˈɪs tˈeɪlɚ"],
        @[@"MS. Carter", @"mˈɪs kˈɑːɹɾɚ"],
        @[@"Mrs. Johnson", @"mˈɪsɪz dʒˈɑːnsən"],
        @[@"MRS. Wilson", @"mˈɪsɪz wˈɪlsən"],
        @[@"Apples, oranges, etc.", @"ˈæpəlz, ˈɔɹɪndʒᵻz, ɛtsˈɛtɹə"],
        @[@"Apples, etc. Pears.", @"ˈæpəlz, ɛtsˈɛtɹə. pˈɛɹz."],
        @[@"Yeah", @"jˈɛə"],
        @[@"yeah", @"jˈɛə"],
        @[@"1990", @"nˈaɪntiːn nˈaɪndi"],
        @[@"12:34", @"twˈɛlv θˈɜːɾi fˈoːɹ"],
        @[@"2022s", @"twˈɛnti twˈɛnti tˈuːz"],
        @[@"1,000", @"wˈʌn θˈaʊzənd"],
        @[@"12,345,678", @"twˈɛlv mˈɪliən θɹˈiː hˈʌndɹɪd fˈoːɹɾi fˈaɪv θˈaʊzənd sˈɪks hˈʌndɹɪd sˈɛvənti ˈeɪt"],
        @[@"$100", @"wˈʌn hˈʌndɹɪd dˈɑːlɚz"],
        @[@"£1.50", @"wˈʌn pˈaʊnd ænd fˈɪfti pˈɛns"],
        @[@"12.34", @"twˈɛlv pˈɔɪnt θɹˈiː fˈoːɹ"],
        @[@"0.01", @"zˈiəɹoʊ pˈɔɪnt zˈiəɹoʊ wˈʌn"],
        @[@"10-20", @"tˈɛn tə twˈɛnti"],
        @[@"5-10", @"fˈaɪv tə tˈɛn"],
        @[@"10S", @"tˈɛn ˈɛs"],
        @[@"5S", @"fˈaɪv ˈɛs"],
        @[@"Cat's tail", @"kˈæts tˈeɪl"],
        @[@"X's mark", @"ˈɛksᵻz mˈɑːɹk"],
        @[@"U.S.A.", @"jˈuːˈɛsˈeɪ."],
        @[@"A.B.C", @"ˈeɪbˈiːsˈiː"],
    ];
}

// British English test cases (voice "b")
// Format: @[input, expected]
static NSArray<NSArray<NSString *> *> *B_TEST_CASES(void) {
    return @[
        @[@"'Hello'", @"həlˈəʊ"],
        @[@"'Test' and 'Example'", @"tˈɛst and ɛɡzˈampəl"],
        @[@"«Bonjour»", @"\"bɔːnʒˈʊə\""],
        @[@"«Test «nested» quotes»", @"\"tˈɛst \"nˈɛstɪd\" kwˈəʊts\""],
        @[@"(Hello)", @"«həlˈəʊ»"],
        @[@"(Nested (Parentheses))", @"«nˈɛstɪd «pəɹˈɛnθəsˌiːz»»"],
        @[@"こんにちは、世界！", @"dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə, tʃˈaɪniːzlˌɛtə tʃˈaɪniːzlˌɛtə!"],
        @[@"これはテストです：はい？", @"dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə: dʒˈapəniːzlˌɛtə dʒˈapəniːzlˌɛtə?"],
        @[@"Hello World", @"həlˈəʊ wˈɜːld"],
        @[@"Hello   World", @"həlˈəʊ wˈɜːld"],
        @[@"Hello\n   \nWorld", @"həlˈəʊ wˈɜːld"],
        @[@"Dr. Smith", @"dˈɒktə smˈɪθ"],
        @[@"DR. Brown", @"dˈɒktə bɹˈaʊn"],
        @[@"Mr. Smith", @"mˈɪstə smˈɪθ"],
        @[@"MR. Anderson", @"mˈɪstəɹ ˈandəsən"],
        @[@"Ms. Taylor", @"mˈɪs tˈeɪlə"],
        @[@"MS. Carter", @"mˈɪs kˈɑːtə"],
        @[@"Mrs. Johnson", @"mˈɪsɪz dʒˈɒnsən"],
        @[@"Apples, oranges, etc.", @"ˈapəlz, ˈɒɹɪndʒɪz, ɛtsˈɛtɹə"],
        @[@"Apples, etc. Pears.", @"ˈapəlz, ɛtsˈɛtɹə. pˈeəz."],
        @[@"1990", @"nˈaɪntiːn nˈaɪnti"],
        @[@"12:34", @"twˈɛlv θˈɜːti fˈɔː"],
        @[@"1,000", @"wˈɒn θˈaʊzənd"],
        @[@"12,345,678", @"twˈɛlv mˈɪliən θɹˈiː hˈʌndɹɪdən fˈɔːti fˈaɪv θˈaʊzənd sˈɪks hˈʌndɹɪdən sˈɛvənti ˈeɪt"],
        @[@"$100", @"wˈɒn hˈʌndɹɪd dˈɒləz"],
        @[@"£1.50", @"wˈɒn pˈaʊnd and fˈɪfti pˈɛns"],
        @[@"12.34", @"twˈɛlv pˈɔɪnt θɹˈiː fˈɔː"],
        @[@"0.01", @"zˈiəɹəʊ pˈɔɪnt zˈiəɹəʊ wˈɒn"],
        @[@"Cat's tail", @"kˈats tˈeɪl"],
        @[@"X's mark", @"ˈɛksɪz mˈɑːk"],
    ];
}

#pragma mark - Test Class

@interface EspeakWrapperTests : XCTestCase
@property (nonatomic, strong) NSString *dataPath;
@end

@implementation EspeakWrapperTests

- (void)setUp {
    [super setUp];
    self.dataPath = [EspeakWrapper ensureDataPath];
    XCTAssertNotNil(self.dataPath, @"espeak-ng-data path should exist");
}

#pragma mark - US English (en-us) Tests

- (void)testEnUSPhonemization {
    NSArray<NSArray<NSString *> *> *testCases = A_TEST_CASES();
    NSUInteger failureCount = 0;

    NSLog(@"\n\n========== EN-US PHONEMIZATION TEST RESULTS ==========\n");

    for (NSUInteger i = 0; i < testCases.count; i++) {
        NSString *input = testCases[i][0];
        NSString *expected = testCases[i][1];

        NSError *error = nil;
        NSString *actual = [EspeakWrapper phonemizeText:input
                                               language:@"en-us"
                                               dataPath:self.dataPath
                                                  error:&error];

        if (error) {
            failureCount++;
            NSLog(@"❌ [%lu] phonemize(\"%@\")\n   ERROR: %@\n", (unsigned long)i, input, error.localizedDescription);
            continue;
        }

        if (![actual isEqualToString:expected]) {
            failureCount++;
            NSLog(@"❌ [%lu] phonemize(\"%@\")\n   expected: %@\n   actual:   %@\n", (unsigned long)i, input, expected, actual);
        } else {
            NSLog(@"✅ [%lu] phonemize(\"%@\") = %@", (unsigned long)i, input, actual);
        }
    }

    NSLog(@"\n========== EN-US SUMMARY: %lu/%lu passed ==========\n\n",
          (unsigned long)(testCases.count - failureCount),
          (unsigned long)testCases.count);

    XCTAssertEqual(failureCount, 0, @"en-us phonemization had %lu failures out of %lu tests",
                   (unsigned long)failureCount, (unsigned long)testCases.count);
}

#pragma mark - British English (en-gb) Tests

- (void)testEnGBPhonemization {
    NSArray<NSArray<NSString *> *> *testCases = B_TEST_CASES();
    NSUInteger failureCount = 0;

    NSLog(@"\n\n========== EN-GB PHONEMIZATION TEST RESULTS ==========\n");

    for (NSUInteger i = 0; i < testCases.count; i++) {
        NSString *input = testCases[i][0];
        NSString *expected = testCases[i][1];

        NSError *error = nil;
        NSString *actual = [EspeakWrapper phonemizeText:input
                                               language:@"en-gb"
                                               dataPath:self.dataPath
                                                  error:&error];

        if (error) {
            failureCount++;
            NSLog(@"❌ [%lu] phonemize(\"%@\", \"b\")\n   ERROR: %@\n", (unsigned long)i, input, error.localizedDescription);
            continue;
        }

        if (![actual isEqualToString:expected]) {
            failureCount++;
            NSLog(@"❌ [%lu] phonemize(\"%@\", \"b\")\n   expected: %@\n   actual:   %@\n", (unsigned long)i, input, expected, actual);
        } else {
            NSLog(@"✅ [%lu] phonemize(\"%@\", \"b\") = %@", (unsigned long)i, input, actual);
        }
    }

    NSLog(@"\n========== EN-GB SUMMARY: %lu/%lu passed ==========\n\n",
          (unsigned long)(testCases.count - failureCount),
          (unsigned long)testCases.count);

    XCTAssertEqual(failureCount, 0, @"en-gb phonemization had %lu failures out of %lu tests",
                   (unsigned long)failureCount, (unsigned long)testCases.count);
}

#pragma mark - Edge Cases

- (void)testEmptyString {
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@""
                                             language:@"en-us"
                                             dataPath:self.dataPath
                                                error:&error];

    XCTAssertNil(error);
    XCTAssertNotNil(phonemes);
    XCTAssertEqual(phonemes.length, 0, @"Empty string should return empty phonemes");
}

- (void)testWhitespaceOnly {
    NSError *error = nil;
    NSString *phonemes = [EspeakWrapper phonemizeText:@"   "
                                             language:@"en-us"
                                             dataPath:self.dataPath
                                                error:&error];

    XCTAssertNil(error);
    XCTAssertNotNil(phonemes);
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
