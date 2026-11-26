/* Bağımlılıksız küçük test düzeneği (host). */
#pragma once
#include <math.h>
#include <stdio.h>
#include <string.h>

extern int yt_test_failures;
extern int yt_test_checks;

#define CHECK(cond) do { yt_test_checks++; if (!(cond)) { yt_test_failures++; \
    fprintf(stderr, "  BAŞARISIZ %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_STR(a, b) do { yt_test_checks++; if (strcmp((a), (b)) != 0) { yt_test_failures++; \
    fprintf(stderr, "  BAŞARISIZ %s:%d: \"%s\" != \"%s\"\n", __FILE__, __LINE__, (a), (b)); } } while (0)
#define CHECK_NEAR(a, b, eps) do { yt_test_checks++; if (fabs((double)(a) - (double)(b)) > (eps)) { yt_test_failures++; \
    fprintf(stderr, "  BAŞARISIZ %s:%d: %.6f != %.6f (±%g)\n", __FILE__, __LINE__, (double)(a), (double)(b), (double)(eps)); } } while (0)

void test_hmac(void);
void test_flow(void);
void test_session(void);
void test_failopen(void);
