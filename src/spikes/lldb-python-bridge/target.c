#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t probe_keep_running = 1;
static volatile sig_atomic_t probe_last_signal = 0;

static void probe_handle_signal(int signo) {
  probe_last_signal = signo;
  if (signo == SIGTERM) {
    probe_keep_running = 0;
  }
}

__attribute__((noinline)) static int probe_bridge_leaf_wait(int seed, const char *label) {
  int counter = seed;
  int derived = seed * 3;
  const char *local_label = label;

  while (probe_keep_running) {
    pause();
    counter += 1;
    derived = counter * 3;
  }

  return derived + local_label[0] + probe_last_signal;
}

__attribute__((noinline)) static int probe_bridge_middle_frame(int seed, const char *label) {
  int offset = seed + 4;
  return probe_bridge_leaf_wait(seed, label) + offset;
}

int main(void) {
  struct sigaction action = {0};
  action.sa_handler = probe_handle_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGUSR1, &action, 0);
  sigaction(SIGTERM, &action, 0);

  const int seed = 7;
  const char *label = "probe-lldb-target";

  return probe_bridge_middle_frame(seed, label);
}
