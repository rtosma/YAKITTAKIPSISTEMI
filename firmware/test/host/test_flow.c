#include "yt_flow.h"
#include "yt_test.h"

void test_flow(void)
{
    yt_flow_t f;
    yt_flow_init(&f, 450.0, 1000.0);   /* 450 pals/L, NVS'ten 1000 L geri yüklendi */
    CHECK_NEAR(yt_flow_totalizer_liters(&f), 1000.0, 1e-9);

    /* 4500 pals = 10 L */
    yt_flow_session_begin(&f);
    yt_flow_add_pulses(&f, 4500, 10000);
    CHECK_NEAR(yt_flow_session_liters(&f), 10.0, 1e-9);
    CHECK_NEAR(yt_flow_totalizer_liters(&f), 1010.0, 1e-9);

    /* İkmal sırasında K değişikliği ERTELENİR; litre tutarlı kalır. */
    CHECK(yt_flow_set_k_factor(&f, 500.0) == YT_FLOW_K_DEFERRED);
    yt_flow_add_pulses(&f, 450, 10100);
    CHECK_NEAR(yt_flow_session_liters(&f), 11.0, 1e-9);
    CHECK_NEAR(yt_flow_session_end(&f), 11.0, 1e-9);
    /* Bitince uygulanır; geçmiş litre korunur. */
    CHECK_NEAR(f.k_factor, 500.0, 1e-12);
    CHECK_NEAR(yt_flow_totalizer_liters(&f), 1011.0, 1e-9);
    yt_flow_add_pulses(&f, 500, 20000);
    CHECK_NEAR(yt_flow_totalizer_liters(&f), 1012.0, 1e-9);

    /* İkmal dışında doğrudan uygulanır; geçersiz değerler reddedilir. */
    CHECK(yt_flow_set_k_factor(&f, 450.0) == YT_FLOW_K_APPLIED);
    CHECK(yt_flow_set_k_factor(&f, 0.0) == YT_FLOW_K_INVALID);
    CHECK(yt_flow_set_k_factor(&f, -5.0) == YT_FLOW_K_INVALID);
    CHECK(yt_flow_set_k_factor(&f, NAN) == YT_FLOW_K_INVALID);
    CHECK(yt_flow_set_k_factor(&f, 1e9) == YT_FLOW_K_INVALID);
    CHECK_NEAR(f.k_factor, 450.0, 1e-12);

    /* Anlık debi: 60 L/dk = 1 L/sn = 450 pals/sn. 100 ms'de 45 pals. */
    yt_flow_t r;
    yt_flow_init(&r, 450.0, 0.0);
    for (int i = 0; i < 20; i++) yt_flow_add_pulses(&r, 45, 50000 + i * 100);
    CHECK_NEAR(yt_flow_rate_lpm(&r, 51950), 60.0, 0.5);
    /* Akış durunca 1 sn içinde sıfıra iner. */
    CHECK_NEAR(yt_flow_rate_lpm(&r, 53500), 0.0, 1e-9);

    /* 64-bit totalizatör: 32-bit sınırını aşan pals kaybolmaz. */
    yt_flow_t big;
    yt_flow_init(&big, 1.0, 0.0);
    for (int i = 0; i < 5; i++) yt_flow_add_pulses(&big, 1000000000u, i);
    CHECK_NEAR(yt_flow_totalizer_liters(&big), 5e9, 1.0);

    /* Geçersiz başlangıç K → güvenli varsayılan; negatif totalizatör → 0. */
    yt_flow_t bad;
    yt_flow_init(&bad, -1.0, -50.0);
    CHECK_NEAR(bad.k_factor, 450.0, 1e-12);
    CHECK_NEAR(yt_flow_totalizer_liters(&bad), 0.0, 1e-12);
}
