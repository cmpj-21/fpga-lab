# AGENTS.md — Contributor & AI Agent Guidelines for Trace FPGA Workbench

Welcome to the **Trace FPGA Workbench** repository (`fpga-lab`). This file provides architectural context, hardware pin specifications, coding standards, and operational guidelines for any AI agent or human contributor working on this codebase.

---

## 1. Project Overview & Architecture

Trace FPGA Workbench is a browser-based virtual laboratory environment for simulating VHDL digital logic on an **RZ-EasyFPGA A2.2** development board (Intel/Altera Cyclone IV `EP4CE6E22C8N`).

### Core Architecture:
1. **Backend Server (`server.mjs`):** Lightweight Node.js HTTP server for static assets plus JSON APIs covering simulation, session state, logs, local HDL/library browsing, project files, `.qpf`/`.qsf` generation, VCD export, and the integrated terminal.
2. **Simulation Engine (`backend/engine.mjs`, `backend/rtlCompiler.mjs` & `backend/bridge.c`):**
   - Uses local **GHDL** (VHDL-93/2002/2008).
   - Dynamically compiles a native C VPI plugin (`bridge.c` $\rightarrow$ `bridge.vpi`) linked against `libghdlvpi`.
   - Can also synthesize GHDL output to Verilog and compile it into an ESM RTL stepper for high-frequency burst execution (`backend/rtlCompiler.mjs`). SDF-annotated runs remain on the GHDL/VPI path.
   - Spawns GHDL as a child process and communicates via bidirectional stdio pipes using a custom ASCII command protocol (`R <cycles> <halfPeriod> <clock> <inputs> [sample_stride]`, followed by one line per pending input $\rightarrow$ returns observable signal samples).
3. **Frontend Application (`public/`):**
   - **3D Interactive Model (`public/src/board/board3d.js`):** Three.js WebGL visualization of the PCB, 3D tactile push buttons, LEDs, and multiplexed 7-segment displays.
   - **Hardware Definitions (`public/src/board/boardDef.js`):** Net names, pin numbers, and component geometry.
   - **Logic Analyzer (`public/src/ui/waves.js`):** HTML5 Canvas waveform viewer with cursor time measurements, signal buses, Follow/Fit/Free viewport modes, and 64-sample level-of-detail binning.
   - **Audio Engine (`public/src/ui/audio.js`, `public/src/ui/buzzer-worklet.js`):** 48 kHz AudioWorklet PCM stream shaped by a modeled 12 mm buzzer transducer. Switch-click feedback has been removed; the remaining click sample is the Photo Studio shutter.
   - **IDE & Tooling (`public/src/ui/ide.js`, `public/src/ui/selects.js`, `public/src/ui/colorpicker.js`, `public/src/ui/themes.js`):** Disk-backed Project Explorer, editor, ConPTY terminal, custom themed selects/color pickers, 13 built-in themes, and the Settings & Theme Studio.

---

## 2. Core Contributor Rules (Strictly Enforced)

Any agent touching this repository must adhere to the following rules:

1. **Manual Build / Run Execution:**
   - **Do NOT automatically compile or run the application** unless explicitly instructed by the user. 
   - Always provide the user with the command lines and steps so they can execute them manually.
2. **Preserve Code Integrity:**
   - **Do NOT remove, refactor, or "simplify" working code logic** for brevity or aesthetic cleanliness. Original working code is sacred and must be preserved during feature additions and bug fixes.
3. **Respect Cellular Data & Storage Headroom:**
    - The user runs on a metered cellular connection and has limited disk space. Avoid introducing heavy multi-gigabyte build tools (such as Rust/Cargo/MSVC) when lightweight alternatives exist (e.g. the native Windows WebView2 host).
4. **Surgical Line Edits:**
   - Always use precise, targeted edits on existing configuration and source files.
5. **Git Discipline:**
   - Always execute `git add -A` and `git commit` for every significant change or fix. Ensure commit messages are concise and descriptive.
6. **Release Asset Discipline:**
   - Do not upload a duplicate source ZIP. GitHub automatically provides `Source code (zip)` and `Source code (tar.gz)` on tagged releases; release workflows upload only built artifacts.
7. **Documentation Paths:**
   - Never write machine-specific absolute paths in `README.md`, `TUTORIAL.md`, `AGENTS.md`, or packaging docs. Use paths relative to the repository root.

---

## 3. Hardware Pin Mapping Ground Truth (RZ-EasyFPGA A2.2)

The board model is strictly referenced against the physical **RZ-EasyFPGA A2.2 (EP4CE6)** schematic.

### Peripheral Truth Table:
| Component | Signal Net(s) | Pin(s) | Polarity / Notes |
|---|---|:---:|---|
| **Clock** | `clk` | **23** | 50 MHz onboard crystal oscillator |
| **Reset** | `reset_btn` | **25** | **Active-Low** (`0` = pressed, `1` = released) |
| **Tactile Keys** | `s1`, `s2`, `s3`, `s4` | **88, 89, 90, 91** | **Active-Low** (`0` = pressed, `1` = released) |
| **DIP Switches** | `s1`, `s2`, `s3`, `s4` (shared) | **88, 89, 90, 91** | **Active-Low** (`0` = ON / Grounded, `1` = OFF / Open). Wired in parallel with tactile keys S1–S4. |
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

