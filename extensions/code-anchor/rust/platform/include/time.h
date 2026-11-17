#ifndef CODE_ANCHOR_TIME_H
#define CODE_ANCHOR_TIME_H
#include <stdint.h>
typedef int64_t time_t;
typedef int64_t clock_t;
struct timespec { time_t tv_sec; long tv_nsec; };
#define CLOCK_MONOTONIC 1
#define CLOCKS_PER_SEC 1000000
int clock_gettime(int, struct timespec *);
clock_t clock(void);
#endif
