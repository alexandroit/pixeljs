cmake_minimum_required(VERSION 3.24)
project(PixelJS VERSION 0.0.4 LANGUAGES C)

option(PX_SANITIZE "Enable native AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(PX_BUILD_FUZZER "Build Clang libFuzzer command decoder target" OFF)
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(pixeljs_options INTERFACE)
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(pixeljs_options INTERFACE
        -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow
        -Wstrict-prototypes -Wmissing-prototypes -Wformat=2 -Wundef -Wvla -Werror)
endif()
if(PX_SANITIZE)
    if(EMSCRIPTEN OR NOT CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
        message(FATAL_ERROR "PX_SANITIZE requires native Clang or GCC")
    endif()
    target_compile_options(pixeljs_options INTERFACE
        -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all)
    target_link_options(pixeljs_options INTERFACE -fsanitize=address,undefined -fno-sanitize-recover=all)
endif()

add_library(pixeljs STATIC
    core/src/context/context.c
    core/src/memory/memory.c
    core/src/assets/image.c
    core/src/graphics/commands.c
    core/src/graphics/raster.c
    core/src/audio/dsp.c)
target_include_directories(pixeljs PUBLIC core/include PRIVATE core/src)
target_link_libraries(pixeljs PUBLIC pixeljs_options)
# The audio DSP uses <math.h>; glibc keeps it in libm, which Apple and
# Emscripten link implicitly.
if(UNIX AND NOT APPLE AND NOT EMSCRIPTEN)
    target_link_libraries(pixeljs PUBLIC m)
endif()

if(EMSCRIPTEN)
    add_executable(pixeljs_wasm bridge/wasm/exports.c)
    target_link_libraries(pixeljs_wasm PRIVATE pixeljs)
    target_include_directories(pixeljs_wasm PRIVATE bridge/wasm)
    set_target_properties(pixeljs_wasm PROPERTIES
        OUTPUT_NAME engine SUFFIX .mjs
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/wasm")
    target_compile_options(pixeljs PRIVATE -O2)
    target_link_options(pixeljs_wasm PRIVATE
        -O2 --no-entry
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=1048576
        -sFILESYSTEM=0 -sNO_EXIT_RUNTIME=1 -sMALLOC=emmalloc -sABORTING_MALLOC=0
        -sDYNAMIC_EXECUTION=0 -sSTACK_OVERFLOW_CHECK=2
        "-sINCOMING_MODULE_JS_API=['wasmBinary','printErr']"
        "-sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_SOURCE_DIR}/bridge/wasm/exports.json"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']")

    add_executable(pixeljs_audio_wasm bridge/audio/exports.c)
    target_link_libraries(pixeljs_audio_wasm PRIVATE pixeljs)
    target_include_directories(pixeljs_audio_wasm PRIVATE bridge/audio core/include)
    set_target_properties(pixeljs_audio_wasm PROPERTIES
        OUTPUT_NAME audio SUFFIX .mjs
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/wasm")
    target_link_options(pixeljs_audio_wasm PRIVATE
        -O2 --no-entry
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker
        -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=65536 -sSTACK_SIZE=32768
        -sFILESYSTEM=0 -sNO_EXIT_RUNTIME=1 -sMALLOC=emmalloc -sABORTING_MALLOC=0
        -sDYNAMIC_EXECUTION=0 -sSTACK_OVERFLOW_CHECK=0
        "-sINCOMING_MODULE_JS_API=['wasmBinary','printErr']"
        "-sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_SOURCE_DIR}/bridge/audio/exports.json"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPF32']")
else()
    include(CTest)
    if(BUILD_TESTING)
        add_executable(pixeljs_core_tests core/tests/test_core.c)
        target_include_directories(pixeljs_core_tests PRIVATE core/src)
        target_link_libraries(pixeljs_core_tests PRIVATE pixeljs)
        add_test(NAME core_contracts COMMAND pixeljs_core_tests)

        add_executable(pixeljs_shapes_tests core/tests/test_shapes.c)
        target_include_directories(pixeljs_shapes_tests PRIVATE core/src core/src/graphics)
        target_link_libraries(pixeljs_shapes_tests PRIVATE pixeljs)
        add_test(NAME shape_contracts COMMAND pixeljs_shapes_tests)

        add_executable(pixeljs_bridge_tests core/tests/test_bridge.c bridge/wasm/exports.c)
        target_include_directories(pixeljs_bridge_tests PRIVATE bridge/wasm)
        target_link_libraries(pixeljs_bridge_tests PRIVATE pixeljs)
        add_test(NAME bridge_contracts COMMAND pixeljs_bridge_tests)

        add_executable(pixeljs_music_tests core/tests/test_music.c)
        target_include_directories(pixeljs_music_tests PRIVATE core/include)
        target_link_libraries(pixeljs_music_tests PRIVATE pixeljs)
        add_test(NAME music_contracts COMMAND pixeljs_music_tests)

        add_executable(pixeljs_audio_tests core/tests/test_audio.c)
        target_include_directories(pixeljs_audio_tests PRIVATE core/include)
        target_link_libraries(pixeljs_audio_tests PRIVATE pixeljs)
        add_test(NAME audio_contracts COMMAND pixeljs_audio_tests)

        add_library(pixeljs_header_check OBJECT core/tests/header_core.c core/tests/header_bridge.c)
        target_include_directories(pixeljs_header_check PRIVATE core/include bridge/wasm)
        target_link_libraries(pixeljs_header_check PRIVATE pixeljs_options)

        # Replay the fuzz harnesses over their corpus in every native/sanitizer run.
        foreach(fuzz_target commands resources audio)
            add_executable(pixeljs_fuzz_replay_${fuzz_target}
                core/fuzz/${fuzz_target}.c core/fuzz/replay.c)
            target_link_libraries(pixeljs_fuzz_replay_${fuzz_target} PRIVATE pixeljs)
            add_test(NAME fuzz_replay_${fuzz_target}
                COMMAND pixeljs_fuzz_replay_${fuzz_target}
                    ${CMAKE_CURRENT_SOURCE_DIR}/core/fuzz/corpus/${fuzz_target})
        endforeach()
    endif()
    if(PX_BUILD_FUZZER)
        if(NOT CMAKE_C_COMPILER_ID MATCHES "Clang")
            message(FATAL_ERROR "PX_BUILD_FUZZER requires Clang libFuzzer")
        endif()
        target_compile_options(pixeljs PRIVATE -fsanitize=fuzzer-no-link,address,undefined)
        foreach(fuzz_target commands resources audio)
            add_executable(pixeljs_fuzz_${fuzz_target} core/fuzz/${fuzz_target}.c)
            target_link_libraries(pixeljs_fuzz_${fuzz_target} PRIVATE pixeljs)
            target_compile_options(pixeljs_fuzz_${fuzz_target} PRIVATE -fsanitize=fuzzer,address,undefined)
            target_link_options(pixeljs_fuzz_${fuzz_target} PRIVATE -fsanitize=fuzzer,address,undefined)
        endforeach()
    endif()
endif()
