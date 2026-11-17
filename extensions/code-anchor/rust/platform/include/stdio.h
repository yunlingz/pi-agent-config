#ifndef CODE_ANCHOR_STDIO_H
#define CODE_ANCHOR_STDIO_H
#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>
typedef struct { int descriptor; } FILE;
extern FILE code_anchor_stdin, code_anchor_stdout, code_anchor_stderr;
#define stdin (&code_anchor_stdin)
#define stdout (&code_anchor_stdout)
#define stderr (&code_anchor_stderr)
#define EOF (-1)
int snprintf(char *, size_t, const char *, ...);
int vsnprintf(char *, size_t, const char *, va_list);
int sprintf(char *, const char *, ...);
int printf(const char *, ...);
int vprintf(const char *, va_list);
int fprintf(FILE *, const char *, ...);
int fputs(const char *, FILE *);
int fputc(int, FILE *);
size_t fwrite(const void *, size_t, size_t, FILE *);
FILE *fdopen(int, const char *);
int fclose(FILE *);
#endif
