#include "yt_flow.h"
#include "yt_persist.h"
#include "yt_session.h"
#include "yt_test.h"

/* debi (L/dk) ile `seconds` boyunca 100 ms'lik tick'lerle akış simüle eder.
 * Dönüş: herhangi bir anda NVS'tekiyle gerçek değer arasındaki en büyük fark (L). */
static double simulate_max_loss(double lpm, int seconds, int *commits)
{
    yt_commit_policy_t c;
    yt_commit_init(&c, 0, 0);
    double total = 0, max_gap = 0;
    *commits = 0;
    for (int64_t t = 100; t <= (int64_t)seconds * 1000; t += 100) {
        total += lpm / 600.0; /* 100 ms'de akan */
        uint64_t ml = yt_liters_to_ml(total);
        if (yt_commit_due(&c, ml, t)) {
            yt_commit_done(&c, ml, t);
            (*commits)++;
        }
        /* güç TAM şimdi kesilirse kaybolan */
        double gap = total - yt_ml_to_liters(c.committed_ml);
        if (gap > max_gap) max_gap = gap;
    }
    return max_gap;
}

static void make_active_session(yt_session_t *s)
{
    yt_session_init(s);
    CHECK(yt_session_on_card(s, "CARD-881201", 0));
    CHECK(yt_session_on_auth_granted(s, "dsess-42", 320.0, 1234.5, "pump-7", 10));
}

