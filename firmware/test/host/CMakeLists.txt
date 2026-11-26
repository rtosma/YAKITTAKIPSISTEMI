# Firmware çekirdeğinin (components/yt_core) bilgisayarda birim testleri.
#
# mbedTLS ve cJSON: ESP-IDF içindeyse (CI: espressif/idf imajı, IDF_PATH tanımlı) cihazdaki
# AYNI kaynaklar host için derlenir; değilse sistemdeki libmbedcrypto / libcjson aranır.
#
#   cmake -S firmware/test/host -B build/fw-host && cmake --build build/fw-host && ctest --test-dir build/fw-host
cmake_minimum_required(VERSION 3.16)
project(yt_core_host_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(DEFINED ENV{IDF_PATH} AND EXISTS "$ENV{IDF_PATH}/components/mbedtls/mbedtls/CMakeLists.txt")
  set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
  set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
  add_subdirectory($ENV{IDF_PATH}/components/mbedtls/mbedtls mbedtls EXCLUDE_FROM_ALL)
  set(YT_MBEDCRYPTO mbedcrypto)
  message(STATUS "mbedTLS: ESP-IDF kaynağı ($ENV{IDF_PATH})")
else()
  find_library(YT_MBEDCRYPTO mbedcrypto REQUIRED)
  message(STATUS "mbedTLS: sistem kütüphanesi ${YT_MBEDCRYPTO}")
endif()

if(DEFINED ENV{IDF_PATH} AND EXISTS "$ENV{IDF_PATH}/components/json/cJSON/cJSON.c")
  add_library(yt_cjson STATIC $ENV{IDF_PATH}/components/json/cJSON/cJSON.c)
  target_include_directories(yt_cjson PUBLIC $ENV{IDF_PATH}/components/json/cJSON)
  set(YT_CJSON yt_cjson)
else()
  find_path(YT_CJSON_INC cJSON.h PATH_SUFFIXES cjson REQUIRED)
  find_library(YT_CJSON cjson REQUIRED)
  include_directories(${YT_CJSON_INC})
endif()

set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../../components/yt_core)

add_executable(yt_core_tests
  test_main.c
  test_hmac.c
  test_flow.c
  test_session.c
  test_failopen.c
  test_persist.c
  test_api.c
  ${CORE}/yt_hmac.c
  ${CORE}/yt_flow.c
  ${CORE}/yt_session.c
  ${CORE}/yt_failopen.c
  ${CORE}/yt_persist.c
  ${CORE}/yt_api.c
)
target_include_directories(yt_core_tests PRIVATE ${CORE}/include)
target_compile_options(yt_core_tests PRIVATE -Wall -Wextra -Werror -Wno-unused-parameter)
target_link_libraries(yt_core_tests PRIVATE ${YT_MBEDCRYPTO} ${YT_CJSON} m)

enable_testing()
add_test(NAME yt_core_tests COMMAND yt_core_tests)
