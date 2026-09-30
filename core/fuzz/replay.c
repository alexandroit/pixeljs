/* Runs a fuzz target over corpus files without libFuzzer, so the harnesses
 * are compiled and exercised by every native (and sanitizer) test run. */
#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

static int replay_file(const char *path) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return 1;
    }
    static uint8_t buffer[2 * 1024 * 1024];
    const size_t size = fread(buffer, 1, sizeof(buffer), file);
    const int truncated = !feof(file);
    fclose(file);
    if (truncated) {
        fprintf(stderr, "Corpus file too large: %s\n", path);
        return 1;
    }
    (void)LLVMFuzzerTestOneInput(buffer, size);
    return 0;
}

int main(int argc, char **argv) {
    size_t inputs = 0;
    for (int argument = 1; argument < argc; ++argument) {
        DIR *directory = opendir(argv[argument]);
        if (directory == NULL) {
            fprintf(stderr, "Cannot open corpus directory %s\n", argv[argument]);
            return EXIT_FAILURE;
        }
        for (struct dirent *entry = readdir(directory); entry != NULL;
             entry = readdir(directory)) {
            if (entry->d_name[0] == '.') {
                continue;
            }
            char path[4096];
            if (snprintf(path, sizeof(path), "%s/%s", argv[argument], entry->d_name) >=
                    (int)sizeof(path) ||
                replay_file(path) != 0) {
                closedir(directory);
                return EXIT_FAILURE;
            }
            ++inputs;
        }
        closedir(directory);
    }
    printf("Replayed %zu corpus inputs.\n", inputs);
    return inputs > 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
