// Native Win32 ConPTY (Windows Pseudo Console) bridge for Trace FPGA Workbench Integrated Terminal.
// Spawns an interactive shell (pwsh.exe, powershell.exe, cmd.exe) attached to a real Windows Pseudo Console
// so PSReadLine, interactive REPLs (python, node), and full-screen TUI apps (opencode, git, vim) work natively.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <shellapi.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static HPCON  g_hPC = nullptr;
static HANDLE g_hostInRead = INVALID_HANDLE_VALUE;
static HANDLE g_hostOutWrite = INVALID_HANDLE_VALUE;
static HANDLE g_ptyInWrite = INVALID_HANDLE_VALUE;
static HANDLE g_ptyOutRead = INVALID_HANDLE_VALUE;
static HANDLE g_childProc  = INVALID_HANDLE_VALUE;

static DWORD WINAPI OutputPumpThread(LPVOID) {
    HANDLE hStdOut = g_hostOutWrite;
    char buf[8192];
    DWORD bytesRead = 0;
    while (hStdOut != INVALID_HANDLE_VALUE &&
           g_ptyOutRead != INVALID_HANDLE_VALUE &&
           ReadFile(g_ptyOutRead, buf, sizeof(buf), &bytesRead, nullptr) &&
           bytesRead > 0) {
        DWORD totalWritten = 0;
        while (totalWritten < bytesRead) {
            DWORD written = 0;
            if (!WriteFile(hStdOut, buf + totalWritten, bytesRead - totalWritten, &written, nullptr) || written == 0) {
                return 0;
            }
            totalWritten += written;
        }
    }
    return 0;
}

static void HandleInputChunk(const char* data, size_t len) {
    // Intercept private OSC resize control sequence: \x1b]9999;R;<cols>;<rows>\x07
    static const char* kPrefix = "\x1b]9999;R;";
    static const size_t kPrefixLen = 9;
    size_t pos = 0;
    while (pos < len) {
        const void* found = nullptr;
        for (size_t i = pos; i + kPrefixLen <= len; ++i) {
            if (std::memcmp(data + i, kPrefix, kPrefixLen) == 0) {
                found = data + i;
                break;
            }
        }
        if (!found) {
            DWORD toWrite = (DWORD)(len - pos);
            DWORD written = 0;
            WriteFile(g_ptyInWrite, data + pos, toWrite, &written, nullptr);
            break;
        }
        size_t matchIdx = (const char*)found - data;
        if (matchIdx > pos) {
            DWORD toWrite = (DWORD)(matchIdx - pos);
            DWORD written = 0;
            WriteFile(g_ptyInWrite, data + pos, toWrite, &written, nullptr);
        }
        size_t endBell = matchIdx + kPrefixLen;
        while (endBell < len && data[endBell] != '\x07') ++endBell;
        if (endBell < len && data[endBell] == '\x07') {
            std::string payload(data + matchIdx + kPrefixLen, endBell - (matchIdx + kPrefixLen));
            int cols = 0, rows = 0;
            if (std::sscanf(payload.c_str(), "%d;%d", &cols, &rows) == 2 && cols > 1 && rows > 1 && g_hPC) {
                COORD sz{ (SHORT)cols, (SHORT)rows };
                ResizePseudoConsole(g_hPC, sz);
            }
            pos = endBell + 1;
        } else {
            DWORD toWrite = (DWORD)(len - matchIdx);
            DWORD written = 0;
            WriteFile(g_ptyInWrite, data + matchIdx, toWrite, &written, nullptr);
            break;
        }
    }
}

static DWORD WINAPI InputPumpThread(LPVOID) {
    HANDLE hStdIn = g_hostInRead;
    char buf[4096];
    DWORD bytesRead = 0;
    while (hStdIn != INVALID_HANDLE_VALUE &&
           ReadFile(hStdIn, buf, sizeof(buf), &bytesRead, nullptr) &&
           bytesRead > 0) {
        HandleInputChunk(buf, bytesRead);
    }
    // Stdin closed by parent Node server -> terminate child & exit
    if (g_childProc != INVALID_HANDLE_VALUE) {
        TerminateProcess(g_childProc, 0);
    }
    if (g_hPC) {
        ClosePseudoConsole(g_hPC);
        g_hPC = nullptr;
    }
    ExitProcess(0);
    return 0;
}

