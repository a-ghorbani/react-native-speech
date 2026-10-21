// PhononWorker.h — one serial pthread for ptts calls (iOS is the only production user; Android
// uses a Kotlin ThreadPoolExecutor). DESIGN.md §1.5.
//
// Upstream requires one thread per handle, and Rust needs a deep stack, so the worker is a
// dedicated pthread with an 8 MB stack (QoS userInitiated on Apple) and a FIFO job queue. A
// per-job hook lets iOS wrap each job in @autoreleasepool (a non-GCD thread never drains one).
//
// The shared() instance is process-wide and deliberately leaked: RN reloads keep it, and
// invalidate never joins it. Only test instances are ever destroyed.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <string>

#include <pthread.h>

namespace rnspeech::phonon {

struct WorkerOptions {
  std::string name = "phonon-synth";
  size_t stackBytes = 8u << 20;
};

class Worker {
 public:
  using Job = std::function<void()>;
  // Receives each job and must run it exactly once (e.g. inside @autoreleasepool).
  using JobHook = std::function<void(const Job&)>;
  using Options = WorkerOptions;

  static Worker& shared();

  explicit Worker(Options options = Options());
  // Runs the jobs already queued, then joins. Tests only.
  ~Worker();
  Worker(const Worker&) = delete;
  Worker& operator=(const Worker&) = delete;

  // false if the thread could not be started or the worker is shutting down. Exceptions
  // escaping a job (or the hook) are swallowed so the thread keeps serving.
  bool post(Job job);

  void setJobHook(JobHook hook);

  size_t pending() const;
  bool running() const { return started_; }
  bool isWorkerThread() const;
  const std::string& startError() const { return startError_; }

 private:
  static void* threadMain(void* self);
  void loop();

  const Options options_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Job> queue_;
  JobHook hook_;
  bool stopping_ = false;
  bool started_ = false;
  std::string startError_;
  pthread_t thread_{};
};

}  // namespace rnspeech::phonon
