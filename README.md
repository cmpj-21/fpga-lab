# Trace FPGA Workbench

A local, browser-based virtual laboratory for VHDL digital logic targeting the RZ-EasyFPGA A2.2 board (Intel Cyclone IV EP4CE6E22C8N). It compiles and runs VHDL with GHDL, visualizes the result on an interactive 3D board, and provides a waveform analyzer, truth-table generator, UART monitor, and IDE-style project tools.

## Quick start

```powershell
node server.mjs
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

Run these manually from the repository root:

```powershell
node test\api.mjs
node test\browser.mjs
node test\engine.mjs
node test\formats.mjs
node test\importers.mjs
node test\native.mjs
node test\real.mjs
node test\server.mjs
node test\demo.mjs
```

The browser integration test launches headless Chrome from `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Documentation

- [TUTORIAL.md](TUTORIAL.md) - user guide and keyboard reference; also available from the app's Help menu.
- [AGENTS.md](AGENTS.md) - architecture, hardware pin truth table, contributor rules, and documentation-maintenance checklist.
- [packaging/RELEASE.md](packaging/RELEASE.md) - native Win32/WebView2 packaging notes.

## License and AI-generated disclosure

This project is released under the MIT License. See [LICENSE](LICENSE) for the full text.

Substantial portions of this codebase were generated with AI assistance and then reviewed, selected, integrated, and modified by Carlsam M. Puliran Jr. The copyright status of purely AI-generated material varies by jurisdiction; the MIT License is offered for the human-authored, curated, and modified parts of the project and for any rights the copyright holder has in the whole work. This disclosure is provided for transparency and is not legal advice.

Third-party libraries and assets retain their own licenses. Vendored Three.js and xterm.js files include their MIT/copyright notices in `public/vendor/`, and external tools such as GHDL are governed by their own terms.

Trace is a digital simulator and visualization tool, not a circuit solver. It does not model analog behavior, place-and-route timing, or program physical hardware. Always verify pin assignments and I/O standards against the board schematic before using real hardware.
