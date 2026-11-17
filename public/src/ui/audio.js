// WebAudio feedback. Sound ON by default; one mute gate. Every sound ties to a visible event.
let ctx = null;
let master = null;
let muted = false;
let buzzerOsc = null, buzzerGain = null;

let currentVolume = 0.5;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : currentVolume;
  master.connect(ctx.destination);
  return ctx;
}

export function resume() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

export function setVolume(v) {
  currentVolume = Math.max(0, Math.min(1, Number(v) || 0));
  const c = ensure();
  if (master && !muted && c) master.gain.setTargetAtTime(currentVolume, c.currentTime, 0.02);
}

export function getVolume() { return currentVolume; }

export function setMuted(m) {
  muted = m;
  const c = ensure();
  if (master && c) master.gain.setTargetAtTime(m ? 0 : currentVolume, c.currentTime, 0.02);
  if (m) stopBuzzer();
}
export function isMuted() { return muted; }

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

export function startBuzzer() {
  const c = ensure(); if (!c || muted || buzzerOsc) return;
  const t = c.currentTime;
  buzzerOsc = c.createOscillator();
  buzzerGain = c.createGain();
  buzzerOsc.type = 'square';
  buzzerOsc.frequency.value = 2048;
  buzzerGain.gain.setValueAtTime(0.0001, t);
  buzzerGain.gain.setTargetAtTime(0.07, t, 0.01);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2048; bp.Q.value = 3;
  buzzerOsc.connect(bp); bp.connect(buzzerGain); buzzerGain.connect(master);
  buzzerOsc.start(t);
}
export function stopBuzzer() {
  if (!buzzerOsc || !ctx) return;
  const t = ctx.currentTime;
  buzzerGain.gain.setTargetAtTime(0.0001, t, 0.02);
  const o = buzzerOsc;
  o.stop(t + 0.1);
  buzzerOsc = null; buzzerGain = null;
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