export class UartReceiver {
  constructor() { this.reset(); }
  reset() { this.last = '1'; this.busy = false; this.next = 0; this.bit = -1; this.byte = 0; this.baud = null; }
  sample(time, value, baud) {
    if (baud !== this.baud) { this.reset(); this.baud = baud; }
    const period = 1e15 / baud, bytes = [], errors = [];
    const read = bit => {
      if (!/^[01]$/.test(bit)) { errors.push('UART encountered an unknown logic level.'); this.busy = false; return; }
      if (this.bit === -1) { if (bit !== '0') this.busy = false; }
      else if (this.bit < 8) this.byte |= Number(bit) << this.bit;
      else { if (bit === '1') bytes.push(this.byte); else errors.push('UART framing error: stop bit is not high.'); this.busy = false; }
      this.bit++; this.next += period;
    };
    while (this.busy && this.next < time) read(this.last);
    const bit = value === 'H' ? '1' : value === 'L' ? '0' : value;
    if (!this.busy && this.last === '1' && bit === '0') { this.busy = true; this.next = time + period / 2; this.bit = -1; this.byte = 0; }
    this.last = bit;
    if (this.busy && this.next === time) read(bit);
    return { bytes, errors };
  }
}
