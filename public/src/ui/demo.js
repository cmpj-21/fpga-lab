// Preloaded bench demo: exercises keys, TDM 7-seg, LEDs, buzzer using board port names.
export const DEMO_NAME = 'bench_demo.vhd';
export const DEMO_TOP = 'bench_demo';
export const DEMO_SRC = `-- TRACE//LAB bench demo
-- 24-bit counter -> 4-digit hex TDM display, LED bank, overflow buzzer.
-- s1 (active low) = count enable, reset_btn (active low) = clear.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity bench_demo is
  port (
    clk       : in  std_logic;
    reset_btn : in  std_logic;
    s1        : in  std_logic;
    s2        : in  std_logic;
    s3        : in  std_logic;
    s4        : in  std_logic;
    led1      : out std_logic;
    led2      : out std_logic;
    led3      : out std_logic;
    led4      : out std_logic;
    dtube1    : out std_logic;
    dtube2    : out std_logic;
    dtube3    : out std_logic;
    dtube4    : out std_logic;
    seven_seg : out std_logic_vector(7 downto 0);
    beep      : out std_logic;
    uart_txd  : out std_logic
  );
end entity bench_demo;

architecture rtl of bench_demo is
  signal prescale : unsigned(21 downto 0) := (others => '0');
  signal count    : unsigned(15 downto 0) := (others => '0');
  signal scan     : unsigned(1 downto 0)  := (others => '0');

  function hex_seg(n : unsigned(3 downto 0)) return std_logic_vector is
    variable s : std_logic_vector(7 downto 0);
  begin
    case to_integer(n) is
      when 0 => s := "11000000";
      when 1 => s := "11111001";
      when 2 => s := "10100100";
      when 3 => s := "10110000";
      when 4 => s := "10011001";
      when 5 => s := "10010010";
      when 6 => s := "10000010";
      when 7 => s := "11111000";
      when 8 => s := "10000000";
      when 9 => s := "10010000";
      when 10 => s := "10001000";
      when 11 => s := "10000011";
      when 12 => s := "11000110";
      when 13 => s := "10100001";
      when 14 => s := "10000110";
      when others => s := "10001110";
    end case;
    return s;
  end function hex_seg;

  signal nibble : unsigned(3 downto 0);
begin

  uart_txd <= '1';

  process(clk)
  begin
    if rising_edge(clk) then
      if reset_btn = '0' then
        prescale <= (others => '0');
        count <= (others => '0');
        scan <= (others => '0');
      else
        scan <= scan + 1;
        prescale <= prescale + 1;
        if s2 = '0' then
          count(7 downto 0) <= (others => '0');
        elsif prescale = 0 then
          if s3 = '0' then
            count <= count - 1;
          elsif s1 = '0' then
            count <= count + 1;
          end if;
        end if;
      end if;
    end if;
  end process;

  led1 <= '0' when s4 = '0' else not count(0);
  led2 <= '0' when s4 = '0' else not count(1);
  led3 <= '0' when s4 = '0' else not count(2);
  led4 <= '0' when s4 = '0' else not count(3);

  -- overflow buzzer
  beep <= '1' when count(7 downto 0) = "11111111" else '0';

  -- TDM digit select (active low one-hot)
  with scan select dtube1 <= '0' when "00", '1' when others;
  with scan select dtube2 <= '0' when "01", '1' when others;
  with scan select dtube3 <= '0' when "10", '1' when others;
  with scan select dtube4 <= '0' when "11", '1' when others;

  -- multiplexed nibble (dtube1/PIN_133 = rightmost LSB, dtube4/PIN_137 = leftmost MSB)
  with scan select nibble <=
    count(3 downto 0)   when "00",
    count(7 downto 4)   when "01",
    count(11 downto 8)  when "10",
    count(15 downto 12) when others;

  seven_seg <= "10000000" when s4 = '0' else hex_seg(nibble);

end architecture rtl;
`;