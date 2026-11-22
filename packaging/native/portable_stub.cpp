// Single-file Portable EXE launcher for Trace FPGA Workbench.
// Reads an embedded ZIP archive appended to itself with a 32-byte TRCPORT1 trailer.
// Extracts once into %LOCALAPPDATA%\TraceFPGA\portable\<tag>\ using Windows tar.exe,
// then launches Trace.exe with 0 ms overhead on all subsequent runs.

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
#include <dwmapi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <cctype>
#include <string>
#include <vector>

#pragma pack(push, 1)
struct PortableTrailer {
    char     magic[8];      // "TRCPORT1"
    uint64_t payloadOffset; // Byte offset of embedded ZIP
    uint64_t payloadSize;   // Byte length of embedded ZIP
    char     tag[8];        // 8-char hex version/content hash
};
#pragma pack(pop)
static_assert(sizeof(PortableTrailer) == 32, "Trailer must be 32 bytes");

static bool PathExists(const std::wstring& p) {
    return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
}

static void CreateDirsRecursive(const std::wstring& dir) {
    if (dir.empty() || PathExists(dir)) return;
    size_t pos = dir.find_last_of(L"\\/");
    if (pos != std::wstring::npos && pos > 2) {
        CreateDirsRecursive(dir.substr(0, pos));
    }
    CreateDirectoryW(dir.c_str(), nullptr);
}

static bool IsDirWritable(const std::wstring& dir) {
    CreateDirsRecursive(dir);
    std::wstring probe = dir + L"\\.trace-write-test";
    HANDLE h = CreateFileW(probe.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    CloseHandle(h);
    return true;
}

static std::wstring GetCacheRoot() {
    PWSTR p = nullptr;
    std::wstring base;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)) && p) {
        base = p;
        CoTaskMemFree(p);
    } else {
        wchar_t buf[MAX_PATH] = {};
        GetTempPathW(MAX_PATH, buf);
        base = buf;
    }
    if (!base.empty() && base.back() == L'\\') base.pop_back();
    return base + L"\\TraceFPGA\\portable";
}

