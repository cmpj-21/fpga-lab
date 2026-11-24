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
#include <atomic>
#include <string>
#include <vector>

static HPCON  g_hPC = nullptr;
static HANDLE g_hostInRead = INVALID_HANDLE_VALUE;
static HANDLE g_hostOutWrite = INVALID_HANDLE_VALUE;
static HANDLE g_ptyInWrite = INVALID_HANDLE_VALUE;
static HANDLE g_ptyOutRead = INVALID_HANDLE_VALUE;
static HANDLE g_childProc  = INVALID_HANDLE_VALUE;
static HANDLE g_childJob   = nullptr;
static CRITICAL_SECTION g_ptyLock{};
static std::atomic<bool> g_exiting{false};
static std::string g_oscCarry;

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

static void WriteAllPty(const char* ptr, size_t count) {
    if (!ptr || count == 0 || g_ptyInWrite == INVALID_HANDLE_VALUE) return;
    size_t sent = 0;
    while (sent < count) {
        DWORD toWrite = static_cast<DWORD>(count - sent);
        DWORD written = 0;
        if (!WriteFile(g_ptyInWrite, ptr + sent, toWrite, &written, nullptr) || written == 0) {
            break;
        }
        sent += written;
    }
}

static void HandleInputChunk(const char* chunk, size_t chunkLen) {
    // Intercept private OSC resize control sequence: \x1b]9999;R;<cols>;<rows>\x07
    static const char* kPrefix = "\x1b]9999;R;";
    static const size_t kPrefixLen = 9;
    std::string combined;
    const char* data = chunk;
    size_t len = chunkLen;
    if (!g_oscCarry.empty()) {
        combined.reserve(g_oscCarry.size() + chunkLen);
        combined.append(g_oscCarry);
        combined.append(chunk, chunkLen);
        g_oscCarry.clear();
        data = combined.data();
        len = combined.size();
    }

    size_t pos = 0;
    while (pos < len) {
        size_t matchIdx = std::string::npos;
        for (size_t i = pos; i + kPrefixLen <= len; ++i) {
            if (std::memcmp(data + i, kPrefix, kPrefixLen) == 0) {
                matchIdx = i;
                break;
            }
        }
        if (matchIdx == std::string::npos) {
            // Preserve only a trailing partial match of "\x1b]9999;R;" of length >= 2 (never delay bare ESC)
            size_t tailHold = 0;
            size_t maxCheck = (len - pos < kPrefixLen - 1) ? (len - pos) : (kPrefixLen - 1);
            for (size_t k = maxCheck; k >= 2; --k) {
                if (std::memcmp(data + (len - k), kPrefix, k) == 0) {
                    tailHold = k;
                    break;
                }
            }
            WriteAllPty(data + pos, (len - pos) - tailHold);
            if (tailHold > 0) {
                g_oscCarry.assign(data + (len - tailHold), tailHold);
            }
            break;
        }
        if (matchIdx > pos) {
            WriteAllPty(data + pos, matchIdx - pos);
        }
        size_t endBell = matchIdx + kPrefixLen;
        while (endBell < len && data[endBell] != '\x07') ++endBell;
        if (endBell < len && data[endBell] == '\x07') {
            std::string payload(data + matchIdx + kPrefixLen, endBell - (matchIdx + kPrefixLen));
            int cols = 0, rows = 0;
            if (std::sscanf(payload.c_str(), "%d;%d", &cols, &rows) == 2 && cols > 1 && rows > 1) {
                if (cols > 1000) cols = 1000;
                if (rows > 500) rows = 500;
                COORD sz{ static_cast<SHORT>(cols), static_cast<SHORT>(rows) };
                EnterCriticalSection(&g_ptyLock);
                if (g_hPC) {
                    ResizePseudoConsole(g_hPC, sz);
                }
                LeaveCriticalSection(&g_ptyLock);
            }
            pos = endBell + 1;
        } else {
            size_t rem = len - matchIdx;
            if (rem < 48) {
                g_oscCarry.assign(data + matchIdx, rem);
            } else {
                WriteAllPty(data + matchIdx, rem);
            }
            break;
        }
    }
}

