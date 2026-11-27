idf_component_register(
  SRCS "yt_mqtt.c"
  INCLUDE_DIRS "include"
  REQUIRES yt_core mqtt mbedtls esp_timer
)
