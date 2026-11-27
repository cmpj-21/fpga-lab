// Smart direction-aware fuzzy pin auto-mapper for RZ-EasyFPGA A2.2 (EP4CE6E22C8N).
// Only fills unassigned ports and never overwrites existing user assignments.

const KEY_PINS = [88, 89, 90, 91];                 // s1..s4 (active-low)
const LED_PINS = [87, 86, 85, 84];                 // led1..led4 (active-low)
const DTUBE_PINS_LSB_FIRST = [133, 135, 136, 137]; // dtube1(Q1/rightmost)..dtube4(Q4/leftmost)
const SEG_PINS = [128, 121, 125, 129, 132, 126, 124, 127]; // a, b, c, d, e, f, g, dp
const SEG_LETTER_PIN = { a: 128, b: 121, c: 125, d: 129, e: 132, f: 126, g: 124, dp: 127, p: 127 };

function normName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[-.\s]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .replace(/(?:_n|_l|_b|_bar|_low|_inv)$/, '');
}

function stripAllSep(s) {
  return normName(s).replace(/_/g, '');
}

export function suggestPinAssignments(ports, existingAssignments) {
  const usedPins = new Set();
  const assignedPorts = new Set();
  for (const [pin, target] of (existingAssignments || new Map()).entries()) {
    const clean = String(target || '').trim().toLowerCase();
    if (clean) {
      usedPins.add(Number(pin));
      assignedPorts.add(clean);
    }
  }

  const list = Array.isArray(ports) ? ports : [];
  // Detect whether plain single-letter outputs a..g are present as a 7-segment set
  const outScalarNorms = new Set(
    list
      .filter(p => (p.dir === 'OUT' || p.dir === 'INOUT') && p.bit === null)
      .map(p => normName(p.base || p.name))
  );
  const hasPlainSegLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].every(ch => outScalarNorms.has(ch));

  // Group vector ports by base name so we know bit-width & ordering
  const vecGroups = new Map();
  for (const p of list) {
    if (p.bit !== null && p.bit !== undefined) {
      const k = (p.base || p.name.split('[')[0]).toLowerCase();
      if (!vecGroups.has(k)) vecGroups.set(k, []);
      vecGroups.get(k).push(p);
    }
  }

  const suggestions = []; // { pin, portName, label, reason }
  const claim = (pin, port, reason) => {
    if (!pin || usedPins.has(pin) || assignedPorts.has(port.name.toLowerCase())) return false;
    usedPins.add(pin);
    assignedPorts.add(port.name.toLowerCase());
    suggestions.push({ pin, portName: port.name.toLowerCase(), label: port.label || port.name, reason });
    return true;
  };

  for (const port of list) {
    const portKey = port.name.toLowerCase();
    if (assignedPorts.has(portKey)) continue;
    const isIn = port.dir === 'IN' || port.dir === 'INOUT';
    const isOut = port.dir === 'OUT' || port.dir === 'INOUT';
    const base = port.base || portKey.split('[')[0];
    const norm = normName(base);
    const flat = stripAllSep(base);
    const bit = port.bit;

    // --- Scalar Ports ---
    if (bit === null || bit === undefined) {
      if (isIn) {
        if (/^(clk|clock|clk50|clk50m|clk50mhz|sysclk|fpgaclk|mclk|osc|iclk|clki|clkin)$/.test(flat) || /^clk(_50|_50m|_in|_sys)?$/.test(norm)) {
          if (claim(23, port, '50 MHz clock')) continue;
        }
        if (/^(rst|reset|resetbtn|rstbtn|keyrst|sysrst|nreset|nrst|resetn|rstn|irst)$/.test(flat) || /^re?se?t(_btn|_in|_key)?$/.test(norm)) {
          if (claim(25, port, 'Reset button')) continue;
        }
        const keyMatch = flat.match(/^(?:s|key|btn|button|sw|dip|k)(\d)$/);
        if (keyMatch) {
          const n = Number(keyMatch[1]);
          const idx = (n >= 1 && n <= 4) ? n - 1 : -1;
          if (idx >= 0 && claim(KEY_PINS[idx], port, `Key S${idx + 1} / DIP ${idx + 1}`)) continue;
        }
        if (/^(uartrx|uartrxd|rxd|rx|rs232rx)$/.test(flat)) {
          if (claim(115, port, 'UART RX')) continue;
        }
        if (/^(ir|irrx|irin)$/.test(flat)) {
          if (claim(100, port, 'IR receiver')) continue;
        }
        if (/^(ps2clk)$/.test(flat)) {
          if (claim(119, port, 'PS/2 clock')) continue;
        }
        if (/^(ps2dat|ps2data)$/.test(flat)) {
          if (claim(120, port, 'PS/2 data')) continue;
        }
      }
      if (isOut) {
        const ledMatch = flat.match(/^(?:led|l|ledr|userled|d)(\d)$/);
        if (ledMatch) {
          const n = Number(ledMatch[1]);
          if (n >= 1 && n <= 4 && claim(LED_PINS[n - 1], port, `LED${n}`)) continue;
        }
        const digMatch = flat.match(/^(?:dtube|dig|digit|an|anode|sel|segsel|com|ds|disp)(\d)$/);
        if (digMatch) {
          const n = Number(digMatch[1]);
          // dtube1/dig1 -> PIN_133 (Q1/rightmost), ..., dtube4/dig4 -> PIN_137 (Q4/leftmost)
          if (n >= 1 && n <= 4 && claim(DTUBE_PINS_LSB_FIRST[n - 1], port, `7-Seg Digit ${n}`)) continue;
        }
        const segMatch = norm.match(/^(?:seg|seven_seg|sseg|hex|led_seg)_?([a-g]|dp)$/);
        if (segMatch) {
          const pin = SEG_LETTER_PIN[segMatch[1]];
          if (pin && claim(pin, port, `Segment ${segMatch[1].toUpperCase()}`)) continue;
        }
        if (hasPlainSegLetters && SEG_LETTER_PIN[norm]) {
          if (claim(SEG_LETTER_PIN[norm], port, `Segment ${norm.toUpperCase()}`)) continue;
        }
        if (/^(beep|buzz|buzzer|buzzerb|spk|speaker|sound|tone|piezo)$/.test(flat)) {
          if (claim(110, port, 'Piezo buzzer')) continue;
        }
        if (/^(uarttx|uarttxd|txd|tx|rs232tx)$/.test(flat)) {
          if (claim(114, port, 'UART TX')) continue;
        }
        if (/^(vgahs|hsync|vgahsync)$/.test(flat)) {
          if (claim(101, port, 'VGA HSYNC')) continue;
        }
        if (/^(vgavs|vsync|vgavsync)$/.test(flat)) {
          if (claim(103, port, 'VGA VSYNC')) continue;
        }
        if (/^(vgar|vgared)$/.test(flat)) {
          if (claim(106, port, 'VGA Red')) continue;
        }
        if (/^(vgag|vgagreen)$/.test(flat)) {
          if (claim(105, port, 'VGA Green')) continue;
        }
        if (/^(vgab|vgablue)$/.test(flat)) {
          if (claim(104, port, 'VGA Blue')) continue;
        }
      }
      if (/^(i2cscl|scl)$/.test(flat)) {
        if (claim(112, port, 'I2C SCL')) continue;
      }
      if (/^(i2csda|sda)$/.test(flat)) {
        if (claim(113, port, 'I2C SDA')) continue;
      }
      continue;
    }

    // --- Vector Ports ---
    const group = vecGroups.get(base.toLowerCase()) || [];
    const width = group.length;
    if (isIn && width === 4 && /^(?:s|key|keys|btn|btns|button|buttons|sw|switches|dip)$/.test(flat)) {
      if (bit >= 0 && bit <= 3) {
        if (claim(KEY_PINS[bit], port, `Key S${bit + 1}`)) continue;
      }
    }
    if (isOut && width === 4 && /^(?:led|leds|ledr)$/.test(flat)) {
      if (bit >= 0 && bit <= 3) {
        if (claim(LED_PINS[bit], port, `LED${bit + 1}`)) continue;
      }
    }
    if (isOut && width === 4 && /^(?:dtube|dtubes|dig|digits|digit|an|anodes|sel|segsel|ssegan|digsel|disp|com)$/.test(flat)) {
      // Bit 0 -> PIN_133 (Q1/rightmost LSB), Bit 3 -> PIN_137 (Q4/leftmost MSB) — matches real PCB!
      if (bit >= 0 && bit <= 3) {
        if (claim(DTUBE_PINS_LSB_FIRST[bit], port, `7-Seg dtube${bit + 1}`)) continue;
      }
    }
    if (isOut && (width === 7 || width === 8) && /^(?:sevenseg|sseg|seg|segs|segment|segments|hex|hexseg|cathode|cathodes|ssegatodp)$/.test(flat)) {
      if (bit >= 0 && bit < SEG_PINS.length) {
        const segLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
        if (claim(SEG_PINS[bit], port, `Segment ${segLabels[bit]}`)) continue;
      }
    }
  }

  return suggestions;
}
