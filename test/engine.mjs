import { elaborate } from '../public/src/sim/elab.js';
import { sl, slvFromString, valToString, L0, L1, U, X, int } from '../public/src/sim/types.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}
function sim(src, top) {
  const d = elaborate([{ name: 't.vhd', text: src }], top);
  if (d.errors.length) console.log('  elaboration errors:', d.errors);
  d.kernel.settle();
  return d;
}
const setIn = (d, n, v) => { const p = d.ports.find(p => p.name === n); d.kernel.setEnvValue(p.sig, v); };
const out = (d, n) => d.ports.find(p => p.name === n).sig.value;
const outs = (d, n) => valToString(out(d, n));

console.log('T1 concurrent dataflow + golden vectors');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity t is port(A,B,C: in std_logic; y1,y2: out std_logic); end t;
architecture a of t is
begin
  y1 <= (not A) and (B or C);
  y2 <= A and (B or C);
end a;`, 't');
  const combos = [[0,0,0],[0,0,1],[0,1,0],[0,1,1],[1,0,0],[1,0,1],[1,1,0],[1,1,1]];
  const e1 = [0,1,1,1,0,0,0,0], e2 = [0,0,0,0,0,1,1,1];
  combos.forEach((c, i) => {
    setIn(d, 'a', sl(c[0] ? L1 : L0)); setIn(d, 'b', sl(c[1] ? L1 : L0)); setIn(d, 'c', sl(c[2] ? L1 : L0));
    check(`y1[${i}]`, outs(d, 'y1') === String(e1[i]), `got ${outs(d,'y1')} want ${e1[i]}`);
    check(`y2[${i}]`, outs(d, 'y2') === String(e2[i]), `got ${outs(d,'y2')} want ${e2[i]}`);
  });
}

console.log('T2 dff async reset + rising_edge');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity t is port(clk,reset,d: in std_logic; q: out std_logic); end t;
architecture a of t is
begin
  process(clk,reset)
  begin
    if reset='1' then q <= '0';
    elsif rising_edge(clk) then q <= d;
    end if;
  end process;
end a;`, 't');
  setIn(d, 'clk', sl(L0)); setIn(d, 'reset', sl(L1)); setIn(d, 'd', sl(L1));
  check('reset q=0', outs(d, 'q') === '0', outs(d, 'q'));
  setIn(d, 'reset', sl(L0));
  setIn(d, 'clk', sl(L1));
  check('rise q=d=1', outs(d, 'q') === '1', outs(d, 'q'));
  setIn(d, 'clk', sl(L0)); setIn(d, 'd', sl(L0));
  check('fall holds', outs(d, 'q') === '1', outs(d, 'q'));
  setIn(d, 'clk', sl(L1));
  check('rise q=0', outs(d, 'q') === '0', outs(d, 'q'));
}

console.log('T3 numeric_std counter + aggregate + resize');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is port(clk,rst: in std_logic; cnt: out std_logic_vector(7 downto 0)); end t;
architecture a of t is
  signal r : unsigned(7 downto 0) := (others => '0');
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if rst='1' then r <= (others => '0');
      else r <= r + 1;
      end if;
    end if;
  end process;
  cnt <= std_logic_vector(r);
end a;`, 't');
  setIn(d, 'clk', sl(L0)); setIn(d, 'rst', sl(L1));
  setIn(d, 'clk', sl(L1));
  check('reset cnt=0', outs(d, 'cnt') === '00000000', outs(d, 'cnt'));
  setIn(d, 'rst', sl(L0));
  for (let i = 0; i < 5; i++) { setIn(d, 'clk', sl(L0)); setIn(d, 'clk', sl(L1)); }
  check('count=5', outs(d, 'cnt') === '00000101', outs(d, 'cnt'));
}

console.log('T4 testbench wait/report/assert + time');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity tb is end tb;
architecture a of tb is
  signal s : std_logic := '0';
begin
  process begin
    s <= '1'; wait for 10 ns;
    assert s='1' report "s should be 1" severity error;
    s <= '0'; wait for 5 ns;
    report "done" severity note;
    wait;
  end process;
end a;`, 'tb');
  d.kernel.run(1000);
  check('time advanced 15ns', d.kernel.time === 15e6, String(d.kernel.time));
  check('s final 0', valToString(d.kernel.signals.get('tb.s').value) === '0');
  check('no error log', !d.kernel.log.some(l => l.sev === 'error'), JSON.stringify(d.kernel.log));
  check('report logged', d.kernel.log.some(l => l.msg === 'done'));
}

