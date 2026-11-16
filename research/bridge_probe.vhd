library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity bridge_probe is
  port (clk, rst, en : in std_logic; q : out unsigned(7 downto 0));
end entity;
architecture rtl of bridge_probe is
  signal n : unsigned(7 downto 0) := (others => '0');
begin
  process(clk, rst) begin
    if rst = '1' then n <= (others => '0');
    elsif rising_edge(clk) then
      if en = '1' then n <= n + 1; end if;
    end if;
  end process;
  q <= n;
end architecture;
