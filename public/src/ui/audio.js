// WebAudio feedback. Sound ON by default; one mute gate. Every sound ties to a visible event.
let ctx = null;
let master = null;
let muted = false;
let buzzerOsc = null, buzzerFilters = null, buzzerGain = null, buzzerStopTimer = null, buzzerWave = null;
let workletNode = null, workletLoading = null, workletGain = null;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  return ctx;
}

export function resume() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
  ensureWorklet();
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.02);
  if (m) stopBuzzer();
}
export function isMuted() { return muted; }
export function sampleRate() { return ctx?.sampleRate || 48000; }

function createBuzzerChain(c, srcNode, gainVal) {
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 240; hp.Q.value = 0.7;
  const peak = c.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 2250; peak.Q.value = 2.0; peak.gain.value = 9;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5600; lp.Q.value = 0.8;
  const g = c.createGain();
  g.gain.value = gainVal;
  srcNode.connect(hp); hp.connect(peak); peak.connect(lp); lp.connect(g); g.connect(master);
  return { filters: [hp, peak, lp], gain: g };
}

async function ensureWorklet() {
  const c = ensure();
  if (!c || !c.audioWorklet) return null;
  if (workletNode) return workletNode;
  if (!workletLoading) {
    workletLoading = c.audioWorklet.addModule('/src/ui/buzzer-worklet.js')
      .then(() => {
        if (!c || workletNode) return workletNode;
        const node = new AudioWorkletNode(c, 'trace-buzzer-worklet', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        const chain = createBuzzerChain(c, node, 0.085);
        workletGain = chain.gain;
        workletNode = node;
        return node;
      })
      .catch(() => null);
  }
  return workletLoading;
}

export function pushBuzzerPcm(chunk) {
  if (!chunk || !chunk.length || muted) return;
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  if (workletNode) {
    workletNode.port.postMessage(chunk, [chunk.buffer]);
  } else {
    ensureWorklet();
  }
}

function env(gainNode, t0, peak, dur) {
  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

export function click(down = true) {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(down ? 1800 : 1200, t);
  osc.frequency.exponentialRampToValueAtTime(down ? 600 : 400, t + 0.04);
  env(g, t, 0.18, 0.05);
  osc.connect(g); g.connect(master);
  osc.start(t); osc.stop(t + 0.06);
  // mechanical noise tick
  const buf = c.createBuffer(1, c.sampleRate * 0.02, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource(); src.buffer = buf;
  const ng = c.createGain(); ng.gain.value = 0.06;
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2000;
  src.connect(hp); hp.connect(ng); ng.connect(master);
  src.start(t);
}

export function tick() {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 2600;
  env(g, t, 0.05, 0.03);
  osc.connect(g); g.connect(master);
  osc.start(t); osc.stop(t + 0.04);
}

function getBuzzerWave(c) {
  if (buzzerWave || !c.createPeriodicWave) return buzzerWave;
  const imag = new Float32Array([0, 1.0, 0.32, 0.62, 0.18, 0.40, 0.11, 0.26, 0.07, 0.16, 0.04, 0.10]);
  const real = new Float32Array(imag.length);
  buzzerWave = c.createPeriodicWave(real, imag);
  return buzzerWave;
}
export function startBuzzer(freq = 2048) {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime;
  const f = Math.max(55, Math.min(6000, Number(freq) || 2048));
  if (buzzerStopTimer) { clearTimeout(buzzerStopTimer); buzzerStopTimer = null; }
  if (buzzerOsc && buzzerGain && buzzerFilters) {
    buzzerOsc.frequency.setTargetAtTime(f, t, 0.008);
    buzzerGain.gain.cancelScheduledValues(t);
    buzzerGain.gain.setTargetAtTime(0.055, t, 0.008);
    return;
  }
  buzzerOsc = c.createOscillator();
  const wave = getBuzzerWave(c);
  if (wave) buzzerOsc.setPeriodicWave(wave);
  else buzzerOsc.type = 'square';
  buzzerOsc.frequency.setValueAtTime(f, t);

  // 12mm PCB electromagnetic/piezo buzzer acoustic body: bass rolloff, ~2.25 kHz diaphragm resonance, gentle HF rolloff
  const chain = createBuzzerChain(c, buzzerOsc, 0.0001);
  buzzerFilters = chain.filters;
  buzzerGain = chain.gain;
  buzzerGain.gain.setValueAtTime(0.0001, t);
  buzzerGain.gain.setTargetAtTime(0.055, t, 0.008);
  buzzerOsc.start(t);
}
export function stopBuzzer() {
  if (workletNode) workletNode.port.postMessage({ type: 'flush' });
  if (!buzzerOsc || !ctx) return;
  const t = ctx.currentTime;
  if (buzzerStopTimer) { clearTimeout(buzzerStopTimer); buzzerStopTimer = null; }
  buzzerGain.gain.cancelScheduledValues(t);
  buzzerGain.gain.setTargetAtTime(0.0001, t, 0.018);
  const o = buzzerOsc, g = buzzerGain, flts = buzzerFilters;
  buzzerStopTimer = setTimeout(() => {
    buzzerStopTimer = null;
    if (buzzerOsc !== o) return;
    try { o.stop(); } catch {}
    try { o.disconnect(); for (const f of flts || []) f.disconnect(); g.disconnect(); } catch {}
    buzzerOsc = null; buzzerFilters = null; buzzerGain = null;
  }, 80);
}

export function chime() {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    env(g, t + i * 0.08, 0.12, 0.3);
    osc.connect(g); g.connect(master);
    osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.32);
  });
}

export function error() {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.25);
  env(g, t, 0.12, 0.3);
  osc.connect(g); g.connect(master);
  osc.start(t); osc.stop(t + 0.32);
}