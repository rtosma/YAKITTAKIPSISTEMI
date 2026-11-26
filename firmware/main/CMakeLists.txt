idf_component_register(
  SRCS "app_main.c"
  INCLUDE_DIRS "."
  REQUIRES yt_core yt_relay yt_pcnt yt_store esp_app_format esp_timer esp_driver_gpio
)
