export const BOARD = {
  name: 'RZ-EasyFPGA A2.2',
  vendor: 'Ruizhi Technology',
  pcb: { w: 136, h: 106, thickness: 1.6 },
  device: { part: 'EP4CE6E22C8N', family: 'Cyclone IV E', package: 'EQFP-144', body: 20, pitch: 0.5, pinsPerSide: 36, speed: 'C8', logicElements: 6272, m9k: 30, pll: 2 },
  clockMHz: 50,
  holes: [[6, 6], [130, 6], [6, 100], [130, 100]],
};

export const PIN_NET = {
  23: 'clk', 25: 'reset_btn',
  88: 's1', 89: 's2', 90: 's3', 91: 's4',
  87: 'led1', 86: 'led2', 85: 'led3', 84: 'led4',
  133: 'dtube1', 135: 'dtube2', 136: 'dtube3', 137: 'dtube4',
  128: 'seg_a', 121: 'seg_b', 125: 'seg_c', 129: 'seg_d', 132: 'seg_e', 126: 'seg_f', 124: 'seg_g', 127: 'seg_dp',
  110: 'beep', 114: 'uart_txd', 115: 'uart_rxd',
  106: 'vga_r', 105: 'vga_g', 104: 'vga_b', 101: 'vga_hs', 103: 'vga_vs',
  119: 'ps2_clk', 120: 'ps2_data', 100: 'ir',
  112: 'i2c_scl', 113: 'i2c_sda',
};
export const NET_PIN = Object.fromEntries(Object.entries(PIN_NET).map(([pin, net]) => [net, Number(pin)]));
export const SEG_NETS = ['seg_a', 'seg_b', 'seg_c', 'seg_d', 'seg_e', 'seg_f', 'seg_g', 'seg_dp'];
export const DIGIT_NETS = ['dtube1', 'dtube2', 'dtube3', 'dtube4'];
export const LED_NETS = ['led1', 'led2', 'led3', 'led4'];
export const KEY_NETS = ['s1', 's2', 's3', 's4'];

export const COMPONENTS = [
  { id: 'key1', net: 's1' },
  { id: 'key2', net: 's2' },
  { id: 'key3', net: 's3' },
  { id: 'key4', net: 's4' },
  { id: 'reset', net: 'reset_btn' },
  { id: 'led1', net: 'led1' },
  { id: 'led2', net: 'led2' },
  { id: 'led3', net: 'led3' },
  { id: 'led4', net: 'led4' },
];
