// Minimal self-registering test runner (no gtest dependency).
#pragma once

#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

namespace harness {

struct TestCase {
  const char* name;
  void (*fn)();
};

inline std::vector<TestCase>& registry() {
  static std::vector<TestCase> tests;
  return tests;
}

inline int& failures() {
  static int count = 0;
  return count;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back({name, fn}); }
};

inline void fail(const char* file, int line, const std::string& what) {
  ++failures();
  std::fprintf(stderr, "    FAIL %s:%d: %s\n", file, line, what.c_str());
}

template <typename A, typename B>
std::string describe(const char* ea, const char* eb, const A& a, const B& b) {
  std::ostringstream os;
  os << ea << " == " << eb << " (got " << a << " vs " << b << ")";
  return os.str();
}

// Runs every test whose name contains `filter` (all when null). Returns the process exit code.
inline int run_all(const char* filter) {
  int ran = 0;
  int failed_tests = 0;
  for (const TestCase& t : registry()) {
    if (filter != nullptr && std::strstr(t.name, filter) == nullptr) continue;
    const int before = failures();
    std::printf("[ RUN  ] %s\n", t.name);
    std::fflush(stdout);
    t.fn();
    ++ran;
    if (failures() != before) {
      ++failed_tests;
      std::printf("[ FAIL ] %s\n", t.name);
    } else {
      std::printf("[  OK  ] %s\n", t.name);
    }
  }
  std::printf("%d test(s), %d failed\n", ran, failed_tests);
  return failed_tests == 0 && ran > 0 ? 0 : 1;
}

}  // namespace harness

#define TEST(name)                                                  \
  static void name();                                               \
  static const harness::Registrar name##_registrar(#name, &name);  \
  static void name()

#define CHECK(cond)                                                  \
  do {                                                               \
    if (!(cond)) harness::fail(__FILE__, __LINE__, #cond);           \
  } while (0)

#define CHECK_EQ(a, b)                                                               \
  do {                                                                               \
    const auto& check_a_ = (a);                                                      \
    const auto& check_b_ = (b);                                                      \
    if (!(check_a_ == check_b_))                                                     \
      harness::fail(__FILE__, __LINE__, harness::describe(#a, #b, check_a_, check_b_)); \
  } while (0)
