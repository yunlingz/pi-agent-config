#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <locale.h>
#include "printf/printf.h"
#undef printf
#undef sprintf
#undef snprintf
#undef vsnprintf
#undef vprintf
#undef fprintf

__attribute__((import_module("code_anchor"), import_name("monotonic_ms")))
extern double host_monotonic_ms(void);
__attribute__((import_module("code_anchor"), import_name("stream_write")))
extern int host_stream_write(int, const void *, size_t);
__attribute__((import_module("code_anchor"), import_name("stream_close")))
extern int host_stream_close(int);
__attribute__((import_module("code_anchor"), import_name("stream_dup")))
extern int host_stream_dup(int);
int dup(int descriptor) { return host_stream_dup(descriptor); }

FILE code_anchor_stdin = {0}, code_anchor_stdout = {1}, code_anchor_stderr = {2};

int clock_gettime(int id, struct timespec *result) {
    if (id != CLOCK_MONOTONIC || !result) return -1;
    double milliseconds = host_monotonic_ms();
    result->tv_sec = (time_t)(milliseconds / 1000.0);
    result->tv_nsec = (long)((milliseconds - (double)result->tv_sec * 1000.0) * 1000000.0);
    return 0;
}
clock_t clock(void) { return (clock_t)(host_monotonic_ms() * 1000.0); }
void _putchar(char character) { host_stream_write(1, &character, 1); }
int snprintf(char *buffer, size_t size, const char *format, ...) {
    va_list args; va_start(args, format);
    int result = vsnprintf_(buffer, size, format, args);
    va_end(args); return result;
}
int vsnprintf(char *buffer, size_t size, const char *format, va_list args) {
    return vsnprintf_(buffer, size, format, args);
}
int sprintf(char *buffer, const char *format, ...) {
    va_list args; va_start(args, format);
    int result = vsnprintf_(buffer, (size_t)-1, format, args);
    va_end(args); return result;
}
static int output(FILE *stream, const char *format, va_list args) {
    va_list copy; va_copy(copy, args);
    int length = vsnprintf_(NULL, 0, format, copy); va_end(copy);
    if (length < 0) return length;
    char *buffer = malloc((size_t)length + 1);
    if (!buffer) return -1;
    vsnprintf_(buffer, (size_t)length + 1, format, args);
    int written = host_stream_write(stream->descriptor, buffer, (size_t)length);
    free(buffer); return written == length ? length : -1;
}
int fprintf(FILE *stream, const char *format, ...) {
    va_list args; va_start(args, format); int result = output(stream, format, args); va_end(args); return result;
}
int printf(const char *format, ...) {
    va_list args; va_start(args, format); int result = output(stdout, format, args); va_end(args); return result;
}
int vprintf(const char *format, va_list args) { return output(stdout, format, args); }
int fputs(const char *text, FILE *stream) {
    size_t size = strlen(text); return host_stream_write(stream->descriptor, text, size) == (int)size ? 0 : EOF;
}
int fputc(int character, FILE *stream) {
    unsigned char byte = (unsigned char)character;
    return host_stream_write(stream->descriptor, &byte, 1) == 1 ? byte : EOF;
}
size_t fwrite(const void *buffer, size_t size, size_t count, FILE *stream) {
    if (!size || !count || count > SIZE_MAX / size) return 0;
    int written = host_stream_write(stream->descriptor, buffer, size * count);
    return written < 0 ? 0 : (size_t)written / size;
}
FILE *fdopen(int descriptor, const char *mode) {
    if (descriptor < 0 || !mode || !(mode[0] == 'w' || mode[0] == 'a')) return NULL;
    FILE *stream = malloc(sizeof(FILE));
    if (stream) stream->descriptor = descriptor;
    return stream;
}
int fclose(FILE *stream) {
    if (!stream) return EOF;
    int result = host_stream_close(stream->descriptor);
    if (stream != stdin && stream != stdout && stream != stderr) free(stream);
    return result;
}
char *setlocale(int category, const char *name) {
    static char locale[] = "C.UTF-8";
    if (category != LC_ALL && category != LC_CTYPE) return NULL;
    if (!name || !strcmp(name, "C.UTF-8") || !strcmp(name, "C.utf8") || !strcmp(name, "")) return locale;
    return NULL;
}
