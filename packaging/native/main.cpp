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
#include <WebView2.h>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

static constexpr UINT WM_APP_BACKEND_READY = WM_APP + 1;
static constexpr UINT WM_APP_BACKEND_FAIL  = WM_APP + 2;
static constexpr int  IDI_APP_ICON         = 101;

using CreateWebView2EnvFn = HRESULT(STDAPICALLTYPE*)(
    PCWSTR browserExecutableFolder,
    PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* environmentCreatedHandler);

struct AppState {
    HWND hwnd = nullptr;
    HANDLE job = nullptr;
    HANDLE nodeProcess = nullptr;
    HANDLE stdoutRead = nullptr;
    ICoreWebView2Controller* controller = nullptr;
    ICoreWebView2* webview = nullptr;
    std::wstring exeDir;
    std::wstring exePath;
    std::wstring baseUrl;
    std::wstring initialQuery;
    std::wstring pendingError;
    bool devtools = false;
    bool ready = false;
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

static bool IsDirWritable(const std::wstring& dir) {
    CreateDirectoryW(dir.c_str(), nullptr);
    std::wstring probe = dir + L"\\.trace-write-test";
    HANDLE h = CreateFileW(probe.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    CloseHandle(h);
    return true;
}

static std::wstring GetDataDir() {
    // 1. Explicit TRACE_DATA_DIR (set by single-file portable stub or user)
    wchar_t envBuf[MAX_PATH * 4] = {};
    DWORD n = GetEnvironmentVariableW(L"TRACE_DATA_DIR", envBuf, MAX_PATH * 4);
    if (n > 0 && n < MAX_PATH * 4) {
        std::wstring d(envBuf, n);
        CreateDirectoryW(d.c_str(), nullptr);
        return d;
    }
    // 2. Portable folder mode (portable.mode marker or existing TraceData\ beside Trace.exe)
    std::wstring siblingData = g_app.exeDir + L"\\TraceData";
    if ((FileExists(g_app.exeDir + L"\\portable.mode") || DirExists(siblingData)) && IsDirWritable(siblingData)) {
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
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir;
}

static void ResizeWebView() {
    if (!g_app.controller || !g_app.hwnd) return;
    RECT rc{};
    GetClientRect(g_app.hwnd, &rc);
    g_app.controller->put_Bounds(rc);
}

static void SpawnNewWindowWithQuery(const std::wstring& query) {
    std::wstring cmd = L"\"" + g_app.exePath + L"\"";
    if (!query.empty()) {
        cmd += L" --query \"" + query + L"\"";
    }
    if (g_app.devtools) {
        cmd += L" --devtools";
    }
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    if (CreateProcessW(g_app.exePath.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE, 0, nullptr, g_app.exeDir.c_str(), &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

// ---------- Minimal COM Handlers (zero WRL dependency) ----------

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
            MessageBoxW(g_app.hwnd, L"Failed to initialize Microsoft Edge WebView2 controller.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
            PostQuitMessage(1);
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
        }

        ResizeWebView();
        g_app.controller->put_IsVisible(TRUE);

        if (g_app.webview && !g_app.baseUrl.empty()) {
            std::wstring target = g_app.baseUrl + g_app.initialQuery;
            g_app.webview->Navigate(target.c_str());
        }
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
            MessageBoxW(
                g_app.hwnd,
                L"Microsoft Edge WebView2 Runtime is required to run Trace FPGA Workbench.\n\n"
                L"Install the Evergreen WebView2 Runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
                L"Trace FPGA Workbench",
                MB_OK | MB_ICONERROR);
            PostQuitMessage(1);
            return result;
        }
        auto* handler = new ControllerCompletedHandler();
        env->CreateCoreWebView2Controller(g_app.hwnd, handler);
        handler->Release();
        return S_OK;
    }
};

// ---------- Backend Node.js Process Management ----------

static DWORD WINAPI BackendWatcherThread(LPVOID) {
    std::string buffer;
    char chunk[1024];
    DWORD bytesRead = 0;
    bool signaled = false;

    while (ReadFile(g_app.stdoutRead, chunk, sizeof(chunk) - 1, &bytesRead, nullptr) && bytesRead > 0) {
        chunk[bytesRead] = '\0';
        buffer.append(chunk, bytesRead);
        size_t pos = 0;
        while ((pos = buffer.find('\n')) != std::string::npos) {
            std::string line = buffer.substr(0, pos);
            buffer.erase(0, pos + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!signaled && line.rfind("TRACE_READY ", 0) == 0) {
                std::string url = line.substr(12);
                g_app.baseUrl = Utf8ToWide(url);
                signaled = true;
                PostMessageW(g_app.hwnd, WM_APP_BACKEND_READY, 0, 0);
            }
        }
    }
    if (!signaled) {
        g_app.pendingError = L"Trace backend server exited before becoming ready.\n\nCheck %LOCALAPPDATA%\\TraceFPGA\\logs\\latest.log for details.";
        PostMessageW(g_app.hwnd, WM_APP_BACKEND_FAIL, 0, 0);
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
        SetInformationJobObject(g_app.job, JobObjectExtendedLimitInformation, &info, sizeof(info));
    }

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE stdoutWrite = nullptr;
    if (!CreatePipe(&g_app.stdoutRead, &stdoutWrite, &sa, 0)) return false;
    SetHandleInformation(g_app.stdoutRead, HANDLE_FLAG_INHERIT, 0);

    // Set environment variables for packaged mode + ephemeral port + resolved user data directory
    std::wstring dataDir = GetDataDir();
    SetEnvironmentVariableW(L"PORT", L"0");
    SetEnvironmentVariableW(L"OPEN_BROWSER", L"0");
    SetEnvironmentVariableW(L"TRACE_PACKAGED", L"1");
    SetEnvironmentVariableW(L"TRACE_DATA_DIR", dataDir.c_str());

    std::wstring cmd = L"\"" + nodeExe + L"\" \"" + serverMjs + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = stdoutWrite;
    si.hStdError = stdoutWrite;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    PROCESS_INFORMATION pi{};
    DWORD flags = CREATE_NO_WINDOW | CREATE_SUSPENDED;
    BOOL ok = CreateProcessW(
        FileExists(nodeExe) ? nodeExe.c_str() : nullptr,
        cmdBuf.data(), nullptr, nullptr, TRUE, flags, nullptr, g_app.exeDir.c_str(), &si, &pi);

    CloseHandle(stdoutWrite);

    if (!ok) {
        CloseHandle(g_app.stdoutRead);
        g_app.stdoutRead = nullptr;
        MessageBoxW(g_app.hwnd, L"Failed to start Trace Node.js runtime (runtime\\node\\node.exe).", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        return false;
    }

    if (g_app.job) {
        AssignProcessToJobObject(g_app.job, pi.hProcess);
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    g_app.nodeProcess = pi.hProcess;

    HANDLE thread = CreateThread(nullptr, 0, BackendWatcherThread, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
    return true;
}

static void InitWebView2() {
    std::wstring loaderPath = g_app.exeDir + L"\\WebView2Loader.dll";
    HMODULE mod = LoadLibraryW(FileExists(loaderPath) ? loaderPath.c_str() : L"WebView2Loader.dll");
    if (!mod) {
        MessageBoxW(g_app.hwnd, L"Missing WebView2Loader.dll beside Trace.exe.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        PostQuitMessage(1);
        return;
    }
    auto createEnv = reinterpret_cast<CreateWebView2EnvFn>(
        GetProcAddress(mod, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!createEnv) {
        MessageBoxW(g_app.hwnd, L"Invalid WebView2Loader.dll.", L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
        PostQuitMessage(1);
        return;
    }

    // GPU acceleration + zero throttling for smooth 60–144 FPS 3D WebGL2 & waveforms
    SetEnvironmentVariableW(
        L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        L"--enable-gpu-rasterization --enable-zero-copy --disable-background-timer-throttling --disable-renderer-backgrounding");

    std::wstring userData = GetDataDir() + L"\\webview2";
    CreateDirectoryW(userData.c_str(), nullptr);

    auto* handler = new EnvironmentCompletedHandler();
    HRESULT hr = createEnv(nullptr, userData.c_str(), nullptr, handler);
    handler->Release();
    if (FAILED(hr)) {
        MessageBoxW(
            g_app.hwnd,
            L"Could not start Microsoft Edge WebView2.\n\nPlease install the Microsoft Edge WebView2 Runtime.",
            L"Trace FPGA Workbench",
            MB_OK | MB_ICONERROR);
        PostQuitMessage(1);
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
        case WM_APP_BACKEND_READY:
            g_app.ready = true;
            if (g_app.webview) {
                std::wstring target = g_app.baseUrl + g_app.initialQuery;
                g_app.webview->Navigate(target.c_str());
            }
            return 0;
        case WM_APP_BACKEND_FAIL:
            MessageBoxW(hwnd, g_app.pendingError.c_str(), L"Trace FPGA Workbench", MB_OK | MB_ICONERROR);
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY:
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
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

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

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int winW = (screenW >= 1600) ? 1440 : (int)(screenW * 0.90);
    int winH = (screenH >= 960)  ? 900  : (int)(screenH * 0.88);
    int posX = (screenW - winW) / 2;
    int posY = (screenH - winH) / 2;

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

    ShowWindow(g_app.hwnd, nCmdShow);
    UpdateWindow(g_app.hwnd);

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

    // Cleanly terminate Node.js & any child GHDL processes via Job Object
    if (g_app.job) {
        CloseHandle(g_app.job);
        g_app.job = nullptr;
    }
    if (g_app.nodeProcess) {
        CloseHandle(g_app.nodeProcess);
        g_app.nodeProcess = nullptr;
    }
    if (g_app.stdoutRead) {
        CloseHandle(g_app.stdoutRead);
        g_app.stdoutRead = nullptr;
    }
    DeleteObject(bgBrush);
    CoUninitialize();
    return (int)msg.wParam;
}
