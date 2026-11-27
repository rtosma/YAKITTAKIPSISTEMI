#include "yt_session.h"
#include "yt_test.h"

static yt_session_t granted(int64_t t)
{
    yt_session_t s;
    yt_session_init(&s);
    CHECK(yt_session_on_card(&s, "CARD-881201", t));
    CHECK(yt_session_on_auth_granted(&s, "dsess-1", 320.0, 1000.0, "ESP32-PUMP-02", t + 100));
    return s;
}

void test_session(void)
{
    yt_session_t s;
    yt_session_init(&s);

    /* TEK KAPI: yetki olmadan röle hiçbir durumda açılamaz. */
    CHECK(!yt_session_relay_allowed(&s));
    CHECK(yt_session_on_card(&s, "CARD-1", 0));
    CHECK(s.state == YT_S_REQUESTING);
    CHECK(!yt_session_relay_allowed(&s));            /* yanıt beklenirken kapalı */
    CHECK(!yt_session_on_card(&s, "CARD-2", 10));    /* ikinci kart yok sayılır */

    /* Ret → ABORTED, röle kapalı, ret kodu saklanır; sonra IDLE. */
    CHECK(yt_session_on_auth_denied(&s, "QUOTA_EXHAUSTED", 50));
    CHECK(s.state == YT_S_ABORTED);
    CHECK_STR(s.denial, "QUOTA_EXHAUSTED");
    CHECK(!yt_session_relay_allowed(&s));
    CHECK(yt_session_reset(&s, 60));
    CHECK(s.state == YT_S_IDLE);

    /* Geçersiz yetki yanıtı (sessionId yok / limit 0) güvenli tarafta kalır. */
    yt_session_init(&s);
    CHECK(yt_session_on_card(&s, "CARD-1", 0));
    CHECK(!yt_session_on_auth_granted(&s, "", 320.0, 0.0, "D", 10));
    CHECK(!yt_session_relay_allowed(&s));
    yt_session_init(&s);
    CHECK(yt_session_on_card(&s, "CARD-1", 0));
    CHECK(!yt_session_on_auth_granted(&s, "dsess-x", 0.0, 0.0, "D", 10));
    CHECK(!yt_session_relay_allowed(&s));

    /* Mutlu yol: AUTHORIZED → (ilk heartbeat) PUMPING → akış durur → FINALIZING → COMPLETED. */
    s = granted(0);
    CHECK(s.state == YT_S_AUTHORIZED);
    CHECK(yt_session_relay_allowed(&s));
    CHECK_STR(s.idempotency_key, "ESP32-PUMP-02:dsess-1");
    CHECK(yt_session_heartbeat_due(&s, 200));
    yt_session_mark_heartbeat_sent(&s, 200);
    CHECK(!yt_session_heartbeat_due(&s, 3000));
    CHECK(yt_session_heartbeat_due(&s, 5200));
    CHECK(yt_session_on_heartbeat_ack(&s, false, 300));
    CHECK(s.state == YT_S_PUMPING);
    yt_session_tick(&s, 12.5, true, 10000);
    CHECK(s.state == YT_S_PUMPING);
    CHECK(yt_session_on_heartbeat_ack(&s, false, 25000));   /* heartbeat'ler sürüyor */
    yt_session_tick(&s, 12.5, false, 10000 + YT_NO_FLOW_FINISH_MS - 1);
    CHECK(s.state == YT_S_PUMPING);                  /* kısa ara: oturum sürer */
    yt_session_tick(&s, 12.5, false, 10000 + YT_NO_FLOW_FINISH_MS);
    CHECK(s.state == YT_S_FINALIZING);
    CHECK(s.end_reason == YT_END_FLOW_STOPPED);
    CHECK(!yt_session_relay_allowed(&s));
    CHECK(yt_session_finalize_pending(&s));
    /* Ağ hatası: FINALIZING'de kalır, AYNI idempotency anahtarı korunur. */
    CHECK(yt_session_on_finalize_failed(&s, 41000));
    CHECK(s.state == YT_S_FINALIZING);
    CHECK_STR(s.idempotency_key, "ESP32-PUMP-02:dsess-1");
    CHECK(s.finalize_attempts == 1);
    CHECK(yt_session_on_finalize_ok(&s, 42000));
    CHECK(s.state == YT_S_COMPLETED);
    CHECK(yt_session_reset(&s, 43000));
    CHECK(s.state == YT_S_IDLE && s.session_id[0] == '\0');

    /* Yerel limit: maxAllowedLiters'a ulaşınca sunucuyu beklemeden kes. */
    s = granted(0);
    yt_session_on_heartbeat_ack(&s, false, 200);
    yt_session_tick(&s, 319.9, true, 1000);
    CHECK(yt_session_relay_allowed(&s));
    yt_session_tick(&s, 320.0, true, 1100);
    CHECK(s.state == YT_S_FINALIZING && s.end_reason == YT_END_LIMIT_REACHED);
    CHECK(!yt_session_relay_allowed(&s));

    /* FORCE_CUTOFF — HTTP heartbeat yanıtından. Kesme mandallı: sonradan gelen
     * "CONTINUE" röleyi tekrar açamaz. */
    s = granted(0);
    CHECK(yt_session_on_heartbeat_ack(&s, true, 200));
    CHECK(s.state == YT_S_FINALIZING && s.end_reason == YT_END_FORCE_CUTOFF);
    CHECK(!yt_session_on_heartbeat_ack(&s, false, 300));
    CHECK(!yt_session_relay_allowed(&s));

    /* FORCE_CUTOFF — MQTT kanalından; tekrar gelmesi zararsız (etkisiz-yinelemeli). */
    s = granted(0);
    yt_session_on_heartbeat_ack(&s, false, 200);
    CHECK(yt_session_on_force_cutoff(&s, "dsess-1", 300));
    CHECK(!yt_session_relay_allowed(&s));
    CHECK(!yt_session_on_force_cutoff(&s, "dsess-1", 400));
    CHECK(s.state == YT_S_FINALIZING);
    /* Başka oturum kimliğiyle gelse de aktif ikmal kesilir (güvenli taraf). */
    s = granted(0);
    CHECK(yt_session_on_force_cutoff(&s, "dsess-eski", 300));
    CHECK(!yt_session_relay_allowed(&s));

    /* Acil durdurma: akan yakıt kaydedilsin diye FINALIZING (ABORTED değil). */
    s = granted(0);
    yt_session_on_heartbeat_ack(&s, false, 200);
    CHECK(yt_session_on_emergency_stop(&s, 500));
    CHECK(s.state == YT_S_FINALIZING && s.end_reason == YT_END_EMERGENCY_STOP);
    CHECK(!yt_session_relay_allowed(&s));
    /* Yanıt beklerken acil durdurma → ABORTED. */
    yt_session_init(&s);
    yt_session_on_card(&s, "C", 0);
    CHECK(yt_session_on_emergency_stop(&s, 10));
    CHECK(s.state == YT_S_ABORTED);

    /* Yetki alındı ama akış hiç başlamadı → zaman aşımında kes. Heartbeat'ler başarılı
     * olsa da (ilk yanıt oturumu PUMPING'e geçirir) kural geçerli. */
    s = granted(0);
    for (int64_t t = 5000; t < YT_AUTH_START_TIMEOUT_MS; t += 5000) {
        CHECK(yt_session_on_heartbeat_ack(&s, false, t));
        yt_session_tick(&s, 0.0, false, t + 1);
    }
    CHECK(s.state == YT_S_PUMPING);
    yt_session_tick(&s, 0.0, false, YT_AUTH_START_TIMEOUT_MS - 1);
    CHECK(s.state == YT_S_PUMPING);
    yt_session_tick(&s, 0.0, false, YT_AUTH_START_TIMEOUT_MS + 200);
    CHECK(s.state == YT_S_FINALIZING && s.end_reason == YT_END_NO_FLOW_STARTED);
    CHECK(!yt_session_relay_allowed(&s));

    /* Kart çekilince kes (yalnızca oturumu açan kart). */
    {
        yt_session_t c = granted(0);
        CHECK(!yt_session_on_card_removed(&c, "BASKA-KART", 100));
        CHECK(yt_session_relay_allowed(&c));
        CHECK(yt_session_on_card_removed(&c, c.card_id, 200));
        CHECK(c.state == YT_S_FINALIZING && c.end_reason == YT_END_CARD_REMOVED);
        CHECK(!yt_session_relay_allowed(&c));
        CHECK(!yt_session_on_card_removed(&c, c.card_id, 300));   /* bir kez */
        CHECK_STR(yt_end_reason_name(YT_END_CARD_REMOVED), "CARD_REMOVED");
    }

    /* Sunucuya 15 sn ulaşılamadı → sunucu zaten TIMED_OUT yaptı; cihaz da keser. */
    {
        yt_session_t l = granted(0);
        CHECK(yt_session_on_heartbeat_ack(&l, false, 1000));
        yt_session_tick(&l, 40.0, true, 1000 + YT_LINK_LOST_CUTOFF_MS - 1);
        CHECK(l.state == YT_S_PUMPING && yt_session_relay_allowed(&l));
        yt_session_tick(&l, 41.0, true, 1000 + YT_LINK_LOST_CUTOFF_MS);
        CHECK(l.state == YT_S_FINALIZING && l.end_reason == YT_END_LINK_LOST);
        CHECK(!yt_session_relay_allowed(&l));
        CHECK_STR(yt_end_reason_name(YT_END_LINK_LOST), "LINK_LOST");
    }

    /* Sunucu finalize'ı geçersiz saydı → ABORTED. */
    CHECK(yt_session_on_finalize_rejected(&s, 70000));
    CHECK(s.state == YT_S_ABORTED);

    /* Açılışta yarım kalmış oturum: röle KAPALI, anormal sonlanma olarak finalize edilir (FW-1303 AC). */
    yt_session_restore_abnormal(&s, "dsess-9", "ESP32-PUMP-02:dsess-9", 2000.0, 5);
    CHECK(s.state == YT_S_FINALIZING);
    CHECK(s.end_reason == YT_END_ABNORMAL_RESTART);
    CHECK(!yt_session_relay_allowed(&s));
    CHECK_STR(s.idempotency_key, "ESP32-PUMP-02:dsess-9");

    /* Geçersiz geçişler reddedilir. */
    yt_session_init(&s);
    CHECK(!yt_session_on_auth_granted(&s, "x", 10, 0, "D", 0));
    CHECK(!yt_session_on_heartbeat_ack(&s, false, 0));
    CHECK(!yt_session_on_finalize_ok(&s, 0));
    CHECK(!yt_session_reset(&s, 0));
    CHECK_STR(yt_session_state_name(YT_S_PUMPING), "PUMPING");
    CHECK_STR(yt_end_reason_name(YT_END_FORCE_CUTOFF), "FORCE_CUTOFF");
}