static LRESULT CALLBACK SplashProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_PAINT) {
        PAINTSTRUCT ps{};
        HDC hdc = BeginPaint(hwnd, &ps);
        RECT rc{};
        GetClientRect(hwnd, &rc);

        HBRUSH bg = CreateSolidBrush(RGB(20, 24, 19));
        FillRect(hdc, &rc, bg);
        DeleteObject(bg);

        HPEN borderPen = CreatePen(PS_SOLID, 1, RGB(52, 61, 48));
        HGDIOBJ oldPen = SelectObject(hdc, borderPen);
        HGDIOBJ oldBrush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
        Rectangle(hdc, 0, 0, rc.right, rc.bottom);
        SelectObject(hdc, oldBrush);
        SelectObject(hdc, oldPen);
        DeleteObject(borderPen);

        SetBkMode(hdc, TRANSPARENT);
        HFONT titleFont = CreateFontW(-20, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                      DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                      CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HFONT subFont = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                    DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                    CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");

        HGDIOBJ oldFont = SelectObject(hdc, titleFont);
        SetTextColor(hdc, RGB(210, 233, 145));
        RECT tr{ 24, 24, rc.right - 24, 56 };
        DrawTextW(hdc, L"trace.", -1, &tr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

        SelectObject(hdc, subFont);
        SetTextColor(hdc, RGB(230, 234, 223));
        RECT sr{ 24, 62, rc.right - 24, 88 };
        DrawTextW(hdc, L"Preparing Trace FPGA Workbench (first-time unpack)...", -1, &sr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

        SetTextColor(hdc, RGB(150, 162, 140));
        RECT hr{ 24, 90, rc.right - 24, 112 };
        DrawTextW(hdc, L"Subsequent launches start instantly.", -1, &hr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

        SelectObject(hdc, oldFont);
        DeleteObject(titleFont);
        DeleteObject(subFont);
        EndPaint(hwnd, &ps);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static HWND ShowSplash(HINSTANCE hInst) {
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = SplashProc;
    wc.hInstance = hInst;
    wc.hCursor = LoadCursorW(nullptr, IDC_WAIT);
    wc.lpszClassName = L"TracePortableSplash";
    RegisterClassExW(&wc);

    int w = 420, h = 132;
    int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
    int y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
    HWND hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, wc.lpszClassName, L"Trace FPGA Workbench",
                                WS_POPUP, x, y, w, h, nullptr, nullptr, hInst, nullptr);
    if (hwnd) {
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);
        MSG m{};
        while (PeekMessageW(&m, hwnd, 0, 0, PM_REMOVE)) {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }
    return hwnd;
}

static std::wstring GetSystemTarPath() {
    wchar_t sysDir[MAX_PATH * 4] = {};
    UINT n = GetSystemDirectoryW(sysDir, MAX_PATH * 4);
    if (n > 0 && n < MAX_PATH * 4) {
        std::wstring p(sysDir, n);
        if (!p.empty() && p.back() != L'\\') p.push_back(L'\\');
        return p + L"tar.exe";
    }
    return L"C:\\Windows\\System32\\tar.exe";
}

static bool DeleteDirRecursive(const std::wstring& dir) {
    if (!PathExists(dir)) return true;
    WIN32_FIND_DATAW fd{};
    HANDLE hFind = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    bool ok = true;
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (std::wcscmp(fd.cFileName, L".") == 0 || std::wcscmp(fd.cFileName, L"..") == 0) continue;
            std::wstring child = dir + L"\\" + fd.cFileName;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                if (!DeleteDirRecursive(child)) ok = false;
            } else {
                SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
                if (!DeleteFileW(child.c_str())) ok = false;
            }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
    SetFileAttributesW(dir.c_str(), FILE_ATTRIBUTE_NORMAL);
    if (!RemoveDirectoryW(dir.c_str())) ok = false;
    return ok;
}

static void PruneOldCacheDirs(const std::wstring& cacheRoot, const std::wstring& keepTag) {
    WIN32_FIND_DATAW fd{};
    HANDLE hFind = FindFirstFileW((cacheRoot + L"\\*").c_str(), &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        std::wstring name = fd.cFileName;
        if (name == L"." || name == L".." || name == keepTag) continue;
        // Remove previous 8-hex-char version folders or leftover .tmp-* staging folders
        bool isHexTag = (name.size() == 8);
        if (isHexTag) {
            for (wchar_t c : name) {
                if (c > 0x7F || !std::isxdigit(static_cast<unsigned char>(c))) { isHexTag = false; break; }
            }
        }
        bool isTempStage = (name.find(L".tmp-") != std::wstring::npos);
        if (isHexTag || isTempStage) {
            DeleteDirRecursive(cacheRoot + L"\\" + name);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
}

static void PumpSplashMessages(HWND splash) {
    if (!splash) return;
    MSG m{};
    while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
}

static bool ExtractEmbeddedZip(const std::wstring& selfPath, const PortableTrailer& tr, const std::wstring& destDir, HWND splash) {
    HANDLE in = CreateFileW(selfPath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (in == INVALID_HANDLE_VALUE) return false;

    LARGE_INTEGER seekPos{};
    seekPos.QuadPart = (LONGLONG)tr.payloadOffset;
    if (!SetFilePointerEx(in, seekPos, nullptr, FILE_BEGIN)) {
        CloseHandle(in);
        return false;
    }

    wchar_t tempDir[MAX_PATH * 4] = {};
    DWORD tLen = GetTempPathW(MAX_PATH * 4, tempDir);
    if (tLen == 0 || tLen >= MAX_PATH * 4) {
        CloseHandle(in);
        return false;
    }
    std::wstring zipPath = std::wstring(tempDir, tLen) + L"trace-portable-" +
        std::wstring(tr.tag, tr.tag + 8) + L"-" + std::to_wstring(GetCurrentProcessId()) + L".zip";

    HANDLE out = CreateFileW(zipPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (out == INVALID_HANDLE_VALUE) {
        CloseHandle(in);
        return false;
    }

    std::vector<char> buf(1024 * 1024); // 1 MB copy buffer
    uint64_t remaining = tr.payloadSize;
    bool copyOk = true;
    while (remaining > 0) {
        DWORD toRead = (DWORD)(remaining > buf.size() ? buf.size() : remaining);
        DWORD got = 0, wrote = 0;
        if (!ReadFile(in, buf.data(), toRead, &got, nullptr) || got == 0) { copyOk = false; break; }
        if (!WriteFile(out, buf.data(), got, &wrote, nullptr) || wrote != got) { copyOk = false; break; }
        remaining -= got;
        PumpSplashMessages(splash);
    }
    CloseHandle(out);
    CloseHandle(in);
    if (!copyOk) {
        DeleteFileW(zipPath.c_str());
        return false;
    }

    CreateDirsRecursive(destDir);

    // Explicitly invoke Windows System32 bsdtar (never shadowed by MSYS2/Git GNU tar on PATH)
    std::wstring tarExe = GetSystemTarPath();
    std::wstring cmd = L"\"" + tarExe + L"\" -xf \"" + zipPath + L"\" -C \"" + destDir + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    BOOL started = CreateProcessW(tarExe.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, destDir.c_str(), &si, &pi);
    DWORD exitCode = 1;
    if (started) {
        for (;;) {
            DWORD waitRes = MsgWaitForMultipleObjects(1, &pi.hProcess, FALSE, INFINITE, QS_ALLINPUT);
            if (waitRes == WAIT_OBJECT_0) break;
            if (waitRes == WAIT_OBJECT_0 + 1) {
                PumpSplashMessages(splash);
            } else {
                break;
            }
        }
        GetExitCodeProcess(pi.hProcess, &exitCode);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    DeleteFileW(zipPath.c_str());
    return started && exitCode == 0;
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR lpCmdLine, int nCmdShow) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    wchar_t selfBuf[MAX_PATH * 4] = {};
    GetModuleFileNameW(nullptr, selfBuf, MAX_PATH * 4);
    std::wstring selfPath = selfBuf;

    HANDLE f = CreateFileW(selfPath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) {
        MessageBoxW(nullptr, L"Cannot open portable executable.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return 1;
    }
    LARGE_INTEGER fileSize{};
    GetFileSizeEx(f, &fileSize);
    PortableTrailer tr{};
    if (fileSize.QuadPart <= (LONGLONG)sizeof(PortableTrailer)) {
        CloseHandle(f);
        MessageBoxW(nullptr, L"Portable payload is missing from this executable.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return 1;
    }
    LARGE_INTEGER trailerPos{};
    trailerPos.QuadPart = fileSize.QuadPart - (LONGLONG)sizeof(PortableTrailer);
    DWORD got = 0;
    SetFilePointerEx(f, trailerPos, nullptr, FILE_BEGIN);
    ReadFile(f, &tr, sizeof(tr), &got, nullptr);
    CloseHandle(f);

    uint64_t fsize = static_cast<uint64_t>(fileSize.QuadPart);
    uint64_t maxPayload = fsize - sizeof(tr);
    bool tagValid = true;
    for (int i = 0; i < 8; ++i) {
        if (!std::isxdigit(static_cast<unsigned char>(tr.tag[i]))) { tagValid = false; break; }
    }
    if (got != sizeof(tr) || std::memcmp(tr.magic, "TRCPORT1", 8) != 0 || !tagValid ||
        tr.payloadSize == 0 || tr.payloadOffset > maxPayload || tr.payloadSize != maxPayload - tr.payloadOffset) {
        MessageBoxW(nullptr, L"Invalid or corrupted Trace portable bundle.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return 1;
    }

    std::wstring tag(tr.tag, tr.tag + 8);
    std::wstring cacheRoot = GetCacheRoot();
    std::wstring cacheDir = cacheRoot + L"\\" + tag;
    std::wstring targetExe = cacheDir + L"\\Trace.exe";
    std::wstring readyFlag = cacheDir + L"\\.ready";

    HWND splash = nullptr;
    if (!PathExists(readyFlag) || !PathExists(targetExe)) {
        HANDLE unpackMutex = CreateMutexW(nullptr, FALSE, (L"Local\\TracePortableUnpack_" + tag).c_str());
        if (unpackMutex) {
            WaitForSingleObject(unpackMutex, INFINITE);
        }
        bool needExtract = (!PathExists(readyFlag) || !PathExists(targetExe));
        bool unpackOk = true;
        if (needExtract) {
            CreateDirsRecursive(cacheRoot);
            splash = ShowSplash(hInstance);
            std::wstring stageDir = cacheDir + L".tmp-" + std::to_wstring(GetCurrentProcessId());
            DeleteDirRecursive(stageDir);
            bool ok = ExtractEmbeddedZip(selfPath, tr, stageDir, splash);
            if (ok && PathExists(stageDir + L"\\Trace.exe")) {
                HANDLE rf = CreateFileW((stageDir + L"\\.ready").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, nullptr);
                if (rf != INVALID_HANDLE_VALUE) CloseHandle(rf);
                DeleteDirRecursive(cacheDir);
                if (!MoveFileExW(stageDir.c_str(), cacheDir.c_str(), MOVEFILE_WRITE_THROUGH)) {
                    DeleteDirRecursive(stageDir);
                    unpackOk = false;
                }
            } else {
                DeleteDirRecursive(stageDir);
                unpackOk = false;
            }
            if (unpackOk) {
                PruneOldCacheDirs(cacheRoot, tag);
            }
        }
        if (unpackMutex) {
            ReleaseMutex(unpackMutex);
            CloseHandle(unpackMutex);
        }
        if (!unpackOk || !PathExists(targetExe)) {
            if (splash) DestroyWindow(splash);
            MessageBoxW(nullptr, L"Failed to unpack Trace FPGA Workbench portable bundle.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
            return 1;
        }
    }

    SetEnvironmentVariableW(L"TRACE_PORTABLE", L"1");
    // True portable user data: store config, logs & WebView2 profile in TraceData\ beside this .exe
    size_t selfSlash = selfPath.find_last_of(L"\\/");
    std::wstring selfDir = (selfSlash != std::wstring::npos) ? selfPath.substr(0, selfSlash) : L".";
    std::wstring portableDataDir = selfDir + L"\\TraceData";
    if (IsDirWritable(portableDataDir)) {
        SetEnvironmentVariableW(L"TRACE_DATA_DIR", portableDataDir.c_str());
    }

    std::wstring cmd = L"\"" + targetExe + L"\"";
    if (lpCmdLine && lpCmdLine[0] != L'\0') {
        cmd += L" ";
        cmd += lpCmdLine;
    }
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    AllowSetForegroundWindow(ASFW_ANY);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = (nCmdShow == SW_SHOWMINIMIZED || nCmdShow == SW_MINIMIZE || nCmdShow == SW_SHOWMINNOACTIVE)
        ? (WORD)nCmdShow
        : (WORD)SW_SHOWMAXIMIZED;
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(targetExe.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE, 0, nullptr, cacheDir.c_str(), &si, &pi)) {
        if (splash) DestroyWindow(splash);
        MessageBoxW(nullptr, L"Failed to launch Trace.exe from portable cache.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return 1;
    }
    AllowSetForegroundWindow(pi.dwProcessId);
    if (splash) {
        WaitForInputIdle(pi.hProcess, 2000);
        DestroyWindow(splash);
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CoUninitialize();
    return 0;
}
