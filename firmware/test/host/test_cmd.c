#include "yt_cmd.h"
#include "yt_test.h"

#define PARSE(js, c) yt_cmd_parse((js), strlen(js), (c))

void test_cmd(void)
{
    yt_cmd_t c;

    /* FORCE_CUTOFF — sunucunun iki yolu: heartbeat zaman aşımı (kimliksiz) ve IOT-305 (commandId'li). */
    CHECK(PARSE("{\"command\":\"FORCE_CUTOFF\",\"reason\":\"HEARTBEAT_TIMEOUT\",\"sessionId\":\"dsess-1\","
                "\"issuedAt\":\"2026-11-26T13:10:36.000Z\"}", &c) == YT_CMD_FORCE_CUTOFF);
    CHECK_STR(c.reason, "HEARTBEAT_TIMEOUT");
    CHECK_STR(c.session_id, "dsess-1");
    CHECK_STR(c.command_id, "");
    CHECK(PARSE("{\"command\":\"FORCE_CUTOFF\",\"reason\":\"UNAUTHORIZED_FLOW\","
                "\"commandId\":\"3f2b8c1e-0d4a-4b7e-9c61-1a2b3c4d5e6f\"}", &c) == YT_CMD_FORCE_CUTOFF);
    CHECK_STR(c.command_id, "3f2b8c1e-0d4a-4b7e-9c61-1a2b3c4d5e6f");
    /* Kaçış gerektiren kimlik kabul edilmez (ack gövdesine kaçışsız yazılır). */
    CHECK(PARSE("{\"command\":\"FORCE_CUTOFF\",\"commandId\":\"a\\\"b\"}", &c) == YT_CMD_FORCE_CUTOFF);
    CHECK_STR(c.command_id, "");

    /* TIME_SYNC */
    CHECK(PARSE("{\"command\":\"TIME_SYNC\",\"serverTime\":\"2026-11-26T13:10:36.123Z\",\"driftMs\":7000}", &c) ==
          YT_CMD_TIME_SYNC);
    CHECK(c.server_time_ms == 1795698636123LL);
    CHECK(PARSE("{\"command\":\"TIME_SYNC\"}", &c) == YT_CMD_INVALID);

    /* SET_K_FACTOR (FUEL-404.1) */
    CHECK(PARSE("{\"command\":\"SET_K_FACTOR\",\"commandId\":\"cal-17\",\"newKFactor\":459.25}", &c) ==
          YT_CMD_SET_K_FACTOR);
    CHECK_STR(c.command_id, "cal-17");
    CHECK_NEAR(c.k_factor, 459.25, 1e-12);
    /* Sunucunun GERÇEK yükü: NUMERIC → dize (QEMU uçtan uca testi yakaladı). */
    CHECK(PARSE("{\"command\":\"SET_K_FACTOR\",\"commandId\":\"cal-18\",\"newKFactor\":\"459.0000\","
                "\"issuedAt\":\"2026-11-27T11:30:00.000Z\"}", &c) == YT_CMD_SET_K_FACTOR);
    CHECK_NEAR(c.k_factor, 459.0, 1e-12);
    CHECK(PARSE("{\"command\":\"SET_K_FACTOR\",\"commandId\":\"c\",\"newKFactor\":\"459abc\"}", &c) == YT_CMD_SET_K_FACTOR);
    CHECK(isnan(c.k_factor));
    CHECK(PARSE("{\"command\":\"SET_K_FACTOR\",\"newKFactor\":459}", &c) == YT_CMD_INVALID);   /* yanıtlanamaz */
    CHECK(PARSE("{\"command\":\"SET_K_FACTOR\",\"commandId\":\"c\",\"newKFactor\":\"x\"}", &c) == YT_CMD_SET_K_FACTOR);
    CHECK(isnan(c.k_factor));                                   /* değer kararı uygulayana: NACK */

    CHECK(PARSE("{\"command\":\"REBOOT\"}", &c) == YT_CMD_UNKNOWN);
    CHECK_STR(c.name, "REBOOT");
    CHECK(PARSE("{\"cmd\":\"FORCE_CUTOFF\"}", &c) == YT_CMD_INVALID);
    CHECK(PARSE("FORCE_CUTOFF", &c) == YT_CMD_INVALID);
    CHECK(yt_cmd_parse(NULL, 0, &c) == YT_CMD_INVALID);
    /* Uzunluk sınırına uyulur (MQTT yükü NUL ile bitmez). */
    const char *two = "{\"command\":\"TIME_SYNC\",\"serverTime\":\"2026-11-26T13:10:36Z\"}GARBAGE";
    CHECK(yt_cmd_parse(two, strlen(two) - 7, &c) == YT_CMD_TIME_SYNC);

    /* --- gövdeler --- */
    char b[160];
    yt_cmd_ack_body(b, sizeof b, "cmd-1", true);
    CHECK_STR(b, "{\"commandId\":\"cmd-1\",\"status\":\"ACK\"}");
    yt_cmd_ack_body(b, sizeof b, "cmd-1", false);
    CHECK_STR(b, "{\"commandId\":\"cmd-1\",\"status\":\"NACK\"}");
    CHECK(yt_cmd_ack_body(b, sizeof b, "", true) == 0);
    CHECK(yt_cmd_ack_body(b, 10, "cmd-1", true) == 0);

    yt_cmd_calibration_ack_body(b, sizeof b, "cal-17", true, 459.25, NULL);
    CHECK_STR(b, "{\"commandId\":\"cal-17\",\"status\":\"ACK\",\"appliedKFactor\":459.2500}");
    yt_cmd_calibration_ack_body(b, sizeof b, "cal-17", false, 0, "DISPENSE_IN_PROGRESS");
    CHECK_STR(b, "{\"commandId\":\"cal-17\",\"status\":\"NACK\",\"reason\":\"DISPENSE_IN_PROGRESS\"}");
    yt_cmd_calibration_ack_body(b, sizeof b, "cal-17", false, 0, "bad \"reason\"");
    CHECK_STR(b, "{\"commandId\":\"cal-17\",\"status\":\"NACK\",\"reason\":\"REJECTED\"}");
    CHECK(yt_cmd_calibration_ack_body(b, sizeof b, "cal-17", true, NAN, NULL) == 0);   /* ACK'te değer zorunlu */

    /* --- calibration-ack yanıtı --- */
    CHECK(yt_cmd_parse_calibration_ack(200, "{\"success\":true}") == YT_CAL_ACK_DONE);
    CHECK(yt_cmd_parse_calibration_ack(404, "{\"details\":{\"error\":\"CALIBRATION_COMMAND_NOT_FOUND\"}}") ==
          YT_CAL_ACK_EXPIRED);
    CHECK(yt_cmd_parse_calibration_ack(400, "{}") == YT_CAL_ACK_REJECTED);
    CHECK(yt_cmd_parse_calibration_ack(-1, NULL) == YT_CAL_ACK_RETRY);
    CHECK(yt_cmd_parse_calibration_ack(503, NULL) == YT_CAL_ACK_RETRY);
    CHECK(yt_cmd_parse_calibration_ack(401, "{\"error\":\"REPLAY_ATTACK_DETECTED\"}") == YT_CAL_ACK_RETRY);
    CHECK(yt_cmd_parse_calibration_ack(401, "{\"error\":\"INVALID_HARDWARE_SIGNATURE\"}") == YT_CAL_ACK_REJECTED);

    /* --- topic'ler --- */
    char t[YT_TOPIC_MAX];
    yt_topic_command(t, sizeof t, "ESP32-PUMP-01");
    CHECK_STR(t, "command/v1/ESP32-PUMP-01");
    yt_topic_command_ack(t, sizeof t, "ESP32-PUMP-01");
    CHECK_STR(t, "command/v1/ESP32-PUMP-01/ack");
    yt_topic_status(t, sizeof t, "comp-camsa", "gebze", "pump", "ESP32-PUMP-01");
    CHECK_STR(t, "telemetry/v1/comp-camsa/gebze/pump/ESP32-PUMP-01/status");
    CHECK(yt_topic_status(t, sizeof t, "comp/x", "gebze", "pump", "D") == 0);   /* topic enjeksiyonu yok */
    CHECK(yt_topic_command(t, sizeof t, "D#") == 0);
    CHECK(yt_topic_command(t, sizeof t, "") == 0);
}