int wmain(int argc, wchar_t* argv[]) {
    if (argc < 4) return 1;
    // Detach any console and isolate Node's stdio pipes into non-inheritable handles so CreatePseudoConsole / child shells never read our stdin pipe
    FreeConsole();
    HANDLE origIn  = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE origOut = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE me = GetCurrentProcess();
    if (origIn != INVALID_HANDLE_VALUE && origIn != nullptr) {
        DuplicateHandle(me, origIn, me, &g_hostInRead, 0, FALSE, DUPLICATE_SAME_ACCESS);
    }
    if (origOut != INVALID_HANDLE_VALUE && origOut != nullptr) {
        DuplicateHandle(me, origOut, me, &g_hostOutWrite, 0, FALSE, DUPLICATE_SAME_ACCESS);
    }
    SetStdHandle(STD_INPUT_HANDLE, INVALID_HANDLE_VALUE);
    SetStdHandle(STD_OUTPUT_HANDLE, INVALID_HANDLE_VALUE);
    SetStdHandle(STD_ERROR_HANDLE, INVALID_HANDLE_VALUE);
    if (origIn != INVALID_HANDLE_VALUE && origIn != nullptr) CloseHandle(origIn);
    if (origOut != INVALID_HANDLE_VALUE && origOut != nullptr && origOut != origIn) CloseHandle(origOut);

    int cols = _wtoi(argv[1]);
    int rows = _wtoi(argv[2]);
    if (cols < 10) cols = 120;
    if (rows < 4)  rows = 30;

    std::wstring cmdLine;
    for (int i = 3; i < argc; ++i) {
        if (i > 3) cmdLine += L" ";
        std::wstring a = argv[i];
        if (a.find(L' ') != std::wstring::npos && a.front() != L'"') {
            cmdLine += L"\"" + a + L"\"";
        } else {
            cmdLine += a;
        }
    }

    HANDLE ptyInRead = INVALID_HANDLE_VALUE;
    HANDLE ptyOutWrite = INVALID_HANDLE_VALUE;
    if (!CreatePipe(&ptyInRead, &g_ptyInWrite, nullptr, 0)) return 2;
    if (!CreatePipe(&g_ptyOutRead, &ptyOutWrite, nullptr, 0)) return 2;

    COORD consoleSize{ (SHORT)cols, (SHORT)rows };
    HRESULT hr = CreatePseudoConsole(consoleSize, ptyInRead, ptyOutWrite, 0, &g_hPC);
    CloseHandle(ptyInRead);
    CloseHandle(ptyOutWrite);
    if (FAILED(hr) || !g_hPC) return 3;

    SIZE_T attrListSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrListSize);
    std::vector<char> attrListBuf(attrListSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrListBuf.data());
    if (!InitializeProcThreadAttributeList(attrList, 1, 0, &attrListSize)) return 4;
    if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_hPC, sizeof(HPCON), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(attrList);
        return 4;
    }

    STARTUPINFOEXW siEx{};
    siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    siEx.lpAttributeList = attrList;

    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back(L'\0');

    BOOL ok = CreateProcessW(
        nullptr,
        cmdBuf.data(),
        nullptr,
        nullptr,
        FALSE,
        EXTENDED_STARTUPINFO_PRESENT,
        nullptr,
        nullptr,
        &siEx.StartupInfo,
        &pi);

    DeleteProcThreadAttributeList(attrList);
    if (!ok) {
        ClosePseudoConsole(g_hPC);
        return 5;
    }

    g_childProc = pi.hProcess;
    CloseHandle(pi.hThread);

    HANDLE hOutThread = CreateThread(nullptr, 0, OutputPumpThread, nullptr, 0, nullptr);
    HANDLE hInThread  = CreateThread(nullptr, 0, InputPumpThread, nullptr, 0, nullptr);
    if (hInThread) CloseHandle(hInThread);

    WaitForSingleObject(g_childProc, INFINITE);
    DWORD exitCode = 0;
    GetExitCodeProcess(g_childProc, &exitCode);

    if (g_hPC) {
        HPCON h = g_hPC;
        g_hPC = nullptr;
        ClosePseudoConsole(h);
    }
    if (g_ptyOutRead != INVALID_HANDLE_VALUE) {
        CloseHandle(g_ptyOutRead);
        g_ptyOutRead = INVALID_HANDLE_VALUE;
    }
    if (hOutThread) {
        WaitForSingleObject(hOutThread, 500);
        CloseHandle(hOutThread);
    }
    CloseHandle(g_childProc);
    return (int)exitCode;
}
