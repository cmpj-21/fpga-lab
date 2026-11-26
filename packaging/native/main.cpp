// Native Win32 + Microsoft Edge WebView2 host for Trace FPGA Workbench.
// Pure standard C++ + Win32 COM (no MSVC WRL/WIL dependency; compiles directly with MinGW UCRT64 g++).

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
#include <objbase.h>
#include <shlobj.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <atomic>
#include <cstdio>
#include <cwchar>
#include <WebView2.h>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

static constexpr UINT WM_APP_BACKEND_READY = WM_APP + 1;
static constexpr UINT WM_APP_BACKEND_FAIL  = WM_APP + 2;
static constexpr UINT_PTR IDT_CLOSE_WATCHDOG = 1;
static constexpr int  IDI_APP_ICON         = 101;

using CreateWebView2EnvFn = HRESULT(STDAPICALLTYPE*)(
    PCWSTR browserExecutableFolder,
    PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* environmentCreatedHandler);

struct AppState {
    HWND hwnd = nullptr;
    HANDLE appMutex = nullptr;
    HANDLE job = nullptr;
    HANDLE nodeProcess = nullptr;
    HANDLE watcherThread = nullptr;
    HANDLE stdoutRead = nullptr;
    HANDLE stdinWrite = nullptr;
    ICoreWebView2Controller* controller = nullptr;
    ICoreWebView2* webview = nullptr;
    CreateWebView2EnvFn createEnvFn = nullptr;
    UINT32 browserPid = 0;
    std::wstring exeDir;
    std::wstring exePath;
    std::wstring dataDir;
    std::wstring tempWebViewDir;
    std::wstring baseUrl;
    std::wstring initialQuery;
    bool devtools = false;
    bool ready = false;
    bool navigated = false;
    bool allowClose = false;
    bool closePending = false;
    bool isFullscreen = false;
    bool wv2FallbackAttempted = false;
    WINDOWPLACEMENT savedPlacement{ sizeof(WINDOWPLACEMENT) };
    LONG_PTR savedStyle = 0;
    LONG_PTR savedExStyle = 0;
};

static AppState g_app;

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
    return out;
}

static std::string WideToUtf8(const std::wstring& s) {
    if (s.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n, nullptr, nullptr);
    return out;
}