### A. Femtosecond Timing & VCD History (Resolved):
* **Implementation:** Backend timing uses `BigInt` femtoseconds (`backend/engine.mjs`), so the old ~9 second JavaScript `Number` ceiling no longer applies. Live sessions keep a rolling in-memory VCD history (25,000 timestamps) and export on demand instead of continuously writing an unbounded disk file; a ~5 hour session ceiling remains in the frontend.

### B. Frame Delta Clamping (Resolved):
* **Implementation:** `public/src/main.js` clamps frame delta to `[0, 0.1]` and guards stepping with `cycles > 0`, preventing negative cycle counts.

### C. Touchpad & Waveform Gestures (Resolved):
* **Implementation:** `public/src/ui/waves.js` normalizes `DOM_DELTA_LINE` wheel deltas and applies exponential scaling for Ctrl/ pinch zoom gestures.

### D. Single Cursor Limitation (Hardware DIP Switch Controls vs. Artificial Latch Mode):
* **Architectural Decision:** Do **NOT** implement an artificial software "latch mode" for the tactile push buttons `S1`–`S4`.
* **Hardware Ground Truth:** On the physical RZ-EasyFPGA A2.2 schematic, tactile push buttons `S1`–`S4` are strictly momentary. The physical board provides hardware latching via the 4-position red DIP switch package (`dip_0`..`dip_3`), which is wired directly in parallel to the exact same FPGA pins: **88 (`s1`), 89 (`s2`), 90 (`s3`), 91 (`s4`)**.
* **Implementation:**
  1. Added 4 bi-stable toggle switch controls for the DIP levers (`1`–`4`) to the **BOARD I/O** toolbar with direct pointer interaction on the 3D DIP switch mesh (`onDip`) and `Alt+1..4` shortcuts.
  2. Tactile keys `S1`–`S4` remain purely momentary (press to ground `0`, release to spring back to `1`).
  3. When a DIP lever is toggled `ON`, it holds the shared net grounded (`0`); toggling it `OFF` opens the circuit (relying on the pull-up to `1`). If a DIP lever is `ON`, pressing the corresponding push button has no effect because the net is already shorted to ground.
  4. Animates the 3D DIP switch model dynamically via `board?.setDip(mask)` in `public/src/board/board3d.js` so the virtual 3D levers visually slide into position.

### E. Desktop Launching:
* **Current launcher:** `start.bat` sets `OPEN_BROWSER=1` and runs `node server.mjs`; the server opens the default browser with `cmd /c start` when that flag is set.
* **Packaged builds:** Use a lightweight native Win32/WebView2 host (`packaging/RELEASE.md`) instead of a heavy Rust/Tauri toolchain on metered data.

---

## 5. Documentation Maintenance Guidelines (`TUTORIAL.md` vs `#aboutDialog`)

Whenever making code modifications or feature enhancements, determine which documentation files require updates using this checklist:

| Trigger / Change Type | Document(s) to Update | Target Sections |
|---|---|---|
| **1. UI Controls & Gestures:** Added or changed buttons, sliders, shortcuts, or mouse/touchpad gestures. | **`TUTORIAL.md` only** | Section 3 (*Find your way around*), Section 7 (*Waveforms*), Section 15 (*Keyboard reference*). |
| **2. Hardware Pin Mappings:** Modified default pin assignments or board net names in `boardDef.js`. | **`TUTORIAL.md` only** | Section 6 (*Common reference mappings table*). |
| **3. Hard Limits & Resource Caps:** Altered session limits, VCD/waveform history caps, or the ~5 hour timing ceiling. | **BOTH `TUTORIAL.md` & `About` Dialog** | `TUTORIAL.md` Section 15 (*Practical limits*) AND `public/index.html` (`#aboutDialog` `<dt>Resource limits</dt>`). |
| **4. Engine Physics & Formats:** Added file extensions, vendor libraries (e.g. `altera_mf`), or peripheral models. | **`About` Dialog primarily** (+ `TUTORIAL.md` Sec 13) | `public/index.html` (`#aboutDialog` `<dt>Logic & timing</dt>` or `<dt>Not simulated</dt>`) AND `TUTORIAL.md` Section 13. |
| **5. Entry-Point Documentation:** Changed quick-start steps, requirements, or the supported test commands. | **`README.md` + `TUTORIAL.md`** | `README.md` overview/quick start/tests AND `TUTORIAL.md` Section 1 (*Launch the website*). |

---

## 6. Useful Commands for User Reference

Always provide these to the user for manual execution:

```powershell
# Start the local server from the repository root (start.bat also opens the default browser)
node server.mjs

# Run backend API and compiler tests
node test\api.mjs

# Run browser integration tests (hardcoded headless Chrome)
node test\browser.mjs

# Other focused suites
node test\engine.mjs
node test\formats.mjs
node test\importers.mjs
node test\native.mjs
node test\real.mjs
node test\server.mjs
node test\demo.mjs
```
