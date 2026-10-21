#include "PhononWorker.h"

#include <cstring>
#include <utility>

#if defined(__APPLE__)
#include <pthread/qos.h>
#endif

namespace rnspeech::phonon {

Worker& Worker::shared() {
  static Worker* instance = new Worker();
  return *instance;
}

Worker::Worker(Options options) : options_(std::move(options)) {
  pthread_attr_t attr;
  int rc = pthread_attr_init(&attr);
  if (rc == 0) rc = pthread_attr_setstacksize(&attr, options_.stackBytes);
#if defined(__APPLE__)
  if (rc == 0) rc = pthread_attr_set_qos_class_np(&attr, QOS_CLASS_USER_INITIATED, 0);
#endif
  if (rc == 0) rc = pthread_create(&thread_, &attr, &Worker::threadMain, this);
  pthread_attr_destroy(&attr);
  if (rc == 0) {
    started_ = true;
  } else {
    startError_ = std::string("pthread start failed: ") + std::strerror(rc);
  }
}

Worker::~Worker() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  cv_.notify_all();
  if (started_) pthread_join(thread_, nullptr);
}

bool Worker::post(Job job) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_ || stopping_ || !job) return false;
    queue_.push_back(std::move(job));
  }
  cv_.notify_one();
  return true;
}

void Worker::setJobHook(JobHook hook) {
  std::lock_guard<std::mutex> lock(mutex_);
  hook_ = std::move(hook);
}

size_t Worker::pending() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return queue_.size();
}

bool Worker::isWorkerThread() const {
  return started_ && pthread_equal(pthread_self(), thread_) != 0;
}

void* Worker::threadMain(void* self) {
  auto* worker = static_cast<Worker*>(self);
  // Linux limits thread names to 15 characters plus NUL.
  std::string name = worker->options_.name.substr(0, 15);
#if defined(__APPLE__)
  pthread_setname_np(name.c_str());
#else
  pthread_setname_np(pthread_self(), name.c_str());
#endif
  worker->loop();
  return nullptr;
}

void Worker::loop() {
  for (;;) {
    Job job;
    JobHook hook;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) return;  // stopping and drained
      job = std::move(queue_.front());
      queue_.pop_front();
      hook = hook_;
    }
    try {
      if (hook) {
        hook(job);
      } else {
        job();
      }
    } catch (...) {
      // Jobs report their own errors (promises); never let one kill the thread.
    }
  }
}

}  // namespace rnspeech::phonon
