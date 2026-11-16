import fs from 'node:fs';
import { parseQsf, pinMap, busMap } from '../public/src/sim/qsf.js';
import { inspectBitstream } from '../public/src/sim/sof.js';
import { writeVcd, parseVcd, vcdValueToTyped } from '../public/src/sim/vcd.js';
import { parseVo, NetlistSim } from '../public/src/sim/netlist.js';
import { elaborate } from '../public/src/sim/elab.js';
import { sl, L0, L1, valToString, slvFromString } from '../public/src/sim/types.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n} ${x}`); } };

console.log('QSF: real SnakeGame.qsf fixture');
{
  const text = fs.readFileSync('research/SnakeGame.qsf', 'utf8');
  const q = parseQsf(text);
  check('family', q.family === 'Cyclone IV E', q.family);
  check('device', q.device === 'EP4CE6E22C8', q.device);
  check('top', q.top === 'SnakeGame', q.top);
  const pm = pinMap(q);
  check('clk PIN_23', pm.get('clk') === 23, String(pm.get('clk')));
  check('VGA_B PIN_144', pm.get('vga_b') === 144, String(pm.get('vga_b')));
  check('reset PIN_58', pm.get('reset') === 58, String(pm.get('reset')));
  check('sseg_an[3] PIN_133', pm.get('sseg_an[3]') === 133, String(pm.get('sseg_an[3]')));
  const bm = busMap(q);
  check('dir_out bus 2 bits', bm.get('dir_out') && bm.get('dir_out').length === 2, JSON.stringify(bm.get('dir_out')));
  check('sseg_a_to_dp bus 8 bits', bm.get('sseg_a_to_dp') && bm.get('sseg_a_to_dp').length === 8);
  check('verilog files parsed', q.files.filter(f => f.lang === 'verilog').length >= 8, String(q.files.length));
  check('EDA sim tool', q.globals.some(g => g.key === 'EDA_SIMULATION_TOOL' && /ModelSim/.test(g.value)));
}

console.log('SOF: synthetic bitstream inspection');
{
  const header = 'Quartus Prime Version 18.0.0 Build 614 04/24/2018 SJ Lite Edition\n'
    + 'Device: EP4CE6E22C8N\nDate: 2018/10/26\nCompression: ON\n';
  const payload = new Uint8Array(2048);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
  const headBytes = new TextEncoder().encode(header);
  const buf = new Uint8Array(headBytes.length + payload.length);
  buf.set(headBytes, 0); buf.set(payload, headBytes.length);
  const info = await inspectBitstream(buf, 'SnakeGame.sof');
  check('device detected', info.device === 'EP4CE6E22C8N', info.device);
  check('family', info.family === 'Cyclone IV E', info.family);
  check('version', /18\.0\.0/.test(info.version || ''), info.version);
  check('date', info.date === '2018/10/26', info.date);
  check('sha256 64 hex', /^[0-9a-f]{64}$/.test(info.sha256), info.sha256);
  check('kind sof', info.kind === 'sof');
  check('honest note present', /proprietary/i.test(info.note));
}

console.log('VCD: export from engine sim + reimport');
{
  const d = elaborate([{ name: 'c.vhd', text: `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity c is port(clk,rst: in std_logic; cnt: out std_logic_vector(3 downto 0)); end c;
architecture a of c is signal r: unsigned(3 downto 0) := (others=>'0');
begin process(clk) begin if rising_edge(clk) then if rst='1' then r<=(others=>'0'); else r<=r+1; end if; end if; end process;
cnt<=std_logic_vector(r); end a;` }], 'c');
  const clk = d.ports.find(p => p.name === 'clk').sig;
  const rst = d.ports.find(p => p.name === 'rst').sig;
  d.kernel.setEnvValue(clk, sl(L0)); d.kernel.setEnvValue(rst, sl(L1));
  const samples = [];
  const snap = () => { const values = new Map(); for (const [n, s] of d.kernel.signals) values.set(n, s.value); samples.push({ t: d.kernel.time, values }); };
  snap();
  d.kernel.setEnvValue(clk, sl(L1)); snap();
  d.kernel.setEnvValue(rst, sl(L0));
  for (let i = 0; i < 4; i++) {
    d.kernel.setEnvValue(clk, sl(L0)); d.kernel.setEnvValue(clk, sl(L1)); snap();
  }
  const vcd = writeVcd(d, samples, { timescale: '1ps' });
  check('vcd has definitions', vcd.includes('$enddefinitions'));
  check('vcd has cnt var', /\$var wire 4 \S+ cnt \$end/.test(vcd), vcd.split('\n').filter(l => l.includes('cnt')).join('|'));
  const parsed = parseVcd(vcd);
  check('reimport vars', parsed.vars.some(v => v.shortName === 'cnt'));
  const cntVar = parsed.vars.find(v => v.shortName === 'cnt');
  const lastEvent = [...parsed.events].reverse().find(e => e.changes.some(c => c.id === cntVar.id));
  const cntChanges = lastEvent.changes.filter(c => c.id === cntVar.id);
  const lastChange = cntChanges[cntChanges.length - 1];
  const typed = vcdValueToTyped(lastChange.value, 4);
  check('final count=4 (0100)', valToString(typed) === '0100', valToString(typed));
}

console.log('VO: gate-level netlist (registered AND)');
{
  // AND LUT: out=1 only at index 3 (a=1,b=1,c=0,d=0) -> mask bit12 set
  const vo = `
module test(a, b, clk, q);
input a, b, clk;
output q;
wire a_ib, b_ib, clk_ib, comb, q_ib;
cycloneive_io_ibuf \\a~input ( .i(a), .o(a_ib));
cycloneive_io_ibuf \\b~input ( .i(b), .o(b_ib));
cycloneive_io_ibuf \\clk~input ( .i(clk), .o(clk_ib));
cycloneive_lcell_comb \\and~0 ( .dataa(a_ib), .datab(b_ib), .datac(gnd), .datad(gnd), .combout(comb));
defparam \\and~0 .lut_mask = "0000000000001000";
defparam \\and~0 .sum_lutc_input = "datac";
cycloneive_ff \\q~reg0 ( .clk(clk_ib), .clrn(vcc), .prn(vcc), .ena(vcc), .d(comb), .q(q_ib));
defparam \\q~reg0 .power_up = "low";
cycloneive_io_obuf \\q~output ( .i(q_ib), .o(q));
endmodule
`;
  // Quartus writes params as defparam statements; parseVo folds them into cells.
  const nl = parseVo(vo);
  check('module name', nl.name === 'test', nl.name);
  check('cells parsed', nl.cells.length === 6, String(nl.cells.length));
  check('lut_mask captured', nl.cells.some(c => c.params.lut_mask === '0000000000001000'), JSON.stringify(nl.cells.map(c => c.params)));
  const sim = new NetlistSim(nl);
  sim.setInput('a', sl(L1)); sim.setInput('b', sl(L1)); sim.setInput('clk', sl(L0));
  sim.settle();
  sim.setInput('clk', sl(L1)); sim.settle();
  check('q=1 after clock (1 AND 1)', valToString(sim.getOutput('q')) === '1', valToString(sim.getOutput('q')));
  sim.setInput('clk', sl(L0)); sim.setInput('b', sl(L0)); sim.settle();
  sim.setInput('clk', sl(L1)); sim.settle();
  check('q=0 after clock (1 AND 0)', valToString(sim.getOutput('q')) === '0', valToString(sim.getOutput('q')));
  check('comb cell counted', sim.cellCount.comb === 1, JSON.stringify(sim.cellCount));
  check('ff cell counted', sim.cellCount.ff === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);