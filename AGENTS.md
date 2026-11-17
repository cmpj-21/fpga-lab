# AGENTS.md — Contributor & AI Agent Guidelines for Trace FPGA Workbench

Welcome to the **Trace FPGA Workbench** repository (`fpga-lab`). This file provides architectural context, hardware pin specifications, coding standards, and operational guidelines for any AI agent or human contributor working on this codebase.

---

## 1. Project Overview & Architecture

Trace FPGA Workbench is a browser-based virtual laboratory environment for simulating VHDL digital logic on an **RZ-EasyFPGA A2.2** development board (Intel/Altera Cyclone IV `EP4CE6E22C8N`).

### Core Architecture:
1. **Backend Server (`server.mjs`):** Lightweight Node.js HTTP server providing static file serving and JSON API endpoints (`/api/sim/compile`, `/api/sim/:id/step`, `/api/sim/:id/vcd`).
2. **Simulation Engine (`backend/engine.mjs` & `backend/bridge.c`):** 
   - Uses local **GHDL** (VHDL-93/2002/2008).
   - Dynamically compiles a native C VPI plugin (`bridge.c` $\rightarrow$ `bridge.vpi`) linked against `libghdlvpi`.
   - Spawns GHDL as a child process and communicates via bidirectional stdio pipes using a custom ASCII command protocol (`R <cycles> <halfPeriod> <clock> <inputs>` $\rightarrow$ returns observable signal samples).
3. **Frontend Application (`public/`):**
   - **3D Interactive Model (`public/src/board/board3d.js`):** Three.js WebGL visualization of the PCB, 3D tactile push buttons, LEDs, and multiplexed 7-segment displays.
   - **Hardware Definitions (`public/src/board/boardDef.js`):** Net names, pin numbers, and component geometry.
   - **Logic Analyzer (`public/src/ui/waves.js`):** HTML5 Canvas waveform viewer with cursor time measurements and signal buses.
   - **Audio Engine (`public/src/ui/audio.js`):** Web Audio API synthesized feedback for switch clicks and buzzer tones.

---

## 2. Core Contributor Rules (Strictly Enforced)

Any agent touching this repository must adhere to the following rules:

1. **Manual Build / Run Execution:**
   - **Do NOT automatically compile or run the application** unless explicitly instructed by the user. 
   - Always provide the user with the command lines and steps so they can execute them manually.
2. **Preserve Code Integrity:**
   - **Do NOT remove, refactor, or "simplify" working code logic** for brevity or aesthetic cleanliness. Original working code is sacred and must be preserved during feature additions and bug fixes.
3. **Respect Cellular Data & Storage Headroom:**
   - The user runs on a metered cellular connection and has limited disk space. Avoid introducing heavy multi-gigabyte build tools (such as Rust/Cargo/MSVC) when lightweight alternatives exist (e.g. native Windows Edge app mode).
4. **Surgical Line Edits:**
   - Always use precise, targeted edits on existing configuration and source files.
5. **Git Discipline:**
   - Always execute `git add -A` and `git commit` for every significant change or fix. Ensure commit messages are concise and descriptive.

---

## 3. Hardware Pin Mapping Ground Truth (RZ-EasyFPGA A2.2)

The board model is strictly referenced against the physical **RZ-EasyFPGA A2.2 (EP4CE6)** schematic.

### Peripheral Truth Table:
| Component | Signal Net(s) | Pin(s) | Polarity / Notes |
|---|---|:---:|---|
| **Clock** | `clk` | **23** | 50 MHz onboard crystal oscillator |
| **Reset** | `reset_btn` | **25** | **Active-Low** (`0` = pressed, `1` = released) |
| **Tactile Keys** | `s1`, `s2`, `s3`, `s4` | **88, 89, 90, 91** | **Active-Low** (`0` = pressed, `1` = released) |
| **User LEDs** | `led1`, `led2`, `led3`, `led4` | **87, 86, 85, 84** | **Active-Low** (`0` = ON, `1` = OFF) |
| **7-Seg Digits** | `dtube1`, `dtube2`, `dtube3`, `dtube4` | **133, 135, 136, 137** | **Active-Low** (`0` = Enabled, `1` = Disabled) |
| **7-Seg Segments**| `seg_a`..`seg_g`, `seg_dp` | **128, 121, 125, 129, 132, 126, 124, 127** | **Active-Low** (`0` = Lit, `1` = Dark) |
| **Buzzer** | `beep` | **110** | **Active-High** (`1` = Sound on) |
| **UART Interface** | `uart_txd`, `uart_rxd` | **114, 115** | Serial comms (3.3V TTL) |
| **VGA DB15 Port** | `vga_hs`, `vga_vs`, `vga_b`, `vga_g`, `vga_r` | **101, 103, 104, 105, 106** | **Physical DB15 connector** *(Do not confuse with expansion header pins 142..144, 1..2 used in custom student projects like `SnakeGame.qsf`)* |
| **PS/2 Port** | `ps2_clk`, `ps2_data` | **119, 120** | Keyboard / Mouse interface |
| **I2C EEPROM** | `i2c_scl`, `i2c_sda` | **112, 113** | AT24C02 memory chip; the sheet's second `I2C_SCL`/`I2C_SDA` pair on 99/98 is a separate unmodeled header |
| **IR Receiver** | `ir_rx` | **100** | 38 kHz infrared demodulator; vendor sheet label `IR` is an alias, not a separate net |

