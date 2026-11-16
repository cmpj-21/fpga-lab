// Procedural canvas textures: PCB silkscreen, FPGA marking, 7-seg face, labels.
import * as THREE from 'three';
import { BOARD, COMPONENTS } from './boardDef.js';

const S = 12; // px per mm
const W = Math.round(BOARD.pcb.w * S), H = Math.round(BOARD.pcb.h * S);
const mx = (x) => x * S;
const my = (y) => (BOARD.pcb.h - y) * S;

function baseCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function makePcbTexture() {
  const c = baseCanvas(W, H);
  const g = c.getContext('2d');
  // solder mask
  g.fillStyle = '#15191d';
  g.fillRect(0, 0, W, H);
  // subtle fiberglass weave
  g.globalAlpha = 0.05;
  for (let y = 0; y < H; y += 6) { g.fillStyle = y % 12 ? '#1b2026' : '#171c21'; g.fillRect(0, y, W, 3); }
  for (let x = 0; x < W; x += 6) { g.fillStyle = x % 12 ? '#191e24' : '#151a1f'; g.fillRect(x, 0, 3, H); }
  g.globalAlpha = 1;
  // copper trace ghosts under mask
  g.strokeStyle = 'rgba(70,90,80,0.16)';
  g.lineWidth = 2;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 160; i++) {
    const x = rnd() * W, y = rnd() * H;
    g.beginPath(); g.moveTo(x, y);
    let cx = x, cy = y;
    for (let k = 0; k < 4; k++) {
      const dir = Math.floor(rnd() * 4);
      const len = 20 + rnd() * 90;
      if (dir === 0) cx += len; else if (dir === 1) cx -= len; else if (dir === 2) cy += len; else cy -= len;
      g.lineTo(cx, cy);
    }
    g.stroke();
  }
  // vias
  g.fillStyle = 'rgba(120,140,130,0.20)';
  for (let i = 0; i < 220; i++) { const x = rnd() * W, y = rnd() * H; g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill(); }

  const silk = '#d8dde2';
  g.strokeStyle = silk; g.fillStyle = silk;
  g.lineWidth = 1.6;
  g.font = `${Math.round(2.2 * S)}px Consolas, monospace`;
  g.textBaseline = 'middle';

  // component courtyards + refs
  for (const comp of COMPONENTS) {
    const dims = courtyard(comp.type);
    if (!dims) continue;
    const [w, h] = dims;
    g.save();
    g.translate(mx(comp.x), my(comp.y));
    if (comp.rot) g.rotate(-comp.rot * Math.PI / 180);
    g.globalAlpha = 0.75;
    g.strokeRect(-w * S / 2, -h * S / 2, w * S, h * S);
    g.globalAlpha = 1;
    g.font = `${Math.round(1.8 * S)}px Consolas, monospace`;
    g.fillText(comp.label, -w * S / 2, -h * S / 2 - 1.6 * S);
    g.restore();
  }

  // header pin numbers
  g.font = `${Math.round(1.4 * S)}px Consolas, monospace`;
  g.globalAlpha = 0.85;
  for (const hid of ['p1', 'p3']) {
    const comp = COMPONENTS.find(c => c.id === hid);
    for (let i = 0; i < 20; i++) {
      const x = mx(comp.x - 24 + i * 2.54);
      g.fillText(String(i * 2 + 1), x - 3, my(comp.y) - 4.4 * S);
      g.fillText(String(i * 2 + 2), x - 3, my(comp.y) + 4.4 * S);
    }
  }
  g.globalAlpha = 1;

  // title block
  g.font = `bold ${Math.round(3.4 * S)}px "Segoe UI", sans-serif`;
  g.fillText('RZ-EasyFPGA A2.2', mx(52), my(95));
  g.font = `bold ${Math.round(4.6 * S)}px "Segoe UI", sans-serif`;
  g.fillText('Cyclone IV', mx(88), my(76));
  g.font = `${Math.round(2 * S)}px Consolas, monospace`;
  g.fillText('EP4CE6E22C8N  ·  6272 LE  ·  50 MHz', mx(52), my(91));
  g.fillText('RZ TECHNOLOGY  /  A2.2', mx(52), my(87.5));

  // angular mirror-symmetric emblem
  g.save();
  g.translate(mx(20), my(60));
  g.strokeStyle = silk; g.lineWidth = 2.4; g.globalAlpha = 0.9;
  g.beginPath();
  g.moveTo(0, -6 * S); g.lineTo(4 * S, -2 * S); g.lineTo(4 * S, 2 * S); g.lineTo(0, 6 * S);
  g.lineTo(-4 * S, 2 * S); g.lineTo(-4 * S, -2 * S); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(0, -3 * S); g.lineTo(0, 3 * S); g.stroke();
  g.restore();

  // mounting holes
  for (const [hx, hy] of BOARD.holes) {
    g.strokeStyle = '#c9a24a'; g.lineWidth = 5;
    g.beginPath(); g.arc(mx(hx), my(hy), 2.2 * S, 0, 7); g.stroke();
    g.fillStyle = '#05060a';
    g.beginPath(); g.arc(mx(hx), my(hy), 1.5 * S, 0, 7); g.fill();
  }
  // FPGA pin-1 marker
  g.fillStyle = silk;
  g.beginPath(); g.arc(mx(62 - 9), my(58 + 9), 1.1 * S, 0, 7); g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function courtyard(type) {
  switch (type) {
    case 'eqfp144': return [23, 23];
    case 'seg4': return [50, 19];
    case 'buzzer': return [13, 13];
    case 'db15': return [16, 31];
    case 'db9': return [14, 22];
    case 'usbb': return [12, 12];
    case 'dcjack': return [9, 14];
    case 'pwrsw': return [9, 9];
    case 'box2x5': return [8, 13];
    case 'key': return [7, 7];
    case 'dip4': return [11, 7];
    case 'led': return [2.4, 1.6];
    case 'hdr2x20': return [51, 6];
    case 'tsop54': return [23, 11];
    case 'soic8': return [6, 5];
    case 'sot223': return [7, 4];
    case 'xtal': return [12, 5];
    case 'ir': return [6, 6];
    case 'hdr1x20': return [51, 3];
    case 'box2x4': return [8, 6];
    case 'tantalum': return [4, 3];
    default: return null;
  }
}

