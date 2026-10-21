# Переносимая сборка ggml (движок Whisper из whisper-rs-sys) под Windows.
#
# 21.10.2026: INmeet 0.4.11 на Windows падал при старте записи с 0xc000001d (недопустимая инструкция) на
# процессорах без AVX-512 (Ryzen 5 1600 у Васи). Причина: ggml под MSVC по умолчанию собирается «под машину
# сборки» (GGML_NATIVE=ON -> FindSIMD.cmake), а у облачной машины GitHub есть AVX-512 -> /arch:AVX512 на весь
# ggml, включая Vulkan-бэкенд (падало в нём: vcvtusi2ss). whisper-rs-sys 0.11 не пробрасывает GGML_*, но
# пробрасывает CMAKE_* - этот файл подключается через CMAKE_PROJECT_INCLUDE_BEFORE (шаг в build.yml) и до
# объявления опций ggml ставит переносимый набор: AVX2 + FMA + F16C (Haswell / Zen 1 и новее).
set(GGML_NATIVE OFF CACHE BOOL "ggml: переносимая сборка, без инструкций машины сборки" FORCE)
set(GGML_AVX512 OFF CACHE BOOL "ggml: без AVX-512" FORCE)