console.log('T5 case + selected assign + enum FSM');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity t is port(sel: in std_logic_vector(1 downto 0); y: out std_logic_vector(3 downto 0)); end t;
architecture a of t is
begin
  with sel select y <=
    "0001" when "00",
    "0010" when "01",
    "0100" when "10",
    "1000" when others;
end a;`, 't');
  const cases = [['00','0001'],['01','0010'],['10','0100'],['11','1000']];
  for (const [s, e] of cases) { setIn(d, 'sel', slvFromString(s)); check(`sel=${s}`, outs(d, 'y') === e, outs(d, 'y')); }
}

console.log('T6 component instantiation + port map nets');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity inv is port(a: in std_logic; b: out std_logic); end inv;
architecture x of inv is begin b <= not a; end x;
library ieee; use ieee.std_logic_1164.all;
entity t is port(i: in std_logic; o: out std_logic); end t;
architecture a of t is
  component inv port(a: in std_logic; b: out std_logic); end component;
  signal mid : std_logic;
begin
  u1: inv port map(a => i, b => mid);
  u2: inv port map(a => mid, b => o);
end a;`, 't');
  setIn(d, 'i', sl(L1));
  check('double inv =1', outs(d, 'o') === '1', outs(d, 'o'));
  setIn(d, 'i', sl(L0));
  check('double inv =0', outs(d, 'o') === '0', outs(d, 'o'));
}

console.log('T7 for generate + variables + loops');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is port(d: in std_logic_vector(7 downto 0); ones: out std_logic_vector(3 downto 0)); end t;
architecture a of t is
begin
  process(d)
    variable c : integer := 0;
  begin
    c := 0;
    for i in d'range loop
      if d(i)='1' then c := c + 1; end if;
    end loop;
    ones <= std_logic_vector(to_unsigned(c,4));
  end process;
end a;`, 't');
  setIn(d, 'd', slvFromString('10110010'));
  check('popcount=4', outs(d, 'ones') === '0100', outs(d, 'ones'));
  setIn(d, 'd', slvFromString('11111111'));
  check('popcount=8', outs(d, 'ones') === '1000', outs(d, 'ones'));
}

console.log('T8 JK counter per-element drivers + init');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
entity t is port(clk,rst: in std_logic; q: out std_logic_vector(2 downto 0)); end t;
architecture a of t is
  signal qr : std_logic_vector(2 downto 0) := "000";
begin
  process(clk,rst)
  begin
    if rst='1' then qr <= "000";
    elsif rising_edge(clk) then
      qr(0) <= not qr(0);
      qr(1) <= qr(1) xor qr(0);
      qr(2) <= qr(2) xor (qr(1) and qr(0));
    end if;
  end process;
  q <= qr;
end a;`, 't');
  setIn(d, 'clk', sl(L0)); setIn(d, 'rst', sl(L1));
  setIn(d, 'clk', sl(L1));
  check('init 000', outs(d, 'q') === '000', outs(d, 'q'));
  setIn(d, 'rst', sl(L0));
  const seq = ['001','010','011','100','101','110','111','000'];
  for (const e of seq) {
    setIn(d, 'clk', sl(L0)); setIn(d, 'clk', sl(L1));
    check(`count ${e}`, outs(d, 'q') === e, outs(d, 'q'));
  }
}

console.log('T9 signed arithmetic + to_integer');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is port(a,b: in std_logic_vector(7 downto 0); s: out std_logic_vector(7 downto 0); diff: out integer); end t;
architecture a of t is
begin
  s <= std_logic_vector(signed(a) + signed(b));
  diff <= to_integer(signed(a)) - to_integer(signed(b));
end a;`, 't');
  setIn(d, 'a', slvFromString('11111011')); // -5
  setIn(d, 'b', slvFromString('00000011')); // 3
  check('sum -2', outs(d, 's') === '11111110', outs(d, 's'));
  check('diff -8', out(d, 'diff').v === -8, String(out(d,'diff').v));
}

console.log('T10 package function + constant');
{
  const d = sim(`
library ieee; use ieee.std_logic_1164.all;
package p is
  constant W : integer := 4;
  function dbl(x: integer) return integer;
end p;
package body p is
  function dbl(x: integer) return integer is begin return x*2; end function;
end p;
library ieee; use ieee.std_logic_1164.all; use work.p.all;
entity t is port(a: in integer; y: out integer); end t;
architecture x of t is begin y <= dbl(a) + W; end x;`, 't');
  setIn(d, 'a', int(3));
  check('dbl(3)+4=10', out(d, 'y').v === 10, String(out(d, 'y').v));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);