static DWORD WINAPI InputPumpThread(LPVOID) {
    HANDLE hStdIn = g_hostInRead;
    char buf[4096];
    DWORD bytesRead = 0;
    while (!g_exiting.load() &&
           hStdIn != INVALID_HANDLE_VALUE &&
           ReadFile(hStdIn, buf, sizeof(buf), &bytesRead, nullptr) &&
           bytesRead > 0) {
        HandleInputChunk(buf, bytesRead);
    }
    // Stdin closed by parent Node server -> terminate child tree so wmain performs deterministic teardown
    g_exiting.store(true);
    if (g_childJob) {
        TerminateJobObject(g_childJob, 0);
    } else if (g_childProc != INVALID_HANDLE_VALUE) {
        TerminateProcess(g_childProc, 0);
    }
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
    if (cols > 1000) cols = 1000;
    if (rows < 4)  rows = 30;
    if (rows > 500) rows = 500;

    std::wstring cmdLine;
    for (int i = 3; i < argc; ++i) {
        if (i > 3) cmdLine += L" ";
        std::wstring a = argv[i] ? argv[i] : L"";
        if (a.empty()) {
            cmdLine += L"\"\"";
        } else if (a.find(L' ') != std::wstring::npos && a.front() != L'"') {
            cmdLine += L"\"" + a + L"\"";
        } else {
            cmdLine += a;
        }
    }

    InitializeCriticalSection(&g_ptyLock);

    HANDLE ptyInRead = INVALID_HANDLE_VALUE;
    HANDLE ptyOutWrite = INVALID_HANDLE_VALUE;
    if (!CreatePipe(&ptyInRead, &g_ptyInWrite, nullptr, 0)) { DeleteCriticalSection(&g_ptyLock); return 2; }
    if (!CreatePipe(&g_ptyOutRead, &ptyOutWrite, nullptr, 0)) { DeleteCriticalSection(&g_ptyLock); return 2; }

    COORD consoleSize{ (SHORT)cols, (SHORT)rows };
    HRESULT hr = CreatePseudoConsole(consoleSize, ptyInRead, ptyOutWrite, 0, &g_hPC);
    CloseHandle(ptyInRead);
    CloseHandle(ptyOutWrite);
    if (FAILED(hr) || !g_hPC) { DeleteCriticalSection(&g_ptyLock); return 3; }

    // Job Object guarantees killing conpty_host.exe never orphans the attached shell or its child processes
    g_childJob = CreateJobObjectW(nullptr, nullptr);
    if (g_childJob) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jinfo{};
        jinfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(g_childJob, JobObjectExtendedLimitInformation, &jinfo, sizeof(jinfo));
    }

    SIZE_T attrListSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrListSize);
    std::vector<char> attrListBuf(attrListSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrListBuf.data());
    if (!InitializeProcThreadAttributeList(attrList, 1, 0, &attrListSize)) {
        ClosePseudoConsole(g_hPC);
        if (g_childJob) CloseHandle(g_childJob);
        DeleteCriticalSection(&g_ptyLock);
        return 4;
    }
    if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_hPC, sizeof(HPCON), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(attrList);
        ClosePseudoConsole(g_hPC);
        if (g_childJob) CloseHandle(g_childJob);
        DeleteCriticalSection(&g_ptyLock);
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
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
        nullptr,
        nullptr,
        &siEx.StartupInfo,
        &pi);

    DeleteProcThreadAttributeList(attrList);
    if (!ok) {
        ClosePseudoConsole(g_hPC);
        if (g_childJob) CloseHandle(g_childJob);
        DeleteCriticalSection(&g_ptyLock);
        return 5;
    }

    if (g_childJob) {
        AssignProcessToJobObject(g_childJob, pi.hProcess);
    }
    g_childProc = pi.hProcess;
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    HANDLE hOutThread = CreateThread(nullptr, 0, OutputPumpThread, nullptr, 0, nullptr);
    HANDLE hInThread  = CreateThread(nullptr, 0, InputPumpThread, nullptr, 0, nullptr);

    WaitForSingleObject(g_childProc, INFINITE);
    DWORD exitCode = 0;
    GetExitCodeProcess(g_childProc, &exitCode);
    g_exiting.store(true);

    // Close ConPTY first so OutputPumpThread drains remaining terminal output and sees EOF cleanly
    EnterCriticalSection(&g_ptyLock);
    HPCON hPc = g_hPC;
    g_hPC = nullptr;
    LeaveCriticalSection(&g_ptyLock);
    if (hPc) {
        ClosePseudoConsole(hPc);
    }

    bool outExited = true;
    if (hOutThread) {
        if (WaitForSingleObject(hOutThread, 1000) == WAIT_TIMEOUT) {
            CancelSynchronousIo(hOutThread);
            outExited = (WaitForSingleObject(hOutThread, 300) == WAIT_OBJECT_0);
        }
        CloseHandle(hOutThread);
    }
    if (g_ptyOutRead != INVALID_HANDLE_VALUE && outExited) {
        CloseHandle(g_ptyOutRead);
        g_ptyOutRead = INVALID_HANDLE_VALUE;
    }

    if (hInThread) {
        CancelSynchronousIo(hInThread);
        WaitForSingleObject(hInThread, 200);
        CloseHandle(hInThread);
    }
    if (g_ptyInWrite != INVALID_HANDLE_VALUE) {
        CloseHandle(g_ptyInWrite);
        g_ptyInWrite = INVALID_HANDLE_VALUE;
    }
    if (g_childJob) {
        TerminateJobObject(g_childJob, 0);
        CloseHandle(g_childJob);
        g_childJob = nullptr;
    }
    CloseHandle(g_childProc);
    DeleteCriticalSection(&g_ptyLock);
    return (int)exitCode;
}
