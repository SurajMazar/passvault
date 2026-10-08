/*
 * PassVault.app/Contents/MacOS/PassVault
 *
 * Tiny launcher that replaces itself (execv) with the Neutralinojs binary
 * (Contents/MacOS/passvault-shell) and points it at Contents/Resources, where
 * resources.neu (bundled UI + neutralino.config.json) lives:
 *
 *   passvault-shell --path=<bundle>/Contents/Resources
 *
 * Neutralino otherwise resolves resources.neu next to its own executable,
 * which would put data files into Contents/MacOS (bad for code signing).
 *
 * Arguments passed to the app (e.g. `open PassVault.app --args …`) are NOT
 * forwarded: Neutralino accepts config overrides on the command line
 * (--url, --enable-inspector, …) and the bundled configuration must win.
 * The one exception is the exact flag `--background` (set by the "Open at
 * login" LaunchAgent: start in the menu bar), which is not a Neutralino
 * option and only reaches the UI through NL_ARGS.
 */
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int background = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--background") == 0) background = 1;
    }
    char exe[PATH_MAX];
    uint32_t size = sizeof(exe);
    if (_NSGetExecutablePath(exe, &size) != 0) {
        fprintf(stderr, "PassVault: executable path too long\n");
        return 111;
    }
    char real[PATH_MAX];
    if (realpath(exe, real) == NULL) {
        perror("PassVault: realpath");
        return 112;
    }
    char macosBuf[PATH_MAX];
    strncpy(macosBuf, real, sizeof(macosBuf) - 1);
    macosBuf[sizeof(macosBuf) - 1] = '\0';
    const char *macos = dirname(macosBuf); /* …/Contents/MacOS */

    char shell[PATH_MAX];
    char resRaw[PATH_MAX];
    char res[PATH_MAX];
    char pathArg[PATH_MAX + 16];
    if (snprintf(shell, sizeof(shell), "%s/passvault-shell", macos) >= (int)sizeof(shell) ||
        snprintf(resRaw, sizeof(resRaw), "%s/../Resources", macos) >= (int)sizeof(resRaw)) {
        fprintf(stderr, "PassVault: path too long\n");
        return 113;
    }
    if (realpath(resRaw, res) == NULL) {
        perror("PassVault: Resources");
        return 114;
    }
    snprintf(pathArg, sizeof(pathArg), "--path=%s", res);

    char bgArg[] = "--background";
    char *args[] = {shell, pathArg, background ? bgArg : NULL, NULL};
    execv(shell, args);
    fprintf(stderr, "PassVault: cannot start %s: %s\n", shell, strerror(errno));
    return 115;
}
