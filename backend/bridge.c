#include <vpi_user.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#define MAX_SIGNALS 512
static vpiHandle signals[MAX_SIGNALS];
static int count = 0, skipped_signals = 0, clock_id = -1, remaining = 0, level = 0, limit_error = 0;
static uint64_t half_period = 0;
static int pending_count = 0, pending_ids[MAX_SIGNALS];
static char pending_values[MAX_SIGNALS][4097];
static char stdout_buf[65536];
static PLI_INT32 boundary(p_cb_data cb);
static PLI_INT32 settled(p_cb_data cb);

static void later(int reason, uint64_t delay, PLI_INT32 (*fn)(p_cb_data)) {
  s_vpi_time t = {0};
  t.type = vpiSimTime; t.high = (uint32_t)(delay >> 32); t.low = (uint32_t)delay;
  s_cb_data c = {0};
  c.reason = reason; c.cb_rtn = fn; c.time = &t;
  vpi_register_cb(&c);
}

static void quoted(const char *s) {
  if (!s) s = "";
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 32) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static void collect(vpiHandle scope, int depth) {
  if (depth > 16) { skipped_signals++; return; }
  int kinds[] = {vpiNet, vpiReg, vpiIntegerVar};
  for (int k = 0; k < 3; k++) {
    vpiHandle it = vpi_iterate(kinds[k], scope), h;
    while (it && (h = vpi_scan(it))) {
      const char *raw = vpi_get_str(vpiFullName, h);
      if (!raw || !raw[0]) { skipped_signals++; continue; }
      char name[4096];
      snprintf(name, sizeof(name), "%s", raw);
      int duplicate = 0;
      for (int i = 0; i < count; i++) {
        const char *existing = vpi_get_str(vpiFullName, signals[i]);
        if (existing && !strcmp(name, existing)) { duplicate = 1; break; }
      }
      if (!duplicate) {
        int width = vpi_get(vpiSize, h);
        if (count >= MAX_SIGNALS || width < 1 || width > 4096) skipped_signals++;
        else signals[count++] = h;
      }
    }
  }
  vpiHandle it = vpi_iterate(vpiModule, scope), h;
  while (it && (h = vpi_scan(it))) collect(h, depth + 1);
}

static void sample(void) {
  s_vpi_time t = {0}; t.type = vpiSimTime; vpi_get_time(NULL, &t);
  printf("@TRACE {\"type\":\"sample\",\"time\":\"%llu\",\"values\":[", (unsigned long long)(((uint64_t)t.high << 32) | t.low));
  for (int i = 0; i < count; i++) {
    s_vpi_value v = {0}; v.format = vpiBinStrVal; vpi_get_value(signals[i], &v);
    if (i) putchar(',');
    quoted(v.value.str ? v.value.str : "x");
  }
  puts("]}");
}

static void put(int id, const char *bits) {
  if (id < 0 || id >= count) return;
  s_vpi_value v = {0}; v.format = vpiBinStrVal; v.value.str = (char *)bits;
  vpi_put_value(signals[id], &v, NULL, vpiNoDelay);
}

static int command(void) {
  fflush(stdout);
  char line[256];
  if (!fgets(line, sizeof(line), stdin)) { vpi_control(vpiFinish, 0); return 0; }
  if (!strchr(line, '\n') && !feof(stdin)) { vpi_control(vpiFinish, 1); return 0; }
  if (line[0] == 'Q') { vpi_control(vpiFinish, 0); return 0; }
  unsigned long long hp;
  if (sscanf(line, "R %d %llu %d %d", &remaining, &hp, &clock_id, &pending_count) != 4 || remaining < 0 || remaining > 8192 || (remaining > 0 && hp == 0) || pending_count < 0 || pending_count > MAX_SIGNALS) {
    vpi_control(vpiFinish, 1); return 0;
  }
  half_period = (uint64_t)hp;
  for (int i = 0; i < pending_count; i++) {
    char input[4160];
    if (!fgets(input, sizeof(input), stdin) || (!strchr(input, '\n') && !feof(stdin)) || sscanf(input, "%d %4096s", &pending_ids[i], pending_values[i]) != 2) { vpi_control(vpiFinish, 1); return 0; }
  }
  level = 0;
  if (clock_id >= 0 && clock_id < count) {
    s_vpi_value current = {0}; current.format = vpiBinStrVal;
    vpi_get_value(signals[clock_id], &current);
    if (current.value.str) level = current.value.str[0] == '1' || current.value.str[0] == 'H';
    for (int i = 0; i < pending_count; i++) if (pending_ids[i] == clock_id) level = pending_values[i][0] == '1' || pending_values[i][0] == 'H';
  }
  later(cbAfterDelay, pending_count ? 0 : (remaining ? half_period : 0), boundary);
  return 0;
}

