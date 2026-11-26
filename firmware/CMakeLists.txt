# Yakıt Takip — ESP32 pompa kontrol ünitesi firmware'i (FW-1300).
# Sürüm (PROJECT_VER) ESP-IDF tarafından `git describe` ile otomatik gömülür ve
# açılış log'unda basılır (FW-1301 AC).
cmake_minimum_required(VERSION 3.16)
# CI/sürüm betiği sürümü açıkça verebilir (git describe container'da "dubious ownership"
# ile düşebilir); verilmezse ESP-IDF git describe'ı kendisi dener.
if(DEFINED ENV{YT_FW_VERSION} AND NOT "$ENV{YT_FW_VERSION}" STREQUAL "")
  set(PROJECT_VER "$ENV{YT_FW_VERSION}")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(yakittakip_pump)
