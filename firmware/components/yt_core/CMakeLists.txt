# Donanımdan bağımsız çekirdek (yalnızca mbedTLS). Bilgisayarda test: firmware/test/host
idf_component_register(
  SRCS "yt_hmac.c" "yt_flow.c" "yt_session.c" "yt_failopen.c" "yt_persist.c"
  INCLUDE_DIRS "include"
  REQUIRES mbedtls
)
