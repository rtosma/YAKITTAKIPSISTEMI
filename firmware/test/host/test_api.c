#include "yt_api.h"
#include "yt_test.h"

/* Şartname §2.5'teki nonce'u üreten deterministik kaynak. */
static void spec_rng(void *buf, size_t len)
{
    static const uint8_t nonce[16] = { 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0xa7, 0xb8,
                                       0xc9, 0xd0, 0xe1, 0xf2, 0xa3, 0xb4, 0xc5, 0xd6 };
    memcpy(buf, nonce, len < sizeof nonce ? len : sizeof nonce);
}

static yt_session_t pumping_session(void)
{
    yt_session_t s;
    yt_session_init(&s);
    yt_session_on_card(&s, "CARD-881201", 0);
    yt_session_on_auth_granted(&s, "dsess-1", 320.0, 1000.0, "ESP32-PUMP-01", 10);
    yt_session_on_heartbeat_ack(&s, false, 100);
    return s;
}

void test_api(void)
{
    char body[YT_API_BODY_MAX];

    /* --- gövdeler: şartname vektörüyle BAYT BAYT aynı olmalı (imza gövdeye bağlı) --- */
    size_t n = yt_api_body_request_auth(body, sizeof body, "CARD-881201", "Gebze Ana Tank (T-1)");
    CHECK_STR(body, "{\"rfidCardId\":\"CARD-881201\",\"tankName\":\"Gebze Ana Tank (T-1)\"}");
    CHECK(n == strlen(body));

    yt_api_auth_t a;
    CHECK(yt_api_sign("ornek_test_gizli_anahtar_12345", 1788700000000LL, spec_rng, body, n, &a) == 0);
    CHECK_STR(a.timestamp, "1788700000000");
    CHECK_STR(a.nonce, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    CHECK_STR(a.signature, "d621eddad2c20ba99ead9816370c8eeea773d2a90a4d120701f9222622c4911d");
    CHECK(yt_api_sign("ornek_test_gizli_anahtar_12345", 1788700000000LL, spec_rng, NULL, 0, &a) == 0);
    CHECK_STR(a.signature, "991aa39d17cc4e261a57861ef19a2fb1738b8e7a729d6b94f21749cf1e51dd86");
    CHECK(yt_api_sign("", 1788700000000LL, spec_rng, NULL, 0, &a) != 0);   /* secret yoksa imza yok */
    CHECK(yt_api_sign("x", 0, spec_rng, NULL, 0, &a) != 0);                /* saat yoksa imza yok */

    /* Kaçış: tırnak, ters bölü, kontrol karakteri; Türkçe UTF-8 olduğu gibi. */
    yt_api_body_request_auth(body, sizeof body, "A\"B\\C\n", "Şantiye Tankı");
    CHECK_STR(body, "{\"rfidCardId\":\"A\\\"B\\\\C\\u000a\",\"tankName\":\"Şantiye Tankı\"}");
    CHECK(yt_api_body_request_auth(body, 20, "CARD-881201", "Gebze Ana Tank (T-1)") == 0);   /* sığmadı */
    CHECK(yt_api_body_request_auth(body, sizeof body, "", "T") == 0);

    n = yt_api_body_heartbeat(body, sizeof body, "dsess-1", 1234.5678, 48.25);
    CHECK_STR(body, "{\"sessionId\":\"dsess-1\",\"totalizerLiters\":1234.568,\"flowRateLpm\":48.2}");
    yt_api_body_heartbeat(body, sizeof body, "dsess-1", 10.0, -3.0);
    CHECK_STR(body, "{\"sessionId\":\"dsess-1\",\"totalizerLiters\":10.000,\"flowRateLpm\":0.0}");
    CHECK(yt_api_body_heartbeat(body, sizeof body, "dsess-1", NAN, 0) == 0);

    yt_session_t s = pumping_session();
    yt_api_body_finalize(body, sizeof body, &s, 1030.25);
    CHECK_STR(body, "{\"sessionId\":\"dsess-1\",\"endTotalizerLiters\":1030.250,\"reportedLiters\":30.250,"
                    "\"idempotencyKey\":\"ESP32-PUMP-01:dsess-1\"}");
    /* Yeniden başlatmadan kurtarılan oturum işaretlenir (FW-1314). */
    yt_session_t r;
    yt_session_restore_abnormal(&r, "dsess-1", "ESP32-PUMP-01:dsess-1", 1000.0, 0);
    yt_api_body_finalize(body, sizeof body, &r, 1004.0);
    CHECK_STR(body, "{\"sessionId\":\"dsess-1\",\"endTotalizerLiters\":1004.000,\"reportedLiters\":4.000,"
                    "\"idempotencyKey\":\"ESP32-PUMP-01:dsess-1\",\"recoveredAfterRestart\":true}");
    /* Totalizatör geri gitmişse (kurtarılan değer < başlangıç) negatif litre gönderilmez. */
    yt_api_body_finalize(body, sizeof body, &r, 999.0);
    CHECK(strstr(body, "\"reportedLiters\":0.000") != NULL);

    /* --- request-auth yanıtları --- */
    yt_api_auth_result_t ar;
    CHECK(yt_api_parse_request_auth(200,
        "{\"success\":true,\"data\":{\"sessionId\":\"dsess-9\",\"state\":\"AUTHORIZED\",\"vehiclePlate\":\"34 CTP 82\","
        "\"driverName\":\"Ahmet Yılmaz\",\"maxAllowedLiters\":320}}", &ar) == YT_API_OK);
    CHECK_STR(ar.session_id, "dsess-9");
    CHECK_NEAR(ar.max_allowed_liters, 320.0, 0);
    CHECK_STR(ar.vehicle_plate, "34 CTP 82");
    CHECK_STR(ar.driver_name, "Ahmet Yılmaz");
    CHECK_STR(ar.code, "");

    CHECK(yt_api_parse_request_auth(403,
        "{\"success\":false,\"error\":\"ForbiddenError\",\"message\":\"…\",\"details\":{\"error\":\"CARD_UNKNOWN\"}}",
        &ar) == YT_API_DENIED);
    CHECK_STR(ar.code, "CARD_UNKNOWN");
    CHECK(yt_api_parse_request_auth(409, "{\"success\":false,\"details\":{\"error\":\"TANK_LOW\"}}", &ar) == YT_API_DENIED);
    CHECK_STR(ar.code, "TANK_LOW");
    CHECK(yt_api_parse_request_auth(403, "{\"success\":false,\"error\":\"DEVICE_BLOCKED\"}", &ar) == YT_API_DENIED);
    CHECK_STR(ar.code, "DEVICE_BLOCKED");
    /* Yetki "başarılı" ama limit/oturum yok → güvenli tarafta reddet. */
    CHECK(yt_api_parse_request_auth(200, "{\"success\":true,\"data\":{\"sessionId\":\"x\"}}", &ar) == YT_API_DENIED);
    CHECK_STR(ar.code, "INVALID_AUTH_RESPONSE");
    CHECK(ar.session_id[0] == '\0');
    CHECK(yt_api_parse_request_auth(200, "{\"success\":true,\"data\":{\"sessionId\":\"x\",\"maxAllowedLiters\":0}}",
                                    &ar) == YT_API_DENIED);
    /* Geçici durumlar. */
    const char *replay = "{\"success\":false,\"error\":\"REPLAY_ATTACK_DETECTED\",\"message\":\"…\"}";
    CHECK(yt_api_parse_request_auth(401, replay, &ar) == YT_API_RETRY);
    CHECK(yt_api_is_clock_rejection(401, replay));
    CHECK(!yt_api_is_clock_rejection(401, "{\"error\":\"INVALID_HARDWARE_SIGNATURE\"}"));
    CHECK(yt_api_parse_request_auth(401, "{\"error\":\"NONCE_REUSED\"}", &ar) == YT_API_RETRY);
    CHECK(yt_api_parse_request_auth(429, "{\"error\":\"TOO_MANY_REQUESTS\"}", &ar) == YT_API_RETRY);
    CHECK(yt_api_parse_request_auth(502, "<html>bad gateway</html>", &ar) == YT_API_RETRY);
    CHECK_STR(ar.code, "HTTP_502");
    CHECK(yt_api_parse_request_auth(-1, NULL, &ar) == YT_API_RETRY);
    CHECK_STR(ar.code, "NETWORK");
    CHECK(yt_api_parse_request_auth(401, "{\"error\":\"INVALID_HARDWARE_SIGNATURE\"}", &ar) == YT_API_DENIED);

    /* --- heartbeat yanıtları --- */
    yt_api_heartbeat_result_t hr;
    CHECK(yt_api_parse_heartbeat(200,
        "{\"success\":true,\"command\":\"CONTINUE\",\"state\":\"PUMPING\",\"serverTime\":\"2026-11-26T13:10:36.123Z\"}",
        &hr) == YT_API_OK);
    CHECK(!hr.force_cutoff);
    CHECK(hr.server_time_ms == 1795698636123LL);
    CHECK(yt_api_parse_heartbeat(200,
        "{\"success\":true,\"command\":\"FORCE_CUTOFF\",\"reason\":\"MAX_LITERS_EXCEEDED\",\"serverTime\":\"2026-11-26T13:10:36Z\"}",
        &hr) == YT_API_OK);
    CHECK(hr.force_cutoff);
    CHECK_STR(hr.code, "MAX_LITERS_EXCEEDED");
    CHECK(yt_api_parse_heartbeat(200, "{\"success\":true,\"command\":\"DANCE\"}", &hr) == YT_API_OK);
    CHECK(hr.force_cutoff);                                   /* bilinmeyen komut → kes */
    CHECK(yt_api_parse_heartbeat(409,
        "{\"success\":false,\"error\":\"ConflictError\",\"details\":{\"error\":\"INVALID_STATE_TRANSITION\",\"from\":\"TIMED_OUT\"}}",
        &hr) == YT_API_REJECTED);
    CHECK_STR(hr.code, "INVALID_STATE_TRANSITION");
    CHECK(yt_api_parse_heartbeat(404, "{\"details\":{\"error\":\"SESSION_NOT_FOUND\"}}", &hr) == YT_API_REJECTED);
    CHECK(yt_api_parse_heartbeat(403, "{\"error\":\"DEVICE_BLOCKED\"}", &hr) == YT_API_REJECTED);
    CHECK(yt_api_parse_heartbeat(0, NULL, &hr) == YT_API_RETRY);
    CHECK(yt_api_parse_heartbeat(401, replay, &hr) == YT_API_RETRY);

    /* --- finalize yanıtları --- */
    yt_api_finalize_result_t fr;
    CHECK(yt_api_parse_finalize(200,
        "{\"success\":true,\"data\":{\"amount_liters\":\"30.00\",\"verification_status\":\"DOĞRULANDI\"}}",
        &fr) == YT_API_OK);
    CHECK_NEAR(fr.amount_liters, 30.0, 1e-9);
    CHECK_STR(fr.verification, "DOĞRULANDI");
    CHECK(yt_api_parse_finalize(200,
        "{\"success\":true,\"data\":{\"amount_liters\":12.5,\"verification_status\":\"DOĞRULAMA_BEKLIYOR\",\"alreadyExisted\":true}}",
        &fr) == YT_API_OK);
    CHECK_NEAR(fr.amount_liters, 12.5, 1e-9);
    /* 200 ama gövde kesik (yanıt tamponuna sığmadı): kayıt oluştu, yeniden GÖNDERİLMEZ. */
    CHECK(yt_api_parse_finalize(200, "{\"success\":true,\"data\":{\"id\":\"tx-1\",\"amount_li", &fr) == YT_API_OK);
    CHECK_STR(fr.verification, "");
    CHECK(yt_api_parse_finalize(409, "{\"details\":{\"error\":\"INVALID_STATE_TRANSITION\"}}", &fr) == YT_API_REJECTED);
    CHECK(yt_api_parse_finalize(404, "{\"details\":{\"error\":\"SESSION_NOT_FOUND\"}}", &fr) == YT_API_REJECTED);
    CHECK(yt_api_parse_finalize(503, NULL, &fr) == YT_API_RETRY);
    CHECK(yt_api_parse_finalize(-1, NULL, &fr) == YT_API_RETRY);
    /* İmza/bloke: kayıt kaybolmasın, saklanıp yeniden denenir. */
    CHECK(yt_api_parse_finalize(401, "{\"error\":\"INVALID_HARDWARE_SIGNATURE\"}", &fr) == YT_API_RETRY);
    CHECK(yt_api_parse_finalize(403, "{\"error\":\"DEVICE_BLOCKED\"}", &fr) == YT_API_RETRY);

    /* --- zaman --- */
    CHECK(yt_api_parse_http_date("Thu, 26 Nov 2026 13:10:36 GMT") == 1795698636000LL);
    CHECK(yt_api_parse_http_date("Sat, 01 Jan 2000 00:00:00 GMT") == 946684800000LL);
    CHECK(yt_api_parse_http_date("Thu, 29 Feb 2024 23:59:59 GMT") == 1709251199000LL);
    CHECK(yt_api_parse_http_date("Thu, 26 Foo 2026 13:10:36 GMT") == -1);
    CHECK(yt_api_parse_http_date("Thu, 26 Nov 2026 13:10:36 PST") == -1);
    CHECK(yt_api_parse_http_date("") == -1);
    CHECK(yt_api_parse_http_date(NULL) == -1);
    CHECK(yt_api_parse_iso8601("2026-11-26T13:10:36.123Z") == 1795698636123LL);
    CHECK(yt_api_parse_iso8601("2026-11-26T13:10:36Z") == 1795698636000LL);
    CHECK(yt_api_parse_iso8601("2026-11-26T13:10:36.5Z") == 1795698636500LL);
    CHECK(yt_api_parse_iso8601("2026-11-26T13:10:36+03:00") == -1);   /* yalnızca UTC */
    CHECK(yt_api_parse_iso8601("2026-13-26T13:10:36Z") == -1);

    char code[YT_API_CODE_MAX];
    yt_api_error_code("not json", code, sizeof code);
    CHECK_STR(code, "");
}