export function makeChipTexture() {
  const c = baseCanvas(512, 512);
  const g = c.getContext('2d');
  g.fillStyle = '#14161a';
  g.fillRect(0, 0, 512, 512);
  // subtle molded texture
  g.globalAlpha = 0.06;
  for (let i = 0; i < 400; i++) { g.fillStyle = i % 2 ? '#1c1f24' : '#101216'; g.fillRect(Math.random() * 512, Math.random() * 512, 3, 3); }
  g.globalAlpha = 1;
  g.fillStyle = '#9aa3ad';
  g.textAlign = 'center';
  g.font = 'bold 52px "Segoe UI", sans-serif';
  g.fillText('ALTERA', 256, 130);
  g.font = 'bold 40px "Segoe UI", sans-serif';
  g.fillText('Cyclone IV', 256, 200);
  g.font = '30px Consolas, monospace';
  g.fillStyle = '#8b939c';
  g.fillText('EP4CE6E22C8N', 256, 268);
  g.fillText('E144  ·  6272 LE', 256, 312);
  g.font = '24px Consolas, monospace';
  g.fillStyle = '#767d86';
  g.fillText('2511  A2.2  KOREA', 256, 372);
  // pin-1 dot
  g.fillStyle = '#5b636c';
  g.beginPath(); g.arc(70, 440, 16, 0, 7); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// 4-digit common-anode 7-seg face. state: array of 4 { segs: 8-bit (bit0=A..bit7=DP, 1=ON), enabled: bool }
export function makeSegDisplay() {
  const c = baseCanvas(600, 228);
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (state) => {
    g.fillStyle = '#0b0705';
    g.fillRect(0, 0, 600, 228);
    g.fillStyle = '#120a06';
    g.fillRect(6, 6, 588, 216);
    for (let d = 0; d < 4; d++) {
      const st = state[d] || { segs: 0, enabled: false };
      const ox = 18 + d * 148;
      drawDigit(g, ox, 28, st.segs, st.enabled);
    }
    tex.needsUpdate = true;
  };
  draw([{ segs: 0, enabled: false }, { segs: 0, enabled: false }, { segs: 0, enabled: false }, { segs: 0, enabled: false }]);
  return { canvas: c, texture: tex, draw };
}

function drawDigit(g, ox, oy, segs, enabled) {
  const on = enabled ? '#ff5a2a' : '#241109';
  const glow = enabled;
  const t = 11, L = 71, Wd = 88;
  const seg = (bit, pts) => {
    const lit = enabled && (segs >> bit & 1);
    g.fillStyle = lit ? '#ff6a34' : '#20100a';
    if (lit && glow) { g.shadowColor = '#ff5a2a'; g.shadowBlur = 16; } else g.shadowBlur = 0;
    g.beginPath();
    g.moveTo(ox + pts[0][0], oy + pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(ox + pts[i][0], oy + pts[i][1]);
    g.closePath(); g.fill();
    g.shadowBlur = 0;
  };
  const hseg = (y) => [[t, y], [Wd - t, y], [Wd - t / 2, y + t / 2], [Wd - t, y + t], [t, y + t], [t / 2, y + t / 2]];
  const vseg = (x, y) => [[x, y + t], [x + t / 2, y + t / 2], [x + t, y + t], [x + t, y + L - t], [x + t / 2, y + L - t / 2], [x, y + L - t]];
  seg(0, hseg(0));                       // A top
  seg(1, vseg(Wd - t, t / 2));           // B top-right
  seg(2, vseg(Wd - t, L + t));           // C bottom-right
  seg(3, hseg(2 * L));                   // D bottom
  seg(4, vseg(0, L + t));                // E bottom-left
  seg(5, vseg(0, t / 2));                // F top-left
  seg(6, hseg(L));                       // G middle
  // DP
  const litDp = enabled && (segs >> 7 & 1);
  g.fillStyle = litDp ? '#ff6a34' : '#20100a';
  if (litDp) { g.shadowColor = '#ff5a2a'; g.shadowBlur = 14; }
  g.beginPath(); g.arc(ox + Wd + 14, oy + 2 * L + t, 8, 0, 7); g.fill();
  g.shadowBlur = 0;
}

export function makeLabelTexture(text, color = '#35e0ff') {
  const c = baseCanvas(256, 64);
  const g = c.getContext('2d');
  g.font = 'bold 30px Consolas, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(8,10,14,0.72)';
  const w = g.measureText(text).width + 24;
  g.fillRect(128 - w / 2, 8, w, 48);
  g.strokeStyle = color; g.lineWidth = 2;
  g.strokeRect(128 - w / 2, 8, w, 48);
  g.fillStyle = color;
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeGlowTexture(color = '#ff4438') {
  const c = baseCanvas(128, 128);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, color + 'aa');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}