void test_persist(void)
{
    /* --- litre ↔ mL --- */
    CHECK(yt_liters_to_ml(0.3) == 300);
    CHECK(yt_liters_to_ml(1010.0) == 1010000);
    CHECK(yt_liters_to_ml(1.0009) == 1000);       /* aşağı yuvarlanır */
    CHECK(yt_liters_to_ml(-1.0) == 0);
    CHECK(yt_liters_to_ml(NAN) == 0);
    CHECK_NEAR(yt_ml_to_liters(1234567), 1234.567, 1e-9);

    /* --- commit politikası --- */
    yt_commit_policy_t c;
    yt_commit_init(&c, 1000000, 0);
    CHECK(!yt_commit_due(&c, 1000000, 3600000));   /* rölanti: 1 saat geçse de yazma yok */
    CHECK(!yt_commit_due(&c, 999000, 3600000));    /* daha küçük değer asla yazılmaz */
    yt_commit_init(&c, 1000000, 0);
    CHECK(!yt_commit_due(&c, 1004999, 1000));
    CHECK(yt_commit_due(&c, 1005000, 1000));       /* 5 L */
    yt_commit_done(&c, 1005000, 1000);
    CHECK(c.committed_ml == 1005000);
    CHECK(!yt_commit_due(&c, 1005010, 10999));
    CHECK(yt_commit_due(&c, 1005010, 11000));      /* düşük debide 10 sn */
    yt_commit_done(&c, 1004000, 12000);            /* geri giden değer committed'ı düşürmez */
    CHECK(c.committed_ml == 1005000);

    /* FW-1314 AC: kesinti anında en fazla 5 L kayıp. */
    int commits = 0;
    double loss = simulate_max_loss(60.0, 600, &commits);   /* 60 L/dk, 10 dk = 600 L */
    CHECK(loss <= 5.0 + 1e-6);
    CHECK(commits >= 110 && commits <= 125);                /* ~5 L'de bir: 600/5 = 120 */
    loss = simulate_max_loss(3.0, 600, &commits);           /* 3 L/dk: 10 sn'lik akış = 0,5 L */
    CHECK(loss <= 0.5 + 1e-6);
    CHECK(commits >= 55 && commits <= 61);                  /* 10 sn'de bir */
    loss = simulate_max_loss(200.0, 120, &commits);         /* yüksek debili sayaçta da 5 L */
    CHECK(loss <= 5.0 + 1e-6);

    /* --- PCNT ham sayaç farkı (donanım high_limit'te 0'a sarar) --- */
    CHECK(yt_flow_counter_delta(100, 150, 32767) == 50);
    CHECK(yt_flow_counter_delta(32700, 33, 32767) == 100);
    CHECK(yt_flow_counter_delta(5, 5, 32767) == 0);
    CHECK(yt_flow_counter_delta(32766, 32767, 32767) == 1); /* sınır değeri anlık görünse de ≡ 0 */
    CHECK(yt_flow_counter_delta(32767, 0, 32767) == 0);
    CHECK(yt_flow_counter_delta(0, 10, 0) == 0);

    /* --- CRC-32 bilinen vektör --- */
    CHECK(yt_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u);

    /* --- oturum işareti: hangi durumda ne yazılır --- */
    yt_session_t s;
    yt_session_init(&s);
    CHECK(yt_marker_phase_for(&s) == YT_MARKER_NONE);
    CHECK(yt_session_on_card(&s, "CARD-1", 0));
    CHECK(yt_marker_phase_for(&s) == YT_MARKER_NONE);   /* REQUESTING: henüz sunucu oturumu yok */
    make_active_session(&s);
    CHECK(yt_marker_phase_for(&s) == YT_MARKER_ACTIVE);
    yt_session_on_heartbeat_ack(&s, false, 100);
    CHECK(s.state == YT_S_PUMPING);
    CHECK(yt_marker_phase_for(&s) == YT_MARKER_ACTIVE);

    /* --- kodla / çöz gidiş-dönüş --- */
    yt_session_marker_t m, d;
    yt_marker_from_session(&s, &m);
    uint8_t buf[YT_MARKER_ENCODED_MAX];
    size_t n = yt_marker_encode(&m, buf, sizeof buf);
    CHECK(n > 0 && n <= YT_MARKER_ENCODED_MAX);
    CHECK(yt_marker_decode(buf, n, &d));
    CHECK(d.phase == YT_MARKER_ACTIVE);
    CHECK_STR(d.session_id, "dsess-42");
    CHECK_STR(d.idempotency_key, "pump-7:dsess-42");
    CHECK_NEAR(d.start_totalizer, 1234.5, 0);
    CHECK(yt_marker_encode(&m, buf, n - 1) == 0);       /* kapasite yetmezse yazmaz */

    /* Bozuk kayıtlar reddedilir: tek bit, kısaltma, fazlalık, boş. */
    uint8_t bad[YT_MARKER_ENCODED_MAX + 8];
    memcpy(bad, buf, n);
    bad[10] ^= 0x01;
    CHECK(!yt_marker_decode(bad, n, &d));
    CHECK(!yt_marker_decode(buf, n - 1, &d));
    memcpy(bad, buf, n);
    bad[n] = 0;
    CHECK(!yt_marker_decode(bad, n + 1, &d));
    CHECK(!yt_marker_decode(buf, 0, &d));
    CHECK(!yt_marker_decode(NULL, n, &d));
    /* Farklı sürüm (CRC doğru olsa bile) okunmaz. */
    memcpy(bad, buf, n);
    bad[4] = 2;
    uint32_t crc = yt_crc32(bad, n - 4);
    for (int i = 0; i < 4; i++) bad[n - 4 + i] = (uint8_t)(crc >> (8 * i));
    CHECK(!yt_marker_decode(bad, n, &d));

    /* --- ikmal SIRASINDA yeniden başlama → anormal sonlanma, röle kapalı --- */
    yt_session_t r;
    CHECK(yt_marker_restore(&m, &r, 5000));
    CHECK(r.state == YT_S_FINALIZING);
    CHECK(r.end_reason == YT_END_ABNORMAL_RESTART);
    CHECK(yt_session_recovered_after_restart(&r));
    CHECK(!yt_session_relay_allowed(&r));
    CHECK_STR(r.idempotency_key, "pump-7:dsess-42");   /* aynı anahtar → çift kayıt yok */
    CHECK_NEAR(r.start_totalizer, 1234.5, 0);
    CHECK(yt_session_finalize_pending(&r));
    /* Kurtarılan oturuma FORCE_CUTOFF/CONTINUE gelse de röle açılmaz. */
    CHECK(!yt_session_on_heartbeat_ack(&r, false, 5100));
    CHECK(!yt_session_relay_allowed(&r));

    /* İkinci kez yeniden başlarsa da "anormal" kalır (kayıt FINALIZING + ABNORMAL olur). */
    yt_marker_from_session(&r, &m);
    CHECK(m.phase == YT_MARKER_FINALIZING && m.end_reason == YT_END_ABNORMAL_RESTART);
    CHECK(yt_marker_restore(&m, &r, 9000));
    CHECK(yt_session_recovered_after_restart(&r));

    /* --- ikmal normal BİTTİKTEN sonra (finalize gitmeden) yeniden başlama --- */
    make_active_session(&s);
    yt_session_on_heartbeat_ack(&s, false, 100);
    yt_session_tick(&s, 12.0, true, 1000);
    yt_session_on_heartbeat_ack(&s, false, 1000 + YT_NO_FLOW_FINISH_MS - 100);
    yt_session_tick(&s, 12.0, false, 1000 + YT_NO_FLOW_FINISH_MS);
    CHECK(s.state == YT_S_FINALIZING && s.end_reason == YT_END_FLOW_STOPPED);
    yt_marker_from_session(&s, &m);
    CHECK(m.phase == YT_MARKER_FINALIZING);
    n = yt_marker_encode(&m, buf, sizeof buf);
    CHECK(yt_marker_decode(buf, n, &d));
    CHECK(yt_marker_restore(&d, &r, 50000));
    CHECK(r.state == YT_S_FINALIZING);
    CHECK(r.end_reason == YT_END_FLOW_STOPPED);         /* asıl sebep korunur */
    CHECK(!yt_session_recovered_after_restart(&r));     /* veri kaybı yok → normal doğrulama */
    CHECK(!yt_session_relay_allowed(&r));

    /* Tamamlanınca kayıt silinmeli. */
    CHECK(yt_session_on_finalize_ok(&r, 51000));
    CHECK(yt_marker_phase_for(&r) == YT_MARKER_NONE);

    /* Geçersiz kayıttan kurtarma yapılmaz. */
    memset(&m, 0, sizeof m);
    CHECK(!yt_marker_restore(&m, &r, 0));
    CHECK(r.state == YT_S_IDLE);
}
