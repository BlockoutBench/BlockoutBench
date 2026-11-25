#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN

#include <windows.h>

typedef int (WINAPI *PFN_MessageBoxW)(HWND, LPCWSTR, LPCWSTR, UINT);

static int append_str(wchar_t *dst, size_t *pos, size_t cap, const wchar_t *src) {
    while (*src) {
        if (*pos + 1 >= cap) return 0;
        dst[(*pos)++] = *src++;
    }
    dst[*pos] = L'\0';
    return 1;
}

static int append_char(wchar_t *dst, size_t *pos, size_t cap, wchar_t ch, size_t count) {
    for (size_t i = 0; i < count; i++) {
        if (*pos + 1 >= cap) return 0;
        dst[(*pos)++] = ch;
    }
    dst[*pos] = L'\0';
    return 1;
}

static int append_ulong(wchar_t *dst, size_t *pos, size_t cap, unsigned long val) {
    wchar_t tmp[32];
    size_t n = 0;
    if (val == 0) {
        return append_char(dst, pos, cap, L'0', 1);
    }
    while (val > 0 && n < 32) {
        tmp[n++] = (wchar_t)(L'0' + (val % 10));
        val /= 10;
    }
    while (n > 0) {
        if (!append_char(dst, pos, cap, tmp[--n], 1)) return 0;
    }
    return 1;
}

static int append_quoted_arg(wchar_t *dst, size_t *pos, size_t cap, const wchar_t *arg) {
    if (!arg || !arg[0]) {
        return append_str(dst, pos, cap, L"\"\"");
    }
    int needs_quotes = 0;
    for (const wchar_t *p = arg; *p; p++) {
        if (*p == L' ' || *p == L'\t' || *p == L'"') {
            needs_quotes = 1;
            break;
        }
    }
    if (!needs_quotes) {
        return append_str(dst, pos, cap, arg);
    }
    if (!append_char(dst, pos, cap, L'"', 1)) return 0;
    size_t backslashes = 0;
    for (const wchar_t *p = arg; *p; p++) {
        if (*p == L'\\') {
            backslashes++;
        } else if (*p == L'"') {
            if (!append_char(dst, pos, cap, L'\\', backslashes * 2 + 1)) return 0;
            if (!append_char(dst, pos, cap, L'"', 1)) return 0;
            backslashes = 0;
        } else {
            if (backslashes > 0) {
                if (!append_char(dst, pos, cap, L'\\', backslashes)) return 0;
                backslashes = 0;
            }
            if (!append_char(dst, pos, cap, *p, 1)) return 0;
        }
    }
    if (backslashes > 0) {
        if (!append_char(dst, pos, cap, L'\\', backslashes * 2)) return 0;
    }
    return append_char(dst, pos, cap, L'"', 1);
}

