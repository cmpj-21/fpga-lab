# Trace FPGA Workbench

A local, browser-based virtual laboratory for VHDL digital logic targeting the RZ-EasyFPGA A2.2 board (Intel Cyclone IV EP4CE6E22C8N). It compiles and runs VHDL with GHDL, visualizes the result on an interactive 3D board, and provides a waveform analyzer, truth-table generator, UART monitor, and IDE-style project tools.

## Quick start

```powershell
node "C:\Users\cmpj\dev\fpga-lab\server.mjs"
```

Or double-click `start.bat`, which sets `OPEN_BROWSER=1` and starts the same server. Open <http://127.0.0.1:8044/> and use **File > Load Counter Demo** for a first run.

Requirements: Node.js, GHDL, a C compiler for the VPI bridge, and a modern browser with WebGL for the 3D board. Normal use is local and does not require an internet connection.

## Features

- GHDL VHDL-1993/2002/2008 simulation through a native VPI bridge.
- Compiled RTL fast path for high-frequency, non-SDF designs; SDF-annotated runs stay on the GHDL/VPI path.
- Rolling in-memory VCD history, on-demand VCD export, and read-only VCD replay.
- Interactive 3D RZ-EasyFPGA A2.2 board with momentary keys, latching DIP switches, LEDs, multiplexed seven-segment display, and buzzer.
- Waveform analyzer with Follow/Fit/Free viewport modes, level-of-detail binning, time cursors, and CSV/TSV/PSV signal export.
- Disk-backed Project Explorer, editor with VS Code-style shortcuts, native `.qpf`/`.qsf` project save, Quartus-style Pin Planner, and integrated ConPTY terminal.
- Truth-table generator, receive-only UART monitor, bitstream metadata inspector, 13 built-in UI themes plus a custom Theme Studio, and a graphics/FX suite for the board viewport.

## Tests

Run these manually from a terminal:

```powershell
node "C:\Users\cmpj\dev\fpga-lab\test\api.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\browser.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\engine.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\formats.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\importers.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\native.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\real.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\server.mjs"
node "C:\Users\cmpj\dev\fpga-lab\test\demo.mjs"
```

The browser integration test launches headless Chrome from `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Documentation

- [TUTORIAL.md](TUTORIAL.md) - user guide and keyboard reference; also available from the app's Help menu.
- [AGENTS.md](AGENTS.md) - architecture, hardware pin truth table, contributor rules, and documentation-maintenance checklist.
- [packaging/RELEASE.md](packaging/RELEASE.md) - native Win32/WebView2 packaging notes.

Trace is a digital simulator and visualization tool, not a circuit solver. It does not model analog behavior, place-and-route timing, or program physical hardware. Always verify pin assignments and I/O standards against the board schematic before using real hardware.