The net names in this table are canonical. Vendor-sheet labels (such as `IR`) and alternate header pairs (99/98 I2C) are documentation aliases only; never add duplicate nets to `boardDef.js`.

---

## 4. Known Technical Challenges & Planned Roadmap

Before modifying simulation or timing code, review these known architectural considerations:

### A. The 9-Second / 53-Bit Integer Limit:
* **Issue:** GHDL uses 1 femtosecond ($10^{-15}\text{ s}$) resolution. JavaScript's `Number.MAX_SAFE_INTEGER` ($2^{53} - 1$) is reached at $\sim 9.007\text{ seconds}$ of simulated time.
* **Resolution Plan:** Keep femtosecond resolution using `BigInt` on the backend to avoid rounding sub-ns delays. Decouple continuous disk VCD dumping from live board stepping so the simulation can run continuously without hitting file size (64MB) or timestamp caps.

### B. Frame Delta Clamping:
* **Issue:** In `public/src/main.js`, `dt` can evaluate to a negative number if `lastFrame` is updated after the animation frame timestamp `now`, causing negative cycle steps (`advance(-1)`).
* **Fix:** Clamp `dt = Math.max(0, Math.min(0.1, ...))` and guard calls with `if (cycles > 0) advance(cycles);`.

### C. Touchpad & Waveform Gestures:
* **Issue:** Firefox reports wheel events in `DOM_DELTA_LINE` (`deltaMode === 1`), making touchpad panning crawl unless scaled by line height (~20px). Touchpad pinch-to-zoom emits `e.ctrlKey === true` and should use exponential scaling `Math.exp(-deltaPixels * 0.005)`.

### D. Single Cursor Limitation (Latch Mode):
* **Feature:** Provide a latch/toggle mode for keys `S1`–`S4` so mouse users can keep multiple buttons held down simultaneously (e.g. for multi-key lamp tests).

### E. Desktop Launching:
* **Recommendation:** Rather than downloading heavy Rust/Tauri toolchains on metered data, launch Edge in application mode (`msedge.exe --app="http://127.0.0.1:8044"`) inside [start.bat](file:///C:/Users/cmpj/dev/fpga-lab/start.bat).

---

## 5. Documentation Maintenance Guidelines (`TUTORIAL.md` vs `#aboutDialog`)

Whenever making code modifications or feature enhancements, determine which documentation files require updates using this 4-question checklist:

| Trigger / Change Type | Document(s) to Update | Target Sections |
|---|---|---|
| **1. UI Controls & Gestures:** Added or changed buttons, sliders, shortcuts, or mouse/touchpad gestures. | **`TUTORIAL.md` only** | Section 3 (*Find your way around*), Section 7 (*Waveforms*), Section 15 (*Keyboard reference*). |
| **2. Hardware Pin Mappings:** Modified default pin assignments or board net names in `boardDef.js`. | **`TUTORIAL.md` only** | Section 6 (*Common reference mappings table*). |
| **3. Hard Limits & Resource Caps:** Altered session limits, VCD buffer caps (64MB), or timing ceilings (9s limit). | **BOTH `TUTORIAL.md` & `About` Dialog** | `TUTORIAL.md` Section 15 (*Practical limits*) AND `public/index.html` (`#aboutDialog` `<dt>Resource limits</dt>`). |
| **4. Engine Physics & Formats:** Added file extensions, vendor libraries (e.g. `altera_mf`), or peripheral models. | **`About` Dialog primarily** (+ `TUTORIAL.md` Sec 13) | `public/index.html` (`#aboutDialog` `<dt>Logic & timing</dt>` or `<dt>Not simulated</dt>`) AND `TUTORIAL.md` Section 13. |

---

## 6. Useful Commands for User Reference

Always provide these to the user for manual execution:

```powershell
# Start the local server
node "C:\Users\cmpj\dev\fpga-lab\server.mjs"

# Run backend API and compiler tests
node "C:\Users\cmpj\dev\fpga-lab\test\api.mjs"

# Run browser integration tests (requires headless Firefox)
node "C:\Users\cmpj\dev\fpga-lab\test\browser.mjs"
```
