import assert from 'node:assert/strict';
import { parseVcd } from '../public/src/sim/vcd.js';
import { parseQsf } from '../public/src/sim/qsf.js';
import { parseGenerics } from '../public/src/sim/generics.js';
import { UartReceiver } from '../public/src/sim/uart.js';
import { inspectBitstream } from '../public/src/sim/sof.js';

let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); console.log('ok ' + message); passed++; };
const fixture = `$date 0bad b101 fake #900 $end
$comment Values in metadata must never become events: 1! #20 $end
$timescale\n 10 ps\n$end
$scope module tb $end
$scope module dut $end
$var wire 4 ! data [4:7] $end
$var reg 4 ! alias[4:7] $end
$var wire 1 # led1 $end
$var real 64 % voltage $end
$upscope $end $upscope $end $enddefinitions $end
$dumpvars b1 ! 0# r1.25 % $end
#2 bX ! r10 %
#2 bZ !
#3 $dumpoff bX ! $end
#4 $dumpon b10 ! 1# $end`;
const parsed = parseVcd(fixture);
check(parsed.timescaleFs === 10000 && parsed.events.length === 4, 'multiline timescale, inline directives and same-time events parse');
check(parsed.vars[0].left === 4 && parsed.vars[0].right === 7 && parsed.vars[0].shortName === 'data', 'separate ascending range preserves declared indices');
check(parsed.aliases.get('!').length === 2, 'wire/reg aliases share their identifier');
check(parsed.events[0].changes[0].value === '0001', 'short binary values zero extend');
check(parsed.events[1].changes[0].value === 'XXXX' && parsed.events[1].changes.at(-1).value === 'ZZZZ', 'unknown and high impedance values extend to bus width');
check(parsed.events[1].changes[1].value.real === 10, 'real values remain decimal values');
check(parsed.events[2].t === 30000 && parsed.events[3].t === 40000, 'dump control directives do not reset time');
check(parsed.events[0].changes.length === 3, 'date/comment tokens cannot inject signal changes');
for (const [text, pattern, message] of [
  ['not vcd', /before/, 'rejects invalid VCD text'],
  [fixture + '\n#1', /nondecreasing/, 'rejects backwards time'],
  [fixture + '\n#900719925475', /exact/, 'rejects unsafe femtosecond timestamp conversion'],
  [fixture + '\n#5 1missing', /undeclared/, 'rejects undeclared signal identifiers'],
  [fixture + '\n#5 b11111 !', /Invalid VCD value/, 'rejects overwide vectors'],
  [fixture + '\n#5 rNaN %', /real value/, 'rejects nonfinite real data'],
  [fixture.replace('10 ps', '2 ns'), /timescale/, 'rejects invalid timescale multiplier'],
  [fixture.replace('[4:7]', '[7:0]'), /range/, 'rejects inconsistent range and width']
]) { assert.throws(() => parseVcd(text), pattern); check(true, message); }
const qsf = parseQsf(`set_global_assignment -name FAMILY "Cyclone IV E" # ignored
set_global_assignment -name TOP_LEVEL_ENTITY {dut}
set_global_assignment -name VHDL_FILE {folder/my # design.vhd} -library support
set_location_assignment PIN_87 -to {leds[4]} -comment "Output LED"
set_location_assignment -to "seven_seg[0]" PIN_128
set_location_assignment PIN_87 -to {leds[5]}
set_location_assignment PIN_88 \\\n -to {keys[4]}
`);
check(qsf.family === 'Cyclone IV E' && qsf.top === 'dut', 'QSF quotes and braced metadata are parsed without executing Tcl');
check(qsf.files[0].path === 'folder/my # design.vhd' && qsf.files[0].library === 'support', 'quoted file paths retain hashes, spaces and library names');
check(qsf.pins.find(p => p.pin === 87).target === 'leds[5]' && qsf.pins.find(p => p.pin === 128).target === 'seven_seg[0]', 'QSF option ordering and last assignment win');
check(qsf.pins.find(p => p.pin === 88).target === 'keys[4]', 'QSF line continuations parse');
assert.throws(() => parseQsf('set_location_assignment PIN_145 -to a'), /outside/); check(true, 'rejects pins outside physical package');
const generics = parseGenerics(`WIDTH=64, LABEL="hello, world", CHAR='a', FLAG=true, NEG=-2`);
check(generics.LABEL === 'hello, world' && generics.CHAR === "'a'" && generics.NEG === '-2', 'generic parser preserves quoted commas, characters and signed scalars');
assert.throws(() => parseGenerics('W=1,w=2'), /Duplicate/); check(true, 'duplicate generic names are rejected case-insensitively');
assert.throws(() => parseGenerics('LABEL="unfinished'), /Close/); check(true, 'unterminated generic strings are rejected');
const rx = new UartReceiver(), baud = 100000, period = 1e15 / baud, decoded = [];
let last = '1'; rx.sample(0, last, baud);
const send = (time, bit) => { if (bit !== last) { decoded.push(...rx.sample(time, bit, baud).bytes); last = bit; } };
for (const [i, byte] of [0x41,0,255].entries()) {
  const start = (1 + i * 11) * period; send(start, '0');
  for (let b = 0; b < 8; b++) send(start + (b + 1) * period, String((byte >> b) & 1));
  send(start + 9 * period, '1');
}
decoded.push(...rx.sample(40 * period, '1', baud).bytes);
check(decoded.join(',') === '65,0,255', 'UART reconstructs sparse transitions including all-zero and all-one bytes');
rx.reset(); rx.sample(0, '1', baud); rx.sample(period, '0', baud); rx.sample(1.2 * period, '1', baud);
check(rx.sample(15 * period, '1', baud).bytes.length === 0, 'UART rejects pulses shorter than the start-bit sample');
rx.reset(); rx.sample(0, '1', baud); rx.sample(period, '0', baud);
check(rx.sample(12 * period, '0', baud).errors.some(e => e.includes('framing')), 'UART reports a low stop bit instead of producing a false byte');
const wrong = await inspectBitstream(new TextEncoder().encode('Device: EP4CE22F17C6N'), 'different.sof');
check(!wrong.deviceMatch, 'bitstream metadata does not label every FPGA as a matching board');
console.log(`\n${passed} format checks passed`);