static const wchar_t *skip_program_name(const wchar_t *cmdLine) {
    const wchar_t *p = cmdLine ? cmdLine : L"";
    while (*p == L' ' || *p == L'\t') p++;
    if (*p == L'"') {
        p++;
        while (*p && *p != L'"') p++;
        if (*p == L'"') p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t') p++;
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

static int is_check_launcher_flag(const wchar_t *restArgs) {
    const wchar_t *flag = L"--check-launcher";
    size_t i = 0;
    if (!restArgs) return 0;
    while (flag[i]) {
        if (restArgs[i] != flag[i]) return 0;
        i++;
    }
    return restArgs[i] == L'\0' || restArgs[i] == L' ' || restArgs[i] == L'\t';
}

static int file_exists(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static int dir_exists(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static void show_error_box(const wchar_t *text) {
    HMODULE u32 = LoadLibraryW(L"user32.dll");
    if (!u32) return;
    PFN_MessageBoxW fn = (PFN_MessageBoxW)GetProcAddress(u32, "MessageBoxW");
    if (fn) {
        fn(NULL, text, L"关卡工作台", MB_OK | MB_ICONERROR);
    }
    FreeLibrary(u32);
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPWSTR lpCmdLine, int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nCmdShow;

    const size_t PATH_CAP = 4096;
    const size_t CMD_CAP = 32768;
    HANDLE heap = GetProcessHeap();
    wchar_t *rootDir = (wchar_t *)HeapAlloc(heap, HEAP_ZERO_MEMORY, PATH_CAP * sizeof(wchar_t));
    wchar_t *electronExe = (wchar_t *)HeapAlloc(heap, HEAP_ZERO_MEMORY, PATH_CAP * sizeof(wchar_t));
    wchar_t *desktopDir = (wchar_t *)HeapAlloc(heap, HEAP_ZERO_MEMORY, PATH_CAP * sizeof(wchar_t));
    wchar_t *cmdLine = (wchar_t *)HeapAlloc(heap, HEAP_ZERO_MEMORY, CMD_CAP * sizeof(wchar_t));

    if (!rootDir || !electronExe || !desktopDir || !cmdLine) {
        if (rootDir) HeapFree(heap, 0, rootDir);
        if (electronExe) HeapFree(heap, 0, electronExe);
        if (desktopDir) HeapFree(heap, 0, desktopDir);
        if (cmdLine) HeapFree(heap, 0, cmdLine);
        return 1;
    }

    DWORD len = GetModuleFileNameW(NULL, rootDir, (DWORD)PATH_CAP);
    if (len == 0 || len >= PATH_CAP) {
        show_error_box(L"无法获取启动器所在路径。");
        HeapFree(heap, 0, rootDir);
        HeapFree(heap, 0, electronExe);
        HeapFree(heap, 0, desktopDir);
        HeapFree(heap, 0, cmdLine);
        return 1;
    }

    for (DWORD i = len; i > 0; i--) {
        if (rootDir[i - 1] == L'\\' || rootDir[i - 1] == L'/') {
            rootDir[i - 1] = L'\0';
            break;
        }
    }

    SetCurrentDirectoryW(rootDir);

    size_t pos = 0;
    append_str(electronExe, &pos, PATH_CAP, rootDir);
    append_str(electronExe, &pos, PATH_CAP, L"\\desktop\\node_modules\\electron\\dist\\electron.exe");

    pos = 0;
    append_str(desktopDir, &pos, PATH_CAP, rootDir);
    append_str(desktopDir, &pos, PATH_CAP, L"\\desktop");

    const wchar_t *restArgs = skip_program_name(GetCommandLineW());
    if (is_check_launcher_flag(restArgs)) {
        int checkRc = (file_exists(electronExe) && dir_exists(desktopDir)) ? 0 : 2;
        HeapFree(heap, 0, rootDir);
        HeapFree(heap, 0, electronExe);
        HeapFree(heap, 0, desktopDir);
        HeapFree(heap, 0, cmdLine);
        return checkRc;
    }

    if (!file_exists(electronExe)) {
        show_error_box(L"未找到 desktop\\node_modules\\electron\\dist\\electron.exe，请先在 desktop 目录执行 npm install。");
        HeapFree(heap, 0, rootDir);
        HeapFree(heap, 0, electronExe);
        HeapFree(heap, 0, desktopDir);
        HeapFree(heap, 0, cmdLine);
        return 1;
    }

    if (!dir_exists(desktopDir)) {
        show_error_box(L"未找到 desktop 应用目录。");
        HeapFree(heap, 0, rootDir);
        HeapFree(heap, 0, electronExe);
        HeapFree(heap, 0, desktopDir);
        HeapFree(heap, 0, cmdLine);
        return 1;
    }

    size_t cmdPos = 0;
    int ok = append_quoted_arg(cmdLine, &cmdPos, CMD_CAP, electronExe) &&
             append_char(cmdLine, &cmdPos, CMD_CAP, L' ', 1) &&
             append_quoted_arg(cmdLine, &cmdPos, CMD_CAP, desktopDir);
    if (ok && restArgs && restArgs[0] != L'\0') {
        ok = append_char(cmdLine, &cmdPos, CMD_CAP, L' ', 1) &&
             append_str(cmdLine, &cmdPos, CMD_CAP, restArgs);
    }

    if (!ok) {
        show_error_box(L"启动参数过长，无法启动。");
        HeapFree(heap, 0, rootDir);
        HeapFree(heap, 0, electronExe);
        HeapFree(heap, 0, desktopDir);
        HeapFree(heap, 0, cmdLine);
        return 1;
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);

    int exitCode = 0;
    if (!CreateProcessW(electronExe, cmdLine, NULL, NULL, FALSE, 0, NULL, rootDir, &si, &pi)) {
        DWORD err = GetLastError();
        wchar_t msg[256];
        size_t mpos = 0;
        msg[0] = L'\0';
        append_str(msg, &mpos, 256, L"启动关卡工作台失败（错误码 ");
        append_ulong(msg, &mpos, 256, (unsigned long)err);
        append_str(msg, &mpos, 256, L"）。");
        show_error_box(msg);
        exitCode = 1;
    } else {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

    HeapFree(heap, 0, rootDir);
    HeapFree(heap, 0, electronExe);
    HeapFree(heap, 0, desktopDir);
    HeapFree(heap, 0, cmdLine);
    return exitCode;
}
