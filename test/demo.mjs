import { elaborate } from '../public/src/sim/elab.js';
import { sl, is0, is1, valToString, arrIndex, L0, L1 } from '../public/src/sim/types.js';
import { DEMO_SRC, DEMO_TOP } from '../public/src/ui/demo.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const d = elaborate([{ name: 'bench_demo.vhd', text: DEMO_SRC }], DEMO_TOP);
ok(d.errors.length === 0, 'elaborate errors: ' + d.errors.join('; '));
ok(d.topName === 'bench_demo', 'top name');
const K = d.kernel;
const port = (n) => d.ports.find(p => p.name === n).sig;
const clk = port('clk');
const setIn = (n, v) => K.setEnvValue(port(n), sl(v));

// idle inputs: keys released (1), reset released (1)
['reset_btn', 's1', 's2', 's3', 's4'].forEach(n => setIn(n, L1));
setIn('clk', L0);
K.settle();

const cycle = () => {
  K.time += 5e8; K.setEnvValue(clk, sl(L1));
  K.time += 5e8; K.setEnvValue(clk, sl(L0));
};

// reset asserted -> count zero
setIn('reset_btn', L0); cycle(); setIn('reset_btn', L1);
const countSig = K.signals.get('bench_demo.count');
ok(valToString(countSig.value) === '000000000000000000000000', 'count zero after reset, got ' + valToString(countSig.value));

// enable (s1=0) and run 300 cycles
setIn('s1', L0);
for (let i = 0; i < 300; i++) cycle();
const cv = valToString(countSig.value);
const num = parseInt(cv, 2);
ok(num === 300, 'count == 300 after 300 enabled cycles, got ' + num);

// LEDs drive active-low: led1 <= not count(16). 300 < 65536 so bit16=0 -> led1='1' (off)
ok(is1(port('led1').value.v), 'led1 = not bit16 = 1, got ' + valToString(port('led1').value));

// hold (s1=1) -> count frozen
setIn('s1', L1);
for (let i = 0; i < 50; i++) cycle();
ok(parseInt(valToString(countSig.value), 2) === 300, 'count holds when disabled');

// seven_seg is a valid 8-bit vector (no U)
const seg = valToString(port('seven_seg').value);
ok(seg.length === 8 && !/[UXZ]/.test(seg), 'seven_seg defined: ' + seg);

// exactly one dtube enabled at a time (one-hot active low)
const dt = ['dtube1', 'dtube2', 'dtube3', 'dtube4'].map(n => port(n).value.v);
const enabledCount = dt.filter(v => is0(v)).length;
ok(enabledCount === 1, 'one digit enabled, got ' + enabledCount);

// run to overflow of low byte -> beep high at count low byte == FF
setIn('s1', L0);
let sawBeep = false;
for (let i = 0; i < 300; i++) { cycle(); if (is1(port('beep').value.v)) sawBeep = true; }
ok(sawBeep, 'beep asserted at low-byte overflow');

// s2 clears low byte
setIn('s2', L0); cycle(); setIn('s2', L1);
const lowByte = valToString(countSig.value).slice(16);
ok(lowByte === '00000000', 's2 clears low byte, got ' + lowByte);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);