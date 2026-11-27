idf_component_register(
  SRCS "yt_reader.c"
  INCLUDE_DIRS "include"
  REQUIRES yt_core esp_driver_i2c
)
