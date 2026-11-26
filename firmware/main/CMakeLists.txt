idf_component_register(
  SRCS "app_main.c" "app_link.c" "app_console.c"
  INCLUDE_DIRS "."
  REQUIRES yt_core yt_relay yt_pcnt yt_store yt_net esp_app_format esp_timer esp_driver_gpio esp_driver_uart
)
