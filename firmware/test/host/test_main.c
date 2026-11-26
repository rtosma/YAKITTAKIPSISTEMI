#include "yt_test.h"

int yt_test_failures = 0;
int yt_test_checks = 0;

int main(void)
{
    struct { const char *name; void (*fn)(void); } suites[] = {
        { "hmac (FW-1308)", test_hmac },
        { "flow (FW-1304)", test_flow },
        { "session (FUEL-401 / FW-1303)", test_session },
        { "failopen (FW-1310)", test_failopen },
        { "persist (FW-1314)", test_persist },
    };
    for (size_t i = 0; i < sizeof suites / sizeof suites[0]; i++) {
        int before = yt_test_failures;
        suites[i].fn();
        printf("%s %s\n", yt_test_failures == before ? "✅" : "❌", suites[i].name);
    }
    printf("\n%d kontrol, %d başarısız\n", yt_test_checks, yt_test_failures);
    return yt_test_failures == 0 ? 0 : 1;
}