static std::wstring UrlEncode(const std::wstring& value) {
    std::string utf8 = WideToUtf8(value);
    std::wstring out;
    out.reserve(utf8.size() * 2);
    const wchar_t* hex = L"0123456789ABCDEF";
    for (unsigned char c : utf8) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back((wchar_t)c);
        } else {
            out.push_back(L'%');
            out.push_back(hex[(c >> 4) & 0xF]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

static bool FileExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static bool DirExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

static void CreateDirsRecursive(const std::wstring& dir) {
    if (dir.empty() || DirExists(dir)) return;
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

static std::wstring FormatHRESULT(HRESULT hr) {
    wchar_t buf[32] = {};
    std::swprintf(buf, 32, L"0x%08lX", static_cast<unsigned long>(hr));
    return buf;
}

static void AppendNativeLog(const std::wstring& msg) {
    std::wstring base = g_app.dataDir;
    if (base.empty()) {
        wchar_t envBuf[MAX_PATH * 4] = {};
        DWORD n = GetEnvironmentVariableW(L"TRACE_DATA_DIR", envBuf, MAX_PATH * 4);
        if (n > 0 && n < MAX_PATH * 4) {
            base.assign(envBuf, n);
        } else {
            wchar_t tmp[MAX_PATH] = {};
            DWORD tn = GetTempPathW(MAX_PATH, tmp);
            if (tn > 0 && tn < MAX_PATH) {
                base.assign(tmp, tn);
                if (!base.empty() && base.back() == L'\\') base.pop_back();
                base += L"\\TraceFPGA";
            }
        }
    }
    if (base.empty()) return;
    std::wstring logDir = base + L"\\logs";
    CreateDirsRecursive(logDir);
    std::wstring logPath = logDir + L"\\native-crash.log";
    HANDLE h = CreateFileW(logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME st{};
    GetLocalTime(&st);
    wchar_t prefix[96] = {};
    std::swprintf(prefix, 96, L"[%04u-%02u-%02u %02u:%02u:%02u.%03u][pid:%lu] ",
                  st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
                  static_cast<unsigned long>(GetCurrentProcessId()));
    std::string line = WideToUtf8(std::wstring(prefix) + msg + L"\r\n");
    DWORD written = 0;
    WriteFile(h, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    CloseHandle(h);
}

static LONG WINAPI TraceUnhandledExceptionFilter(EXCEPTION_POINTERS* ep) {
    DWORD code = (ep && ep->ExceptionRecord) ? ep->ExceptionRecord->ExceptionCode : 0;
    void* addr = (ep && ep->ExceptionRecord) ? ep->ExceptionRecord->ExceptionAddress : nullptr;
    wchar_t buf[160] = {};
    std::swprintf(buf, 160, L"Unhandled native exception code=0x%08lX addr=%p",
                  static_cast<unsigned long>(code), addr);
    AppendNativeLog(buf);
    if (g_app.job) {
        TerminateJobObject(g_app.job, 1);
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

static void DeleteDirBestEffort(const std::wstring& dir) {
    if (dir.empty() || !DirExists(dir)) return;
    WIN32_FIND_DATAW fd{};
    HANDLE hFind = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (std::wcscmp(fd.cFileName, L".") == 0 || std::wcscmp(fd.cFileName, L"..") == 0) continue;
            std::wstring child = dir + L"\\" + fd.cFileName;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                DeleteDirBestEffort(child);
            } else {
                SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
                DeleteFileW(child.c_str());
            }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
    SetFileAttributesW(dir.c_str(), FILE_ATTRIBUTE_NORMAL);
    RemoveDirectoryW(dir.c_str());
}

static void PruneStaleSessionDirs(const std::wstring& dataDir) {
    if (dataDir.empty() || !DirExists(dataDir)) return;
    WIN32_FIND_DATAW fd{};
    HANDLE hFind = FindFirstFileW((dataDir + L"\\webview2-session-*").c_str(), &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    std::wstring ownName = L"webview2-session-" + std::to_wstring(GetCurrentProcessId());
    do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        std::wstring name = fd.cFileName;
        if (name == ownName) continue;
        // Skip folders whose owning Trace.exe PID is still alive
        DWORD pid = 0;
        if (name.size() > 17) {
            pid = static_cast<DWORD>(_wtoi(name.c_str() + 17));
        }
        bool alive = false;
        if (pid != 0) {
            HANDLE hProc = OpenProcess(SYNCHRONIZE, FALSE, pid);
            if (hProc) {
                alive = (WaitForSingleObject(hProc, 0) == WAIT_TIMEOUT);
                CloseHandle(hProc);
            }
        }
        if (!alive) {
            DeleteDirBestEffort(dataDir + L"\\" + name);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
}

static bool StartWebView2WithDir(const std::wstring& userData);

static std::wstring GetDataDir() {
    // 1. Explicit TRACE_DATA_DIR (set by single-file portable stub or user)
    wchar_t envBuf[MAX_PATH * 4] = {};
    DWORD n = GetEnvironmentVariableW(L"TRACE_DATA_DIR", envBuf, MAX_PATH * 4);
    if (n > 0 && n < MAX_PATH * 4) {
        std::wstring d(envBuf, n);
        CreateDirsRecursive(d);
        return d;
    }
    // 2. Portable folder mode (portable.mode marker or existing TraceData\ beside Trace.exe).
    // Skip when TRACE_PORTABLE=1 (single-file stub running out of versioned cache dir whose host folder was read-only).
    wchar_t portFlag[16] = {};
    DWORD pfLen = GetEnvironmentVariableW(L"TRACE_PORTABLE", portFlag, 16);
    bool fromSingleFileStub = (pfLen > 0 && std::wstring(portFlag, pfLen) == L"1");
    std::wstring siblingData = g_app.exeDir + L"\\TraceData";
    if (!fromSingleFileStub && (FileExists(g_app.exeDir + L"\\portable.mode") || DirExists(siblingData)) && IsDirWritable(siblingData)) {
        return siblingData;
    }
    // 3. Installed app default (%LOCALAPPDATA%\TraceFPGA)
    PWSTR p = nullptr;
    std::wstring dir;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)) && p) {
        dir = p;
        CoTaskMemFree(p);
    } else {
        wchar_t buf[MAX_PATH] = {};
        GetTempPathW(MAX_PATH, buf);
        dir = buf;
    }
    if (!dir.empty() && dir.back() == L'\\') dir.pop_back();
    dir += L"\\TraceFPGA";
    CreateDirsRecursive(dir);
    return dir;
}

static void ResizeWebView() {
    if (!g_app.controller || !g_app.hwnd) return;
    RECT rc{};
    GetClientRect(g_app.hwnd, &rc);
    g_app.controller->put_Bounds(rc);
}

static void BringToForeground(HWND hwnd) {
    if (!hwnd || IsIconic(hwnd)) return;
    HWND fgWnd = GetForegroundWindow();
    DWORD fgThread = fgWnd ? GetWindowThreadProcessId(fgWnd, nullptr) : 0;
    DWORD curThread = GetCurrentThreadId();
    if (fgThread && fgThread != curThread) {
        AttachThreadInput(fgThread, curThread, TRUE);
    }
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetForegroundWindow(hwnd);
    BringWindowToTop(hwnd);
    SetActiveWindow(hwnd);
    SetFocus(hwnd);
    if (fgThread && fgThread != curThread) {
        AttachThreadInput(fgThread, curThread, FALSE);
    }
    if (g_app.controller) {
        g_app.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}

static void ToggleFullscreen(HWND hwnd) {
    if (!hwnd) return;
    if (!g_app.isFullscreen) {
        g_app.savedPlacement.length = sizeof(WINDOWPLACEMENT);
        GetWindowPlacement(hwnd, &g_app.savedPlacement);
        g_app.savedStyle = GetWindowLongPtrW(hwnd, GWL_STYLE);
        g_app.savedExStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        MONITORINFO mi{ sizeof(mi) };
        if (GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
            g_app.isFullscreen = true;
            SetWindowLongPtrW(hwnd, GWL_STYLE, (g_app.savedStyle & ~WS_OVERLAPPEDWINDOW) | WS_POPUP | WS_VISIBLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, g_app.savedExStyle & ~(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE));
            SetWindowPos(hwnd, HWND_TOP,
                         mi.rcMonitor.left, mi.rcMonitor.top,
                         mi.rcMonitor.right - mi.rcMonitor.left,
                         mi.rcMonitor.bottom - mi.rcMonitor.top,
                         SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            ResizeWebView();
        }
    } else {
        g_app.isFullscreen = false;
        SetWindowLongPtrW(hwnd, GWL_STYLE, g_app.savedStyle | WS_VISIBLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, g_app.savedExStyle);
        SetWindowPlacement(hwnd, &g_app.savedPlacement);
        SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        ResizeWebView();
    }
}

static void NavigateIfReady() {
    if (!g_app.navigated && g_app.webview && !g_app.baseUrl.empty()) {
        g_app.navigated = true;
        std::wstring target = g_app.baseUrl + g_app.initialQuery;
        g_app.webview->Navigate(target.c_str());
    }
}

static std::wstring QuoteWin32Arg(const std::wstring& arg) {
    if (arg.empty()) return L"\"\"";
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++backslashes;
        } else if (c == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(L'"');
            backslashes = 0;
        } else {
            if (backslashes) {
                out.append(backslashes, L'\\');
                backslashes = 0;
            }
            out.push_back(c);
        }
    }
    if (backslashes) out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

static void SpawnNewWindowWithQuery(const std::wstring& query) {
    std::wstring cmd = QuoteWin32Arg(g_app.exePath);
    if (!query.empty()) {
        cmd += L" --query " + QuoteWin32Arg(query);
    }
    if (g_app.devtools) {
        cmd += L" --devtools";
    }
    AllowSetForegroundWindow(ASFW_ANY);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOWMAXIMIZED;
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    if (CreateProcessW(g_app.exePath.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE, 0, nullptr, g_app.exeDir.c_str(), &si, &pi)) {
        AllowSetForegroundWindow(pi.dwProcessId);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

// ---------- Minimal COM Handlers (zero WRL dependency) ----------

class CloseScriptCompletedHandler final : public ICoreWebView2ExecuteScriptCompletedHandler {
    std::atomic<ULONG> ref_{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2ExecuteScriptCompletedHandler) {
            *ppv = static_cast<ICoreWebView2ExecuteScriptCompletedHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, LPCWSTR resultObjectAsJson) override {
        g_app.closePending = false;
        if (g_app.hwnd && IsWindow(g_app.hwnd)) {
            KillTimer(g_app.hwnd, IDT_CLOSE_WATCHDOG);
        }
        if (FAILED(errorCode) || !resultObjectAsJson || std::wcscmp(resultObjectAsJson, L"1") != 0) {
            g_app.allowClose = true;
            if (g_app.hwnd && IsWindow(g_app.hwnd)) DestroyWindow(g_app.hwnd);
        }
        return S_OK;
    }
};

class ProcessFailedHandler final : public ICoreWebView2ProcessFailedEventHandler {
    std::atomic<ULONG> ref_{1};
    static const wchar_t* KindName(COREWEBVIEW2_PROCESS_FAILED_KIND kind) {
        switch (kind) {
            case COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED: return L"BROWSER_PROCESS_EXITED";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED: return L"RENDER_PROCESS_EXITED";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE: return L"RENDER_PROCESS_UNRESPONSIVE";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED: return L"FRAME_RENDER_PROCESS_EXITED";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED: return L"UTILITY_PROCESS_EXITED";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED: return L"SANDBOX_HELPER_PROCESS_EXITED";
            case COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED: return L"GPU_PROCESS_EXITED";
            default: return L"OTHER_PROCESS_FAILED";
        }
    }
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2ProcessFailedEventHandler) {
            *ppv = static_cast<ICoreWebView2ProcessFailedEventHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2ProcessFailedEventArgs* args) override {
        COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
        if (args) {
            args->get_ProcessFailedKind(&kind);
        }
        std::wstring kindStr = KindName(kind);
        AppendNativeLog(L"WebView2 ProcessFailed: " + kindStr + L" (" + std::to_wstring(static_cast<int>(kind)) + L")");

        if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) {
            if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                int choice = MessageBoxW(
                    g_app.hwnd,
                    L"The Trace UI renderer stopped unexpectedly.\n\nDetails were saved to logs\\native-crash.log.\nReload the workbench now?",
                    L"Trace FPGA Workbench",
                    MB_YESNO | MB_ICONWARNING);
                if (choice == IDYES && sender) {
                    sender->Reload();
                }
            }
        } else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
            if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                MessageBoxW(
                    g_app.hwnd,
                    L"The Microsoft Edge WebView2 browser process exited unexpectedly.\n\nDetails were saved to logs\\native-crash.log. Trace will now close.",
                    L"Trace FPGA Workbench",
                    MB_OK | MB_ICONERROR);
                g_app.allowClose = true;
                DestroyWindow(g_app.hwnd);
            }
        }
        return S_OK;
    }
};

class WebMessageReceivedHandler final : public ICoreWebView2WebMessageReceivedEventHandler {
    std::atomic<ULONG> ref_{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2WebMessageReceivedEventHandler) {
            *ppv = static_cast<ICoreWebView2WebMessageReceivedEventHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) override {
        LPWSTR msgRaw = nullptr;
        if (SUCCEEDED(args->TryGetWebMessageAsString(&msgRaw)) && msgRaw) {
            std::wstring msg(msgRaw);
            CoTaskMemFree(msgRaw);
            if (msg == L"app:close-now") {
                g_app.closePending = false;
                g_app.allowClose = true;
                if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                    KillTimer(g_app.hwnd, IDT_CLOSE_WATCHDOG);
                    PostMessageW(g_app.hwnd, WM_CLOSE, 0, 0);
                }
            } else if (msg == L"app:toggle-fullscreen") {
                ToggleFullscreen(g_app.hwnd);
            } else if (msg == L"app:exit-fullscreen") {
                if (g_app.isFullscreen) ToggleFullscreen(g_app.hwnd);
            }
        }
        return S_OK;
    }
};

class NewWindowHandler final : public ICoreWebView2NewWindowRequestedEventHandler {
    std::atomic<ULONG> ref_{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2NewWindowRequestedEventHandler) {
            *ppv = static_cast<ICoreWebView2NewWindowRequestedEventHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) override {
        LPWSTR uriRaw = nullptr;
        if (SUCCEEDED(args->get_Uri(&uriRaw)) && uriRaw) {
            std::wstring uri(uriRaw);
            CoTaskMemFree(uriRaw);
            if (!g_app.baseUrl.empty() && uri.rfind(g_app.baseUrl, 0) == 0) {
                std::wstring suffix = uri.substr(g_app.baseUrl.size());
                args->put_Handled(TRUE);
                SpawnNewWindowWithQuery(suffix);
                return S_OK;
            }
            if (uri.rfind(L"http://", 0) == 0 || uri.rfind(L"https://", 0) == 0) {
                args->put_Handled(TRUE);
                ShellExecuteW(g_app.hwnd, L"open", uri.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                return S_OK;
            }
        }
        return S_OK;
    }
};

class ControllerCompletedHandler final : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
    std::atomic<ULONG> ref_{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) {
            *ppv = static_cast<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
        if (FAILED(result) || !controller) {
            if (g_app.hwnd && IsWindow(g_app.hwnd) && !g_app.wv2FallbackAttempted && g_app.createEnvFn) {
                g_app.wv2FallbackAttempted = true;
                std::wstring baseData = g_app.dataDir.empty() ? GetDataDir() : g_app.dataDir;
                std::wstring fallbackDir = baseData + L"\\webview2-session-" + std::to_wstring(GetCurrentProcessId());
                g_app.tempWebViewDir = fallbackDir;
                if (StartWebView2WithDir(fallbackDir)) {
                    return S_OK;
                }
            }
            if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                std::wstring msg = L"Failed to initialize Microsoft Edge WebView2 controller (" + FormatHRESULT(result) + L").";
                AppendNativeLog(msg);
                MessageBoxW(g_app.hwnd, msg.c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
                DestroyWindow(g_app.hwnd);
            } else {
                PostQuitMessage(1);
            }
            return result;
        }
        g_app.controller = controller;
        g_app.controller->AddRef();

        // Dark background (#141813) before first frame to prevent white flash
        ICoreWebView2Controller2* ctrl2 = nullptr;
        if (SUCCEEDED(controller->QueryInterface(IID_ICoreWebView2Controller2, (void**)&ctrl2)) && ctrl2) {
            COREWEBVIEW2_COLOR bg{ 255, 20, 24, 19 };
            ctrl2->put_DefaultBackgroundColor(bg);
            ctrl2->Release();
        }

        if (SUCCEEDED(controller->get_CoreWebView2(&g_app.webview)) && g_app.webview) {
            g_app.webview->get_BrowserProcessId(&g_app.browserPid);
            ICoreWebView2Settings* settings = nullptr;
            if (SUCCEEDED(g_app.webview->get_Settings(&settings)) && settings) {
                settings->put_IsStatusBarEnabled(FALSE);
                settings->put_AreDevToolsEnabled(g_app.devtools ? TRUE : FALSE);
                settings->put_AreDefaultScriptDialogsEnabled(TRUE);
                settings->put_IsZoomControlEnabled(TRUE);
                settings->Release();
            }
            EventRegistrationToken tok{};
            auto* nwHandler = new NewWindowHandler();
            g_app.webview->add_NewWindowRequested(nwHandler, &tok);
            nwHandler->Release();

            EventRegistrationToken msgTok{};
            auto* msgHandler = new WebMessageReceivedHandler();
            g_app.webview->add_WebMessageReceived(msgHandler, &msgTok);
            msgHandler->Release();

            EventRegistrationToken pfTok{};
            auto* pfHandler = new ProcessFailedHandler();
            g_app.webview->add_ProcessFailed(pfHandler, &pfTok);
            pfHandler->Release();
        }

        ResizeWebView();
        g_app.controller->put_IsVisible(TRUE);
        BringToForeground(g_app.hwnd);

        NavigateIfReady();
        return S_OK;
    }
};

class EnvironmentCompletedHandler final : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
    std::atomic<ULONG> ref_{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler) {
            *ppv = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* env) override {
        if (FAILED(result) || !env) {
            if (g_app.hwnd && IsWindow(g_app.hwnd) && !g_app.wv2FallbackAttempted && g_app.createEnvFn) {
                g_app.wv2FallbackAttempted = true;
                std::wstring baseData = g_app.dataDir.empty() ? GetDataDir() : g_app.dataDir;
                std::wstring fallbackDir = baseData + L"\\webview2-session-" + std::to_wstring(GetCurrentProcessId());
                g_app.tempWebViewDir = fallbackDir;
                if (StartWebView2WithDir(fallbackDir)) {
                    return S_OK;
                }
            }
            if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                std::wstring msg =
                    L"Microsoft Edge WebView2 Runtime is required to run Trace FPGA Workbench (" + FormatHRESULT(result) + L").\n\n"
                    L"Install the Evergreen WebView2 Runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/";
                AppendNativeLog(L"WebView2 Environment creation failed (" + FormatHRESULT(result) + L")");
                MessageBoxW(g_app.hwnd, msg.c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
                DestroyWindow(g_app.hwnd);
            } else {
                PostQuitMessage(1);
            }
            return result;
        }
        auto* handler = new ControllerCompletedHandler();
        HRESULT ctrlHr = env->CreateCoreWebView2Controller(g_app.hwnd, handler);
        handler->Release();
        if (FAILED(ctrlHr)) {
            std::wstring msg = L"Failed to request Microsoft Edge WebView2 controller (" + FormatHRESULT(ctrlHr) + L").";
            AppendNativeLog(msg);
            if (g_app.hwnd && IsWindow(g_app.hwnd)) {
                MessageBoxW(g_app.hwnd, msg.c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
                DestroyWindow(g_app.hwnd);
            } else {
                PostQuitMessage(1);
            }
            return ctrlHr;
        }
        return S_OK;
    }
};

// ---------- Backend Node.js Process Management ----------

struct WatcherParams {
    HWND hwnd = nullptr;
    HANDLE stdoutRead = nullptr;
    std::wstring dataDir;
};

static DWORD WINAPI BackendWatcherThread(LPVOID lpParam) {
    WatcherParams* params = reinterpret_cast<WatcherParams*>(lpParam);
    HWND hwnd = params ? params->hwnd : nullptr;
    HANDLE stdoutRead = params ? params->stdoutRead : nullptr;
    std::wstring dataDir = params ? params->dataDir : L"";
    delete params;

    std::string buffer;
    char chunk[1024];
    DWORD bytesRead = 0;
    bool signaled = false;

    while (stdoutRead && ReadFile(stdoutRead, chunk, sizeof(chunk) - 1, &bytesRead, nullptr) && bytesRead > 0) {
        chunk[bytesRead] = '\0';
        buffer.append(chunk, bytesRead);
        if (buffer.size() > 65536) {
            buffer.erase(0, buffer.size() - 4096);
        }
        size_t pos = 0;
        while ((pos = buffer.find('\n')) != std::string::npos) {
            std::string line = buffer.substr(0, pos);
            buffer.erase(0, pos + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!signaled && line.rfind("TRACE_READY ", 0) == 0) {
                std::string url = line.substr(12);
                auto* urlPtr = new std::wstring(Utf8ToWide(url));
                signaled = true;
                if (!PostMessageW(hwnd, WM_APP_BACKEND_READY, 0, reinterpret_cast<LPARAM>(urlPtr))) {
                    delete urlPtr;
                }
            }
        }
    }
    if (!signaled && hwnd) {
        AppendNativeLog(L"Backend node.exe stdout closed before TRACE_READY.");
        std::wstring logPath = dataDir.empty() ? L"%LOCALAPPDATA%\\TraceFPGA\\logs\\latest.log" : (dataDir + L"\\logs\\latest.log");
        auto* errPtr = new std::wstring(L"Trace backend server exited before becoming ready.\n\nCheck " + logPath + L" for details.");
        if (!PostMessageW(hwnd, WM_APP_BACKEND_FAIL, 0, reinterpret_cast<LPARAM>(errPtr))) {
            delete errPtr;
        }
    }
    return 0;
}

static bool StartBackendServer() {
    // Resolve node.exe and server.mjs (supports both staged release and repo dev layout)
    std::wstring nodeExe = g_app.exeDir + L"\\runtime\\node\\node.exe";
    std::wstring serverMjs = g_app.exeDir + L"\\app\\server.mjs";
    if (!FileExists(serverMjs)) {
        serverMjs = g_app.exeDir + L"\\server.mjs";
    }
    if (!FileExists(serverMjs)) {
        MessageBoxW(g_app.hwnd, (L"Could not locate server.mjs near:\n" + g_app.exeDir).c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return false;
    }
    if (!FileExists(nodeExe)) {
        nodeExe = L"node.exe";
    }

    // Create Job Object so closing or crashing Trace.exe terminates node.exe + ghdl.exe cleanly
    g_app.job = CreateJobObjectW(nullptr, nullptr);
    if (g_app.job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(g_app.job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
            AppendNativeLog(L"Warning: SetInformationJobObject failed.");
        }
    } else {
        AppendNativeLog(L"Warning: CreateJobObjectW failed; child processes may not auto-terminate.");
    }

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE stdoutWrite = nullptr;
    if (!CreatePipe(&g_app.stdoutRead, &stdoutWrite, &sa, 0)) return false;
    SetHandleInformation(g_app.stdoutRead, HANDLE_FLAG_INHERIT, 0);

    HANDLE stdinRead = nullptr;
    if (!CreatePipe(&stdinRead, &g_app.stdinWrite, &sa, 0)) {
        CloseHandle(stdoutWrite);
        CloseHandle(g_app.stdoutRead);
        g_app.stdoutRead = nullptr;
        return false;
    }
    SetHandleInformation(g_app.stdinWrite, HANDLE_FLAG_INHERIT, 0);

    // Set environment variables for packaged mode + preferred stable port (8044, fallback 0) + resolved user data directory
    g_app.dataDir = GetDataDir();
    SetEnvironmentVariableW(L"PORT", L"auto");
    SetEnvironmentVariableW(L"OPEN_BROWSER", L"0");
    SetEnvironmentVariableW(L"TRACE_PACKAGED", L"1");
    SetEnvironmentVariableW(L"TRACE_DATA_DIR", g_app.dataDir.c_str());
    SetEnvironmentVariableW(L"TRACE_INSTALL_DIR", g_app.exeDir.c_str());
    SetEnvironmentVariableW(L"TRACE_HOST_PID", std::to_wstring(GetCurrentProcessId()).c_str());

    std::wstring cmd = L"\"" + nodeExe + L"\" \"" + serverMjs + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOEXW siEx{};
    siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    siEx.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    siEx.StartupInfo.wShowWindow = SW_HIDE;
    siEx.StartupInfo.hStdOutput = stdoutWrite;
    siEx.StartupInfo.hStdError = stdoutWrite;
    siEx.StartupInfo.hStdInput = stdinRead;

    // Restrict inherited handles to ONLY the two pipe ends node.exe needs (prevents grandchildren inheriting unrelated handles)
    HANDLE inheritHandles[2] = { stdoutWrite, stdinRead };
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    std::vector<BYTE> attrBuf(attrSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrList = attrSize
        ? reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data())
        : nullptr;
    bool hasAttrList = attrList && InitializeProcThreadAttributeList(attrList, 1, 0, &attrSize) &&
        UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritHandles, sizeof(inheritHandles), nullptr, nullptr);
    if (hasAttrList) {
        siEx.lpAttributeList = attrList;
    }

    PROCESS_INFORMATION pi{};
    DWORD flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | (hasAttrList ? EXTENDED_STARTUPINFO_PRESENT : 0);
    BOOL ok = CreateProcessW(
        FileExists(nodeExe) ? nodeExe.c_str() : nullptr,
        cmdBuf.data(), nullptr, nullptr, TRUE, flags, nullptr, g_app.exeDir.c_str(),
        &siEx.StartupInfo, &pi);

    if (attrList) {
        DeleteProcThreadAttributeList(attrList);
    }
    CloseHandle(stdoutWrite);
    CloseHandle(stdinRead);

    if (!ok) {
        CloseHandle(g_app.stdoutRead);
        g_app.stdoutRead = nullptr;
        CloseHandle(g_app.stdinWrite);
        g_app.stdinWrite = nullptr;
        MessageBoxW(g_app.hwnd, L"Failed to start Trace Node.js runtime (runtime\\node\\node.exe).", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return false;
    }

    if (g_app.job) {
        AssignProcessToJobObject(g_app.job, pi.hProcess);
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    g_app.nodeProcess = pi.hProcess;

    auto* wparams = new WatcherParams{ g_app.hwnd, g_app.stdoutRead, g_app.dataDir };
    g_app.watcherThread = CreateThread(nullptr, 0, BackendWatcherThread, wparams, 0, nullptr);
    if (!g_app.watcherThread) {
        delete wparams;
        AppendNativeLog(L"Failed to create BackendWatcherThread.");
        if (g_app.stdinWrite) { CloseHandle(g_app.stdinWrite); g_app.stdinWrite = nullptr; }
        if (g_app.stdoutRead) { CloseHandle(g_app.stdoutRead); g_app.stdoutRead = nullptr; }
        if (g_app.nodeProcess) {
            TerminateProcess(g_app.nodeProcess, 1);
            CloseHandle(g_app.nodeProcess);
            g_app.nodeProcess = nullptr;
        }
        MessageBoxW(g_app.hwnd, L"Failed to initialize Trace backend monitor thread.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return false;
    }
    return true;
}

static bool StartWebView2WithDir(const std::wstring& userData) {
    if (!g_app.createEnvFn) return false;
    CreateDirsRecursive(userData);
    auto* handler = new EnvironmentCompletedHandler();
    HRESULT hr = g_app.createEnvFn(nullptr, userData.c_str(), nullptr, handler);
    handler->Release();
    return SUCCEEDED(hr);
}

static void InitWebView2() {
    std::wstring loaderPath = g_app.exeDir + L"\\WebView2Loader.dll";
    HMODULE mod = FileExists(loaderPath)
        ? LoadLibraryExW(loaderPath.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        : nullptr;
    if (!mod) {
        AppendNativeLog(L"Missing WebView2Loader.dll beside Trace.exe.");
        MessageBoxW(g_app.hwnd, L"Missing WebView2Loader.dll beside Trace.exe.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        if (g_app.hwnd && IsWindow(g_app.hwnd)) DestroyWindow(g_app.hwnd);
        else PostQuitMessage(1);
        return;
    }
    g_app.createEnvFn = reinterpret_cast<CreateWebView2EnvFn>(
        GetProcAddress(mod, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!g_app.createEnvFn) {
        AppendNativeLog(L"Invalid WebView2Loader.dll (missing CreateCoreWebView2EnvironmentWithOptions).");
        MessageBoxW(g_app.hwnd, L"Invalid WebView2Loader.dll.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        if (g_app.hwnd && IsWindow(g_app.hwnd)) DestroyWindow(g_app.hwnd);
        else PostQuitMessage(1);
        return;
    }

    // GPU acceleration + zero throttling for smooth 60–144 FPS 3D WebGL2 & waveforms
    SetEnvironmentVariableW(
        L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        L"--enable-gpu-rasterization --enable-zero-copy --disable-background-timer-throttling --disable-renderer-backgrounding");

    std::wstring baseData = g_app.dataDir.empty() ? GetDataDir() : g_app.dataDir;
    PruneStaleSessionDirs(baseData);
    std::wstring userData = baseData + L"\\webview2";

    if (!StartWebView2WithDir(userData)) {
        g_app.wv2FallbackAttempted = true;
        std::wstring fallbackDir = baseData + L"\\webview2-session-" + std::to_wstring(GetCurrentProcessId());
        g_app.tempWebViewDir = fallbackDir;
        if (!StartWebView2WithDir(fallbackDir)) {
            AppendNativeLog(L"Could not start Microsoft Edge WebView2 (primary and fallback failed).");
            MessageBoxW(
                g_app.hwnd,
                L"Could not start Microsoft Edge WebView2.\n\nPlease install the Microsoft Edge WebView2 Runtime.",
                L"Trace FPGA Workbench",
                MB_OK | MB_ICONERROR);
            if (g_app.hwnd && IsWindow(g_app.hwnd)) DestroyWindow(g_app.hwnd);
            else PostQuitMessage(1);
        }
    }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_SIZE:
            ResizeWebView();
            return 0;
        case WM_DPICHANGED: {
            RECT* suggested = reinterpret_cast<RECT*>(lParam);
            SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                         suggested->right - suggested->left, suggested->bottom - suggested->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            ResizeWebView();
            return 0;
        }
        case WM_APP_BACKEND_READY: {
            auto* urlPtr = reinterpret_cast<std::wstring*>(lParam);
            if (urlPtr) {
                g_app.baseUrl = *urlPtr;
                delete urlPtr;
            }
            g_app.ready = true;
            NavigateIfReady();
            return 0;
        }
        case WM_APP_BACKEND_FAIL: {
            auto* errPtr = reinterpret_cast<std::wstring*>(lParam);
            std::wstring errMsg = errPtr ? *errPtr : L"Trace backend server exited before becoming ready.";
            delete errPtr;
            MessageBoxW(hwnd, errMsg.c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_CLOSE: {
            if (g_app.allowClose || g_app.closePending || !g_app.ready || !g_app.navigated || !g_app.webview) {
                KillTimer(hwnd, IDT_CLOSE_WATCHDOG);
                g_app.allowClose = true;
                DestroyWindow(hwnd);
                return 0;
            }
            g_app.closePending = true;
            SetTimer(hwnd, IDT_CLOSE_WATCHDOG, 2500, nullptr);
            auto* handler = new CloseScriptCompletedHandler();
            HRESULT hr = g_app.webview->ExecuteScript(
                L"window.__traceRequestClose ? (window.__traceRequestClose(), 1) : 0",
                handler);
            handler->Release();
            if (FAILED(hr)) {
                KillTimer(hwnd, IDT_CLOSE_WATCHDOG);
                g_app.closePending = false;
                g_app.allowClose = true;
                DestroyWindow(hwnd);
            }
            return 0;
        }
        case WM_TIMER: {
            if (wParam == IDT_CLOSE_WATCHDOG) {
                KillTimer(hwnd, IDT_CLOSE_WATCHDOG);
                g_app.closePending = false;
                g_app.allowClose = true;
                AppendNativeLog(L"WM_CLOSE ExecuteScript watchdog expired after 2500ms; forcing close.");
                DestroyWindow(hwnd);
                return 0;
            }
            return DefWindowProcW(hwnd, msg, wParam, lParam);
        }
        case WM_DESTROY:
            KillTimer(hwnd, IDT_CLOSE_WATCHDOG);
            g_app.hwnd = nullptr;
            if (g_app.controller) {
                g_app.controller->Close();
                g_app.controller->Release();
                g_app.controller = nullptr;
            }
            if (g_app.webview) {
                g_app.webview->Release();
                g_app.webview = nullptr;
            }
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

static void ParseCommandLineArgs() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return;
    for (int i = 1; i < argc; ++i) {
        std::wstring arg = argv[i];
        if (arg == L"--devtools") {
            g_app.devtools = true;
        } else if (arg == L"--query" && i + 1 < argc) {
            g_app.initialQuery = argv[++i];
            if (!g_app.initialQuery.empty() && g_app.initialQuery[0] != L'/' && g_app.initialQuery[0] != L'?') {
                g_app.initialQuery = L"/" + g_app.initialQuery;
            }
        } else if (!arg.empty() && arg[0] != L'-') {
            wchar_t full[MAX_PATH * 4] = {};
            DWORD n = GetFullPathNameW(arg.c_str(), MAX_PATH * 4, full, nullptr);
            std::wstring resolved = n ? std::wstring(full, n) : arg;
            g_app.initialQuery = L"/?openProject=" + UrlEncode(resolved);
        }
    }
    LocalFree(argv);
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int nCmdShow) {
    SetUnhandledExceptionFilter(TraceUnhandledExceptionFilter);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    // Named mutex pairs with Inno Setup AppMutex so installers detect running Trace instances
    g_app.appMutex = CreateMutexW(nullptr, FALSE, L"TraceFPGAWorkbenchMutex");

    wchar_t modPath[MAX_PATH * 4] = {};
    GetModuleFileNameW(nullptr, modPath, MAX_PATH * 4);
    g_app.exePath = modPath;
    size_t slash = g_app.exePath.find_last_of(L"\\/");
    g_app.exeDir = (slash != std::wstring::npos) ? g_app.exePath.substr(0, slash) : L".";

    ParseCommandLineArgs();

    HICON icon = LoadIconW(hInstance, MAKEINTRESOURCEW(IDI_APP_ICON));
    HBRUSH bgBrush = CreateSolidBrush(RGB(20, 24, 19)); // #141813 Trace dark surface

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hIcon = icon;
    wc.hIconSm = icon;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = bgBrush;
    wc.lpszClassName = L"TraceFPGAWorkbenchWindow";
    RegisterClassExW(&wc);

    RECT workArea{};
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0)) {
        workArea.left = 0;
        workArea.top = 0;
        workArea.right = GetSystemMetrics(SM_CXSCREEN);
        workArea.bottom = GetSystemMetrics(SM_CYSCREEN);
    }
    int workW = workArea.right - workArea.left;
    int workH = workArea.bottom - workArea.top;
    int winW = (workW >= 1600) ? 1440 : (int)(workW * 0.92);
    int winH = (workH >= 960)  ? 900  : (int)(workH * 0.92);
    if (winW > workW) winW = workW;
    if (winH > workH) winH = workH;
    int posX = workArea.left + (workW - winW) / 2;
    int posY = workArea.top + (workH - winH) / 2;

    g_app.hwnd = CreateWindowExW(
        0,
        wc.lpszClassName,
        L"Trace — FPGA Workbench",
        WS_OVERLAPPEDWINDOW,
        posX, posY, winW, winH,
        nullptr, nullptr, hInstance, nullptr);

    if (!g_app.hwnd) return 1;

    // Enable native Windows 10/11 dark titlebar
    BOOL useDark = TRUE;
    DwmSetWindowAttribute(g_app.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &useDark, sizeof(useDark));
    DwmSetWindowAttribute(g_app.hwnd, 19, &useDark, sizeof(useDark));

    int initialShow = (nCmdShow == SW_SHOWMINIMIZED || nCmdShow == SW_MINIMIZE || nCmdShow == SW_SHOWMINNOACTIVE)
        ? nCmdShow
        : SW_SHOWMAXIMIZED;
    ShowWindow(g_app.hwnd, initialShow);
    UpdateWindow(g_app.hwnd);
    BringToForeground(g_app.hwnd);

    if (!StartBackendServer()) {
        DestroyWindow(g_app.hwnd);
        return 1;
    }
    // Boot WebView2 in parallel with Node.js backend for minimal cold-start latency
    InitWebView2();

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // Signal graceful shutdown via stdin EOF so server.mjs flushes logs & archives latest.log -> YYYY-MM-DD.log
    if (g_app.stdinWrite) {
        CloseHandle(g_app.stdinWrite);
        g_app.stdinWrite = nullptr;
    }
    if (g_app.nodeProcess) {
        // Give server.mjs:shutdown() enough headroom (2000ms GHDL close + log archive) before Job termination
        WaitForSingleObject(g_app.nodeProcess, 2800);
        CloseHandle(g_app.nodeProcess);
        g_app.nodeProcess = nullptr;
    }
    // Hard safety net: forcibly terminate any stubborn child Node/ConPTY/GHDL processes via Job Object
    if (g_app.job) {
        TerminateJobObject(g_app.job, 0);
        CloseHandle(g_app.job);
        g_app.job = nullptr;
    }
    // Unblock BackendWatcherThread if any grandchild still held stdoutWrite briefly; never CloseHandle(stdoutRead) while blocked in ReadFile
    bool watcherExited = true;
    if (g_app.watcherThread) {
        if (WaitForSingleObject(g_app.watcherThread, 250) == WAIT_TIMEOUT) {
            CancelSynchronousIo(g_app.watcherThread);
            watcherExited = (WaitForSingleObject(g_app.watcherThread, 250) == WAIT_OBJECT_0);
        }
        CloseHandle(g_app.watcherThread);
        g_app.watcherThread = nullptr;
    }
    if (g_app.stdoutRead && watcherExited) {
        CloseHandle(g_app.stdoutRead);
        g_app.stdoutRead = nullptr;
    }
    if (g_app.appMutex) {
        CloseHandle(g_app.appMutex);
        g_app.appMutex = nullptr;
    }
    DeleteObject(bgBrush);
    CoUninitialize();
    if (!g_app.tempWebViewDir.empty()) {
        // Wait briefly for WebView2 browser process to release file locks on the fallback session profile
        if (g_app.browserPid != 0) {
            HANDLE hBrowser = OpenProcess(SYNCHRONIZE, FALSE, g_app.browserPid);
            if (hBrowser) {
                WaitForSingleObject(hBrowser, 1500);
                CloseHandle(hBrowser);
            }
        }
        DeleteDirBestEffort(g_app.tempWebViewDir);
    }
    ExitProcess(static_cast<UINT>(msg.wParam));
}
