import fs from 'node:fs';
import path from 'node:path';
import { elaborate } from '../public/src/sim/elab.js';
import { sl, slvFromString, valToString, L0, L1, int } from '../public/src/sim/types.js';

const HDL = 'C:\\Users\\cmpj\\dev\\HDL';
const load = (rel) => fs.readFileSync(path.join(HDL, rel), 'utf8');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n} ${x}`); } };

function sim(rel, top) {
  const d = elaborate([{ name: rel, text: load(rel) }], top);
  if (d.errors.length) console.log('  elab errors:', d.errors);
  d.kernel.settle();
  return d;
}
const setIn = (d, n, v) => { const p = d.ports.find(p => p.name === n); if (!p) throw new Error('no port ' + n); d.kernel.setEnvValue(p.sig, v); };
const out = (d, n) => d.ports.find(p => p.name === n).sig.value;
const outs = (d, n) => valToString(out(d, n));
const bit = (b) => sl(b ? L1 : L0);

console.log('Activity_3 (y = c)');
{
  const d = sim('VHDL/Lessons/activity-3/Activity_3.vhd', 'activity_3');
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    setIn(d, 'a', bit(a)); setIn(d, 'b', bit(b)); setIn(d, 'c', bit(c));
    check(`abc=${a}${b}${c} y=${c}`, outs(d, 'y') === String(c), outs(d, 'y'));
  }
}

console.log('Activity_4 (Y_A=!A&(B|C), Y_B=A&(B|C))');
{
  const d = sim('VHDL/Lessons/activity-4/Activity_4.vhd', 'activity_4');
  const rows = [[0,0,0],[0,0,1],[0,1,0],[0,1,1],[1,0,0],[1,0,1],[1,1,0],[1,1,1]];
  rows.forEach(([a, b, c], i) => {
    setIn(d, 'a', bit(a)); setIn(d, 'b', bit(b)); setIn(d, 'c', bit(c));
    const ea = (!a && (b || c)) ? 1 : 0, eb = (a && (b || c)) ? 1 : 0;
    check(`row${i} Y_A`, outs(d, 'y_a') === String(ea), `${outs(d,'y_a')} want ${ea}`);
    check(`row${i} Y_B`, outs(d, 'y_b') === String(eb), `${outs(d,'y_b')} want ${eb}`);
  });
}

console.log('half_adder_dataflow');
{
  const d = sim('VHDL/Lessons/half-adder/half-adder_dataflow.vhd', 'half_adder_dataflow');
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    setIn(d, 'a', bit(a)); setIn(d, 'b', bit(b));
    check(`S ${a}${b}`, outs(d, 's') === String(a ^ b), outs(d, 's'));
    check(`C ${a}${b}`, outs(d, 'c') === String(a & b), outs(d, 'c'));
  }
}

console.log('full_adder_dataflow');
{
  const d = sim('VHDL/Lessons/full-adder/full-adder_dataflow.vhd', 'full_adder_dataflow');
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let ci = 0; ci < 2; ci++) {
    setIn(d, 'a', bit(a)); setIn(d, 'b', bit(b)); setIn(d, 'ci', bit(ci));
    const s = a ^ b ^ ci, co = (a & b) | ((a ^ b) & ci);
    check(`S ${a}${b}${ci}`, outs(d, 's') === String(s), outs(d, 's'));
    check(`Co ${a}${b}${ci}`, outs(d, 'co') === String(co), outs(d, 'co'));
  }
}

console.log('practicum1 (C=R|W, L=S|(R&W))');
{
  const d = sim('VHDL/Lessons/PRACTICUM-1/practicum1.vhd', 'practicum1');
  for (let r = 0; r < 2; r++) for (let w = 0; w < 2; w++) for (let s = 0; s < 2; s++) {
    setIn(d, 'r', bit(r)); setIn(d, 'w', bit(w)); setIn(d, 's', bit(s));
    check(`C ${r}${w}${s}`, outs(d, 'c') === String(r | w), outs(d, 'c'));
    check(`L ${r}${w}${s}`, outs(d, 'l') === String(s | (r & w)), outs(d, 'l'));
  }
}

console.log('and_or_gate (g=(a&b)|(d&e))');
{
  const d = sim('VHDL/Lessons/and-or-gate/and_or_gate.vhd', 'and_or_gate');
  for (let m = 0; m < 16; m++) {
    const a = m & 1, b = (m >> 1) & 1, dd = (m >> 2) & 1, e = (m >> 3) & 1;
    setIn(d, 'a', bit(a)); setIn(d, 'b', bit(b)); setIn(d, 'd', bit(dd)); setIn(d, 'e', bit(e));
    check(`g ${m}`, outs(d, 'g') === String((a & b) | (dd & e)), outs(d, 'g'));
  }
}

console.log('always_one');
{
  const d = sim('VHDL/Lessons/always-one/always_one.vhd', 'always_one');
  setIn(d, 'a', bit(0)); setIn(d, 'b', bit(1)); setIn(d, 'c', bit(0));
  check('y=1', outs(d, 'y') === '1', outs(d, 'y'));
}

console.log('d_flipflop');
{
  const d = sim('VHDL/Lessons/d_flipflop/d_flipflop.vhd', 'd_flipflop');
  setIn(d, 'clk', bit(0)); setIn(d, 'reset', bit(1)); setIn(d, 'd', bit(1));
  check('reset q=0', outs(d, 'q') === '0', outs(d, 'q'));
  setIn(d, 'reset', bit(0)); setIn(d, 'clk', bit(1));
  check('capture d=1', outs(d, 'q') === '1', outs(d, 'q'));
  setIn(d, 'clk', bit(0)); setIn(d, 'd', bit(0)); setIn(d, 'clk', bit(1));
  check('capture d=0', outs(d, 'q') === '0', outs(d, 'q'));
}

console.log('parity_checker');
{
  const d = sim('VHDL/Lessons/midterm/parity_checker.vhd', 'parity_checker');
  setIn(d, 'clk', bit(0)); setIn(d, 'rst', bit(1));
  setIn(d, 'a', bit(1)); setIn(d, 'b', bit(1)); setIn(d, 'c', bit(1));
  check('d=1 xor 1 xor 1 = 1', outs(d, 'd') === '1', outs(d, 'd'));
  setIn(d, 'clk', bit(1));
  check('reset q=0', outs(d, 'q') === '0', outs(d, 'q'));
  check('q_not=1', outs(d, 'q_not') === '1', outs(d, 'q_not'));
  setIn(d, 'rst', bit(0)); setIn(d, 'clk', bit(0)); setIn(d, 'clk', bit(1));
  check('q<=d=1', outs(d, 'q') === '1', outs(d, 'q'));
  check('q_not=0', outs(d, 'q_not') === '0', outs(d, 'q_not'));
}

console.log('jk_up_counter (EN=Up=Mode=1)');
{
  const d = sim('VHDL/Lessons/JK-FLIPFLOP/jk_up_counter.vhd', 'jk_up_counter');
  setIn(d, 'clk', bit(0)); setIn(d, 'reset', bit(1));
  setIn(d, 'en', bit(1)); setIn(d, 'up', bit(1)); setIn(d, 'mode', bit(1));
  setIn(d, 'clk', bit(1));
  check('reset 000', outs(d, 'q_out') === '000', outs(d, 'q_out'));
  setIn(d, 'reset', bit(0));
  const seq = ['001', '010', '011', '100', '101', '110', '111', '000'];
  seq.forEach((e, i) => {
    setIn(d, 'clk', bit(0)); setIn(d, 'clk', bit(1));
    check(`count ${e}`, outs(d, 'q_out') === e, outs(d, 'q_out'));
    check(`Y carry ${e}`, outs(d, 'y') === (e === '111' ? '1' : '0'), outs(d, 'y'));
  });
  // disable counting
  setIn(d, 'en', bit(0));
  setIn(d, 'clk', bit(0)); setIn(d, 'clk', bit(1));
  check('hold when EN=0', outs(d, 'q_out') === '000', outs(d, 'q_out'));
}

console.log('sevseg (expected: out-of-bounds seven_seg(4..6) on (3 downto 0))');
{
  const d = sim('VHDL/Lessons/7 segment/sevseg.vhd', 'sevseg');
  setIn(d, 's1', bit(0)); setIn(d, 's2', bit(0)); setIn(d, 's3', bit(0)); setIn(d, 's4', bit(0));
  const boundsErr = d.kernel.log.some(l => /out of bounds/.test(l.msg)) || d.kernel.errors.some(e => /out of bounds/.test(e));
  check('bounds error surfaced', boundsErr, JSON.stringify(d.kernel.log));
  check('sim halted on fatal bounds error', d.kernel.stopped === true, d.kernel.stopReason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);