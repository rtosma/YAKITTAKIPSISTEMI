#include "app_link.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "yt_api.h"

/* Tek istek, tek tampon: denetim döngüsü isteği yazıp kuyruğa koyar, görev yanıtı yazıp
 * "bitti" kuyruğuna koyar. Kuyruklar sıralamayı (bellek görünürlüğünü) garanti eder. */
static char s_path[48];
static char s_body[YT_API_BODY_MAX];
static yt_http_resp_t s_resp;
static QueueHandle_t s_req_q;
static QueueHandle_t s_done_q;
static volatile bool s_busy;

static void link_task(void *arg)
{
    link_kind_t kind;
    for (;;) {
        if (xQueueReceive(s_req_q, &kind, portMAX_DELAY) != pdTRUE) continue;
        yt_http_signed(s_path, s_body, &s_resp);
        xQueueSend(s_done_q, &kind, portMAX_DELAY);
    }
}

void app_link_start(void)
{
    s_req_q = xQueueCreate(1, sizeof(link_kind_t));
    s_done_q = xQueueCreate(1, sizeof(link_kind_t));
    /* TLS el sıkışması için geniş yığın. Denetim döngüsünden düşük öncelik. */
    xTaskCreate(link_task, "yt_link", 10240, NULL, tskIDLE_PRIORITY + 3, NULL);
}

bool app_link_busy(void)
{
    return s_busy;
}

bool app_link_submit(link_kind_t kind, const char *path, const char *body)
{
    if (s_busy || !s_req_q) return false;
    strlcpy(s_path, path, sizeof s_path);
    strlcpy(s_body, body ? body : "", sizeof s_body);
    s_busy = true;
    xQueueSend(s_req_q, &kind, 0);
    return true;
}

bool app_link_poll(link_kind_t *kind, const yt_http_resp_t **resp)
{
    if (!s_done_q || xQueueReceive(s_done_q, kind, 0) != pdTRUE) return false;
    *resp = &s_resp;
    return true;
}

void app_link_release(void)
{
    s_busy = false;
}
