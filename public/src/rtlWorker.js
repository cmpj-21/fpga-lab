// Dedicated Web Worker for real-time 50 MHz compiled RTL simulation.
// Keeps heavy cycle-stepping off the main UI/WebGL thread so 3D rendering stays locked at 60 FPS.

let runner = null;

self.onmessage = async ({ data }) => {
  if (!data || typeof data !== 'object') return;
  try {
    if (data.type === 'init') {
      runner = null;
      const mod = await import(data.url);
      runner = mod.createRunner(data.beepPort || '');
      self.postMessage({ type: 'ready', id: data.id, meta: runner.meta });
      return;
    }
    if (!runner) return;
    if (data.type === 'input') {
      runner.setInput(data.name, data.val >>> 0);
      return;
    }
    if (data.type === 'inputs') {
      if (Array.isArray(data.list)) {
        for (const item of data.list) runner.setInput(item.name, item.val >>> 0);
      }
      if (typeof data.beepPort === 'string') runner.setBeepPort(data.beepPort);
      return;
    }
    if (data.type === 'beep') {
      runner.setBeepPort(data.name || '');
      return;
    }
    if (data.type === 'reset') {
      runner.reset();
      return;
    }
    if (data.type === 'batch') {
      const t0 = performance.now();
      const audioSamples = data.audioSamples | 0;
      const audioOut = audioSamples > 0 ? new Float32Array(audioSamples) : null;
      const res = runner.runBatch(data.cycles | 0, data.sampleCount | 0, audioOut);
      const execMs = performance.now() - t0;
      const transfer = [];
      if (audioOut) transfer.push(audioOut.buffer);
      // Pack sample offsets and values into flat typed arrays for near-zero structured-clone overhead
      const nSamples = res.samples.length;
      const stride = nSamples > 0 ? res.samples[0].vals.length : 0;
      const offsets = new Float64Array(nSamples);
      const flatVals = new Uint32Array(nSamples * stride);
      for (let i = 0; i < nSamples; i++) {
        offsets[i] = res.samples[i].offset;
        flatVals.set(res.samples[i].vals, i * stride);
      }
      transfer.push(offsets.buffer, flatVals.buffer);
      self.postMessage({
        type: 'result',
        seq: data.seq,
        gen: data.gen,
        cyclesRun: res.cyclesRun,
        execMs,
        nSamples,
        stride,
        offsets,
        flatVals,
        audioOut,
        startTimeFs: data.startTimeFs,
        trueCycleFs: data.trueCycleFs,
        tickFs: data.tickFs,
        hasScalarBeep: data.hasScalarBeep,
      }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, seq: data.seq, message: err?.message || String(err) });
  }
};
