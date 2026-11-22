// Real-time circular-buffer PCM player for 48 kHz buzzer audio streamed from compiled RTL
class BuzzerStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 32768;
    this.buf = new Float32Array(this.cap);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.count = 0;
    this.lastOut = 0;
    this.port.onmessage = ({ data }) => {
      if (data && data.type === 'flush') {
        this.readIdx = 0;
        this.writeIdx = 0;
        this.count = 0;
        return;
      }
      if (data instanceof Float32Array && data.length > 0) {
        // Trim excess backlog if tab/render fell behind so key presses remain low-latency (< ~50 ms)
        const maxQueued = 2800;
        const targetAfterTrim = 1200;
        if (this.count + data.length > maxQueued) {
          const drop = Math.min(this.count, (this.count + data.length) - targetAfterTrim);
          this.readIdx = (this.readIdx + drop) % this.cap;
          this.count -= drop;
        }
        const n = Math.min(data.length, this.cap - this.count);
        for (let i = 0; i < n; i++) {
          this.buf[this.writeIdx] = data[i];
          this.writeIdx = (this.writeIdx + 1) % this.cap;
        }
        this.count += n;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const len = out.length;
    if (this.count >= len) {
      for (let i = 0; i < len; i++) {
        const v = this.buf[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.cap;
        out[i] = v;
        this.lastOut = v;
      }
      this.count -= len;
    } else {
      let i = 0;
      while (i < len && this.count > 0) {
        const v = this.buf[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.cap;
        this.count--;
        out[i++] = v;
        this.lastOut = v;
      }
      while (i < len) {
        this.lastOut *= 0.92;
        if (Math.abs(this.lastOut) < 1e-4) this.lastOut = 0;
        out[i++] = this.lastOut;
      }
    }
    return true;
  }
}

registerProcessor('trace-buzzer-worklet', BuzzerStreamProcessor);