static PLI_INT32 finished(p_cb_data cb) {
  (void)cb;
  puts("@TRACE {\"type\":\"done\"}"); fflush(stdout); command();
  return 0;
}

static PLI_INT32 finish_boundary(p_cb_data cb) {
  (void)cb;
  later(cbReadWriteSynch, 0, finished);
  return 0;
}

static PLI_INT32 settled(p_cb_data cb) {
  (void)cb;
  sample();
  if (remaining > 0) later(cbAfterDelay, half_period, boundary);
  else later(cbAfterDelay, 0, finish_boundary);
  return 0;
}

static PLI_INT32 boundary(p_cb_data cb) {
  (void)cb;
  if (pending_count) {
    for (int i = 0; i < pending_count; i++) put(pending_ids[i], pending_values[i]);
    pending_count = 0;
  } else if (remaining > 0) {
    level = !level;
    if (clock_id >= 0) put(clock_id, level ? "1" : "0");
    remaining--;
  }
  /* Input commands can enqueue same-time writes; read-only callbacks corrupt delayed scheduling in GHDL. */
  later(cbReadWriteSynch, 0, settled);
  return 0;
}

static PLI_INT32 changed(p_cb_data cb) {
  int id = (int)(intptr_t)cb->user_data;
  s_vpi_time t = {0}; t.type = vpiSimTime; vpi_get_time(NULL, &t);
  s_vpi_value v = {0}; v.format = vpiBinStrVal; vpi_get_value(signals[id], &v);
  printf("@TRACE {\"type\":\"change\",\"time\":\"%llu\",\"id\":%d,\"value\":", (unsigned long long)(((uint64_t)t.high << 32) | t.low), id);
  quoted(v.value.str ? v.value.str : "x");
  puts("}");
  return 0;
}

static PLI_INT32 start(p_cb_data cb) {
  (void)cb;
  setvbuf(stdout, stdout_buf, _IOFBF, sizeof(stdout_buf));
  collect(NULL, 0);
  if (limit_error) { puts("Bridge observation limit exceeded: 512 signals, 4096 bits per signal, 16 hierarchy levels."); fflush(stdout); vpi_control(vpiFinish, 1); return 0; }
  if (skipped_signals > 0) {
    printf("Note: skipped %d signal(s) exceeding observation limits (512 signals, 4096 bits, depth 16).\n", skipped_signals);
  }
  printf("@TRACE {\"type\":\"ready\",\"precision\":%d,\"signals\":[", vpi_get(vpiTimePrecision, NULL));
  for (int i = 0; i < count; i++) {
    if (i) putchar(',');
    printf("{\"id\":%d,\"name\":", i); quoted(vpi_get_str(vpiFullName, signals[i]));
    int width = vpi_get(vpiSize, signals[i]);
    printf(",\"width\":%d,\"direction\":%d,\"kind\":%d", width, vpi_get(vpiDirection, signals[i]), vpi_get(vpiType, signals[i]));
    vpiHandle left = vpi_handle(vpiLeftRange, signals[i]), right = vpi_handle(vpiRightRange, signals[i]);
    if (left && right) {
      s_vpi_value l = {0}, r = {0}; l.format = r.format = vpiIntVal;
      vpi_get_value(left, &l); vpi_get_value(right, &r);
      printf(",\"left\":%d,\"right\":%d", l.value.integer, r.value.integer);
    }
    if (left) vpi_free_object(left);
    if (right) vpi_free_object(right);
    putchar('}');
  }
  puts("]}");
  fflush(stdout);
  for (int i = 0; i < count; i++) {
    s_cb_data change = {0};
    change.reason = cbValueChange; change.cb_rtn = changed; change.obj = signals[i];
    change.time = NULL; change.value = NULL; change.user_data = (PLI_BYTE8 *)(intptr_t)i;
    vpi_register_cb(&change);
  }
  later(cbAfterDelay, 0, boundary);
  return 0;
}

static PLI_INT32 end_simulation(p_cb_data cb) {
  (void)cb;
  if (!limit_error) sample();
  fflush(stdout);
  return 0;
}

static void register_bridge(void) {
  later(cbStartOfSimulation, 0, start);
  later(cbEndOfSimulation, 0, end_simulation);
}
void (*vlog_startup_routines[])(void) = {register_bridge, NULL};
