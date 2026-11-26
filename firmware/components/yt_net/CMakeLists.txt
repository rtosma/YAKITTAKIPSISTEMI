idf_component_register(
  SRCS "yt_net.c" "yt_http.c"
  INCLUDE_DIRS "include"
  REQUIRES yt_core esp_netif esp_event esp_wifi esp_eth esp_http_client mbedtls
  PRIV_REQUIRES esp_timer
)
