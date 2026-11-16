import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { compileDesign, sessions } from '../backend/engine.mjs';
import { DEMO_SRC } from '../public/src/ui/demo.js';
import { parseVcd } from '../public/src/sim/vcd.js';
import { hexOf } from '../public/src/ui/waves.js';

let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed++; console.log(`ok ${message}`); };
async function design(text, top = 'dut', extras = {}) { return compileDesign({ sources: [{ name: 'dut.vhd', text }], top, ...extras }); }
const id = (d, name) => d.signals.find(s => s.name === `${d.top}.${name}`).id;
const value = (d, result, name) => result.samples.at(-1).values[id(d, name)];
const inputs = (d, values) => Object.entries(values).map(([name, val]) => ({ id: id(d, name), value: val }));
try {
  const demo = await design(DEMO_SRC, 'bench_demo'); const engine = sessions.get(demo.id);
  check(demo.backend.startsWith('GHDL 6'), 'real GHDL backend identified');
  const idle = { clk: '0', reset_btn: '1', s1: '1', s2: '1', s3: '1', s4: '1' };
  let result = await engine.step({ cycles: 0, inputs: inputs(demo, idle) });
  check(value(demo, result, 'clk') === '0' && value(demo, result, 's1') === '1', 'binary input levels are not U or X');
  check(result.samples.at(-1).time === '0', 'input delta settling consumes zero physical time');
  result = await engine.step({ cycles: 300, halfPeriod: '10000000', clock: id(demo, 'clk'), inputs: inputs(demo, { s1: '0' }) });
  check(BigInt('0b' + value(demo, result, 'count')) === 300n, '300 native rising edges produce count 300');
  check(result.samples.at(-1).time === '6000000000', '300 cycles at 50 MHz advance exactly 6 us');
  check(result.samples.some(s => s.values[id(demo, 'clk')] === '1') && result.samples.some(s => s.values[id(demo, 'clk')] === '0'), 'both clock edges captured');
  check(new Set(result.samples.map(s => s.values[id(demo, 'scan')])).size === 4, 'all four multiplex phases captured');
  check(result.samples.every(s => ['dtube1','dtube2','dtube3','dtube4'].filter(n => s.values[id(demo,n)] === '0').length === 1), 'active-low one-hot digit selection');
  result = await engine.step({ cycles: 20, halfPeriod: '10000000', clock: id(demo, 'clk'), inputs: inputs(demo, { s1: '1' }) });
  check(BigInt('0b' + value(demo, result, 'count')) === 300n, 'released enable holds state');
  result = await engine.step({ cycles: 1, halfPeriod: '10000000', clock: id(demo, 'clk'), inputs: inputs(demo, { s3: '0' }) });
  check(BigInt('0b' + value(demo, result, 'count')) === 299n, 'S3 decrements');
  result = await engine.step({ cycles: 0, inputs: inputs(demo, { s3: '1', s4: '0' }) });
  check(value(demo, result, 'seven_seg') === '10000000', 'lamp test lights seven segments, not decimal point');
  check(['led1','led2','led3','led4'].every(n => value(demo,result,n) === '0'), 'lamp test drives all active-low LEDs');
  result = await engine.step({ cycles: 1, halfPeriod: '10000000', clock: id(demo, 'clk'), inputs: inputs(demo, { reset_btn: '0' }) });
  check(/^0+$/.test(value(demo,result,'count')), 'synchronous active-low reset clears counter');
  await assert.rejects(engine.step({ inputs: [{ id: id(demo,'led1'), value: '1' }] }), /Only input/); passed++;
  const vcd = await engine.exportVcd();
  check(vcd.includes('$enddefinitions'), 'native VCD exported');
  const parsed = parseVcd(vcd); check(parsed.events.length > 600, 'native VCD retains edge history');
  check(parsed.events.at(-1).t === Number(result.samples.at(-1).time), 'native VCD includes the final paused timestamp');
  await engine.close();

  const arithmetic = await design(`library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity dut is generic (W: positive := 64); port(a,b: in unsigned(W-1 downto 0); total: out unsigned(W-1 downto 0); signed_sum: out signed(W-1 downto 0)); end;
architecture rtl of dut is begin total <= a + b; signed_sum <= signed(a) + signed(b); end;`, 'dut', { generics: { W: '64' } });
  const aEngine = sessions.get(arithmetic.id);
  result = await aEngine.step({ cycles: 0, inputs: inputs(arithmetic, { a: '1'.repeat(64), b: '0'.repeat(63) + '1' }) });
  check(value(arithmetic,result,'total') === '0'.repeat(64), '64-bit unsigned overflow wraps exactly');
  check(value(arithmetic,result,'signed_sum') === '0'.repeat(64), 'signed -1 + 1 equals zero');
  result = await aEngine.step({ cycles: 0, inputs: inputs(arithmetic, { a: '1' + '0'.repeat(63), b: '0'.repeat(62) + '11' }) });
  check(BigInt('0b'+value(arithmetic,result,'total')) === 9223372036854775811n, 'integer arithmetic beyond JavaScript safe range remains exact');
  await aEngine.close();

  const timed = await design(`library ieee; use ieee.std_logic_1164.all;
entity dut is port(a: in std_logic; y: out std_logic); end;
architecture rtl of dut is begin y <= transport not a after 3 ns; end;`);
  const tEngine = sessions.get(timed.id);
  result = await tEngine.step({ cycles: 1, halfPeriod: '5000000', inputs: inputs(timed,{a:'0'}) });
  check(result.samples.some(s => s.time === '3000000' && s.values[id(timed,'y')] === '1'), '3 ns delayed event captured between sampling boundaries');
  check(result.samples.at(-1).time === '10000000', 'unclocked run advances requested time exactly');
  await tEngine.close();

  const logic = await design(`library ieee; use ieee.std_logic_1164.all;
entity dut is port(a,b: in std_logic; y: out std_logic); end;
architecture rtl of dut is begin y <= a and b; end;`);
  const lEngine = sessions.get(logic.id);
  for (const [a,b,y] of [['0','X','0'],['1','X','X'],['H','L','0'],['Z','1','X']]) {
    result = await lEngine.step({ cycles:0, inputs:inputs(logic,{a,b}) }); check(value(logic,result,'y') === y, `IEEE std_logic ${a} AND ${b} = ${y}`);
  }
  await lEngine.close();

  const tb = await design(`entity dut is end; architecture test of dut is signal clk: bit := '0'; begin
process begin wait for 5 ns; clk <= '1'; wait for 5 ns; report "native testbench complete"; wait; end process; end;`);
  result = await sessions.get(tb.id).step({ cycles: 1, halfPeriod: '6000000' });
  check(result.logs.some(l => l.includes('native testbench complete')), 'real VHDL wait/report testbench executes');
  await sessions.get(tb.id).close();
  await assert.rejects(design('entity dut is invalid syntax; end;'), /error|expected|missing|object|unexpected/i); passed++;
  await assert.rejects(design(`entity dut is end; architecture rtl of dut is begin process begin wait for 1 ns; assert false report "golden failure" severity failure; wait; end process; end;`).then(async d => { try { await sessions.get(d.id).step({cycles:1,halfPeriod:'2000000'}); } finally { await sessions.get(d.id)?.close(); } }), /golden failure/); passed++;
  check(hexOf('101') === '5' && hexOf('10000') === '10' && hexOf('1'.repeat(64)) === 'FFFFFFFFFFFFFFFF', 'waveform hexadecimal conversion is exact for non-nibble and wide vectors');
  for (const action of ['finish', 'stop']) {
    const done = await design(`library std; use std.env.all; entity dut is end; architecture test of dut is signal x: bit := '0'; begin process begin wait for 3 ns; x <= '1'; wait for 1 ns; ${action}; wait; end process; end;`);
    const engine = sessions.get(done.id);
    const result = await engine.step({ cycles: 1, halfPeriod: '5000000' });
    check(result.ended && result.samples.at(-1).time === '4000000', `std.env.${action} completes normally at its exact final timestamp`);
    const trace = await engine.exportVcd();
    check(parseVcd(trace).events.at(-1).t === 4000000, `${action} preserves an exportable final waveform`);
  }
  const immediate = await design('library std; use std.env.all; entity dut is end; architecture test of dut is begin process begin finish; wait; end process; end;');
  check(immediate.ended, 'time-zero finish returns a completed design'); await sessions.get(immediate.id).close();
  const library = await compileDesign({ sources: [
    { name: 'TOP.VHD', text: 'library lib; use lib.defs.all; entity dut is port(y: out bit); end; architecture rtl of dut is begin y <= answer; end;', library: 'MAIN' },
    { name: 'defs.vhd', text: "package defs is constant answer: bit := '1'; end;", library: 'LIB' }
  ], top: 'dut', topLibrary: 'MAIN', standard: '93' });
  check(value(library, library, 'y') === '1', 'out-of-order sources and named top/dependency libraries compile'); await sessions.get(library.id).close();
  const cfSource = 'entity dut is port(y: out bit); end; architecture rtl of dut is begin y <= \'1\'; end;';
  const cf = await compileDesign({ top: 'dut', sources: [{ name: 'dut.vhd', text: cfSource }, { name: 'WORK-OBJ08.CF', text: 'v 4\nfile . "dut.vhd" "old-hash" "old-time":\n' }] });
  check(value(cf, cf, 'y') === '1' && cf.diagnostics.some(d => d.includes('recompiling')), 'uppercase CF indexes safely rebuild accompanying sources'); await sessions.get(cf.id).close();
  await assert.rejects(compileDesign({ sources: [{ name: 'work-obj08.cf', text: 'v 4\nfile . "missing.vhd" "hash" "time":\n' }] }), /referenced sources.*missing.vhd/); passed++;
  const hierarchy = await compileDesign({ top: 'dut', sources: [{ name: 'nested.vhd', text: `entity child is port(a: in bit; y: out bit); end; architecture rtl of child is begin y <= a; end;
entity dut is port(a: in bit; y: out bit); end; architecture rtl of dut is begin u: entity work.child port map(a,y); end;` }] });
  const childPort = hierarchy.signals.find(s => s.name === 'dut.u.a');
  check(childPort && !childPort.driveable, 'child input ports are not exposed as user-driveable top ports');
  await assert.rejects(sessions.get(hierarchy.id).step({ cycles: 0, inputs: [{ id: childPort.id, value: '1' }] }), /Only input/); passed++; await sessions.get(hierarchy.id).close();
  const data = await compileDesign({ top: 'dut', sources: [{ name: 'dut.vhd', text: `use std.textio.all; entity dut is port(y: out integer); end; architecture rtl of dut is begin process
file f: text open read_mode is "input data.txt"; variable l: line; variable n: integer;
begin readline(f,l); read(l,n); y <= n; wait; end process; end;` }, { name: 'input data.txt', text: '12345\n' }] });
  check(BigInt('0b' + value(data, data, 'y')) === 12345n, 'testbench reads supplied text data without executing it as HDL'); await sessions.get(data.id).close();
  const scalar = await design(`entity dut is generic(N: integer := 1; FLAG: boolean := false; LETTER: character := 'x'; LABEL_TEXT: string := "none"); port(y: out bit); end; architecture rtl of dut is begin y <= '1' when N=-2 and FLAG and LETTER='a' and LABEL_TEXT="hello, world" else '0'; end;`, 'dut', { generics: { N: -2, FLAG: true, LETTER: "'a'", LABEL_TEXT: 'hello, world' } });
  check(value(scalar, scalar, 'y') === '1', 'negative integer, boolean, character and quoted string generics execute natively'); await sessions.get(scalar.id).close();
  const phase = await design(`library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all; entity dut is port(clk: in std_logic := '1'; n: out unsigned(3 downto 0)); end; architecture rtl of dut is signal c: unsigned(3 downto 0) := (others=>'0'); begin process(clk) begin if rising_edge(clk) then c <= c+1; end if; end process; n <= c; end;`);
  const phaseEngine = sessions.get(phase.id), phaseResult = await phaseEngine.step({ cycles: 1, clock: id(phase,'clk'), halfPeriod: '10000000' });
  check(value(phase,phaseResult,'n') === '0001' && value(phase,phaseResult,'clk') === '1', 'a clock starting high still produces a full cycle and preserves phase'); await phaseEngine.close();
  const vital = `library ieee; use ieee.std_logic_1164.all; use ieee.vital_timing.all;
entity dut is generic(tipd_a: VitalDelayType01 := (0 ns, 0 ns)); port(a: in std_logic; y: out std_logic); attribute VITAL_LEVEL0 of dut: entity is true; end;
architecture rtl of dut is signal a_ipd: std_logic; begin VitalWireDelay(a_ipd, a, tipd_a); y <= a_ipd; end;`;
  const sdf = '(DELAYFILE (SDFVERSION "3.0") (DESIGN "dut") (TIMESCALE 1 ns) (CELL (CELLTYPE "dut") (INSTANCE) (DELAY (ABSOLUTE (PORT a (2:3:4) (2:3:4))))))';
  for (const [corner, ns] of [['min',2],['typ',3],['max',4]]) {
    const annotated = await design(vital, 'dut', { standard: '93', sdf: { text: sdf, instance: '/', corner } });
    const e = sessions.get(annotated.id), result = await e.step({ cycles: 1, halfPeriod: '5000000', inputs: inputs(annotated, { a: '1' }) });
    check(result.samples.some(s => s.time === String(ns * 1000000) && s.values[id(annotated, 'y')] === '1'), `SDF ${corner} corner produces exactly ${ns} ns VITAL input delay`);
    await e.close();
  }
  const held = await Promise.allSettled(Array.from({ length: 5 }, () => design(cfSource)));
  check(held.filter(r => r.status === 'fulfilled').length === 4 && held.some(r => r.status === 'rejected' && /open or compiling/.test(r.reason.message)), 'concurrent compilation cannot exceed four sessions');
  await Promise.all([...sessions.values()].map(s => s.close()));
  check(sessions.size === 0, 'all native processes disposed');
  console.log(`\n${passed} native checks passed`);
} finally { await Promise.all([...sessions.values()].map(s => s.close())); }
