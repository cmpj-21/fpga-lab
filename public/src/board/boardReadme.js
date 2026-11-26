import { BOARD, BOARD_PINOUT_GROUPS, BOARD_PARTS, PIN_NET } from './boardDef.js';

export const DEFAULT_BOARD_ID = 'rz-easyfpga-a2.2';

export const BOARD_CATALOG = [
  {
    id: 'rz-easyfpga-a2.2',
    label: `${BOARD.device.part} · ${BOARD.name}`,
    board: BOARD,
    pinoutGroups: BOARD_PINOUT_GROUPS,
    parts: BOARD_PARTS,
    pinNet: PIN_NET,
  },
];

export function getBoardSpec(boardId = DEFAULT_BOARD_ID) {
  return BOARD_CATALOG.find(b => b.id === boardId) || BOARD_CATALOG[0];
}

export function generateBoardReadme({
  projectName = 'fpga_lab',
  entity = 'fpga_lab',
  standard = '08',
  boardId = DEFAULT_BOARD_ID,
  assignments = [],
  files = [],
} = {}) {
  const spec = getBoardSpec(boardId);
  const { board, pinoutGroups, parts, pinNet } = spec;
  const dev = board.device;
  const stdLabel = standard === '93' ? 'VHDL-1993' : standard === '02' ? 'VHDL-2002' : 'VHDL-2008';

  const lines = [];
  lines.push(`# ${projectName}`);
  lines.push('');
  lines.push(`FPGA digital logic project targeting the **${board.name}** development board (${board.vendor}) with an Intel/Altera **${dev.family} \`${dev.part}\`** FPGA.`);
  lines.push('');

  // Project Summary
  lines.push('## Project Overview');
  lines.push('');
  lines.push('| Property | Value |');
  lines.push('|---|---|');
  lines.push(`| **Project Name** | \`${projectName}\` |`);
  lines.push(`| **Top-Level Entity** | \`${entity}\` |`);
  lines.push(`| **HDL Standard** | ${stdLabel} |`);
  lines.push(`| **Target Board** | ${board.name} (${board.vendor}) |`);
  lines.push(`| **FPGA Device** | \`${dev.part}\` (${dev.family}, ${dev.package}, Speed Grade ${dev.speed}) |`);
  lines.push(`| **FPGA Resources** | ${dev.logicElements.toLocaleString()} Logic Elements · ${dev.m9k} M9K RAM blocks · ${dev.pll} PLLs |`);
  lines.push(`| **System Clock** | ${board.clockMHz} MHz onboard crystal oscillator (\`PIN_23\`) |`);
  lines.push(`| **PCB Dimensions** | ${board.pcb.w} mm × ${board.pcb.h} mm × ${board.pcb.thickness} mm |`);
  if (files.length) {
    lines.push(`| **Project Files** | ${files.map(f => `\`${f}\``).join(', ')} |`);
  }
  lines.push('');

  // Onboard Hardware Modules
  const majorIcKeys = ['fpga', 'sdram', 'epcs', 'oscillator', 'eeprom', 'lm75', 'max232'];
  const majorIcs = majorIcKeys.map(k => parts[k]).filter(Boolean);
  if (majorIcs.length) {
    lines.push(`## ${board.name} — Onboard ICs & Hardware`);
    lines.push('');
    lines.push('| Component | Part / Designator | Category | Details |');
    lines.push('|---|---|---|---|');
    for (const ic of majorIcs) {
      lines.push(`| **${ic.title}** | \`${ic.part}\` | ${ic.category} | ${ic.note} |`);
    }
    lines.push('');
  }

  // Complete Pin Assignment Ground Truth
  lines.push(`## ${board.name} — Complete Pin Mapping Reference`);
  lines.push('');
  lines.push('> **Important Polarity Notes:**');
  lines.push('> - **Active-Low Inputs (`0` = pressed / ON, `1` = released / OFF):** `reset_btn` (`PIN_25`), tactile keys `s1`–`s4` (`PIN_88`–`PIN_91`), and 4-position DIP switches `DIP1`–`DIP4` (wired directly in parallel with `s1`–`s4` on the same pins `88`–`91`).');
  lines.push('> - **Active-Low Outputs (`0` = ON / lit, `1` = OFF / dark):** User LEDs `led1`–`led4` (`PIN_87`–`PIN_84`), 7-segment digit selects `dtube1`–`dtube4` (`PIN_133`, `135`, `136`, `137`), and 7-segment cathodes `seg_a`–`seg_g`, `seg_dp` (`PIN_128`, `121`, `125`, `129`, `132`, `126`, `124`, `127`).');
  lines.push('> - **Active-High Output (`1` = sound on):** Piezo buzzer `beep` (`PIN_110`). Drive with a square wave (e.g., 500 Hz–4 kHz) for audible tones.');
  lines.push('> - **Multiplexed 7-Segment Display:** All 4 digits share the 8 segment lines (`seg_a`..`seg_dp`). Scan `dtube1`–`dtube4` at ~1 kHz–4 kHz (e.g., 10–12 bit prescaler from the 50 MHz clock) for flicker-free persistence of vision.');
  lines.push('> - **VGA DB15 Port:** Physical DB15 pins are `PIN_101` (`vga_hs`), `PIN_103` (`vga_vs`), `PIN_104` (`vga_b`), `PIN_105` (`vga_g`), and `PIN_106` (`vga_r`).');
  lines.push('');

  for (const grp of pinoutGroups) {
    lines.push(`### ${grp.group}`);
    lines.push('');
    lines.push('| Quartus Pin | Canonical Net | Polarity / Type | Description |');
    lines.push('|---:|---|---|---|');
    for (const p of grp.pins) {
      lines.push(`| \`PIN_${p.pin}\` | \`${p.net}\` | ${p.polarity} | ${p.note} |`);
    }
    lines.push('');
  }

  // Initial / Active Pin Assignments if provided
  const validAssignments = (Array.isArray(assignments) ? assignments : [])
    .filter(pair => Array.isArray(pair) && pair[0] && pair[1]);
  if (validAssignments.length) {
    lines.push('## Initial Project Pin Assignments');
    lines.push('');
    lines.push('| Quartus Pin | Board Net | Assigned Port |');
    lines.push('|---:|---|---|');
    for (const [pin, port] of validAssignments) {
      const net = pinNet[Number(pin)] || '—';
      lines.push(`| \`PIN_${pin}\` | \`${net}\` | \`${port}\` |`);
    }
    lines.push('');
  }

  // Quartus QSF Reference Snippet
  lines.push('## Quartus `.qsf` Quick Reference');
  lines.push('');
  lines.push('```tcl');
  lines.push(`set_global_assignment -name FAMILY "${dev.family}"`);
  lines.push(`set_global_assignment -name DEVICE ${dev.part}`);
  lines.push(`set_global_assignment -name TOP_LEVEL_ENTITY ${entity}`);
  lines.push('# Example pin bindings (uncomment / rename ports to match your entity):');
  lines.push('# set_location_assignment PIN_23 -to clk');
  lines.push('# set_location_assignment PIN_25 -to reset_n');
  lines.push('# set_location_assignment PIN_88 -to s1');
  lines.push('# set_location_assignment PIN_87 -to led1');
  lines.push('# set_location_assignment PIN_110 -to beep');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push(`*Auto-generated by Trace FPGA Workbench for **${board.name}** (\`${dev.part}\`).*`);
  lines.push('');
  return lines.join('\n');
}
