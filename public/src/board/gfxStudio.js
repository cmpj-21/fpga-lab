import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const DEFAULT_GFX = {
  preset: 'default',
  // Render Pipeline & Camera Optics
  quality: 'high',
  resScale: 100,
  fpsCap: 0,
  projection: 'perspective',
  fov: 38,
  cameraRoll: 0,
  toneMapping: 'aces',
  exposure: 1.05,
  orbitSpeed: 0.6,
  // Shading & Materials
  shadingMode: 'pbr',
  pcbTheme: 'default',
  pcbCustomColor: '#165432',
  roughnessMult: 100,
  metalnessMult: 100,
  clearcoat: 0,
  ledTheme: 'default',
  ledCustomColor: '#ff2921',
  ledGlow: 65,
  segGlow: 65,
  ledLightBleed: 48,
  // Lighting & Environment
  lightPreset: 'default',
  envPreset: 'room',
  envIntensity: 42,
  envRotation: 0,
  keyIntensity: 1.85,
  keyColor: '#fffaf2',
  keyAzimuth: -39,
  keyElevation: 55,
  rimIntensity: 0.85,
  rimColor: '#e8eeff',
  rimAzimuth: 146,
  rimElevation: 35,
  fillIntensity: 0,
  fillColor: '#ffdfc2',
  hemiIntensity: 0.95,
  skyColor: '#ffffff',
  groundColor: '#8b8d85',
  cursorLight: false,
  cursorLightInt: 2.5,
  cursorLightColor: '#fff6e5',
  // Shadows, Floor & Backdrop
  shadowType: 'pcf-soft',
  shadowOpacity: 13,
  shadowBias: -15,
  floorMode: 'shadow',
  bgMode: 'theme',
  bgColor: '#1a1f18',
  bgColorBottom: '#0a0c09',
  // Post-Processing & Color Grading
  bloom: 34,
  bloomThreshold: 92,
  bloomRadius: 55,
  ssao: 0,
  ssaoRadius: 50,
  dof: 0,
  dofFocus: 175,
  dofAperture: 45,
  dofAutoFocus: true,
  chromaticAberration: 0,
  lensDistortion: 0,
  vignette: 0,
  grain: 0,
  sharpen: 0,
  edgeOutline: 0,
  edgeColor: '#1b2217',
  contrast: 100,
  saturation: 100,
  brightness: 0,
  temperature: 0,
  tint: 0,
  lutPreset: 'none',
};

export const LIGHT_PRESETS = {
  default: {
    keyIntensity: 1.85, keyColor: '#fffaf2', keyAzimuth: -39, keyElevation: 55,
    rimIntensity: 0.85, rimColor: '#e8eeff', rimAzimuth: 146, rimElevation: 35,
    fillIntensity: 0, fillColor: '#ffdfc2',
    hemiIntensity: 0.95, skyColor: '#ffffff', groundColor: '#8b8d85',
    envPreset: 'room', envIntensity: 42,
  },
  'studio-three-point': {
    keyIntensity: 3.6, keyColor: '#fff8ee', keyAzimuth: -45, keyElevation: 48,
    rimIntensity: 2.8, rimColor: '#cce0ff', rimAzimuth: 155, rimElevation: 28,
    fillIntensity: 1.4, fillColor: '#ffe6d0',
    hemiIntensity: 0.75, skyColor: '#e8eef5', groundColor: '#353834',
    envPreset: 'studio-soft', envIntensity: 95,
  },
  'dramatic-noir': {
    keyIntensity: 4.5, keyColor: '#fff3e0', keyAzimuth: -68, keyElevation: 26,
    rimIntensity: 3.2, rimColor: '#b8d4ff', rimAzimuth: 135, rimElevation: 18,
    fillIntensity: 0.2, fillColor: '#8090a0',
    hemiIntensity: 0.2, skyColor: '#404850', groundColor: '#101210',
    envPreset: 'dark-void', envIntensity: 35,
  },
  cyberpunk: {
    keyIntensity: 3.8, keyColor: '#ff2a85', keyAzimuth: -52, keyElevation: 38,
    rimIntensity: 4.0, rimColor: '#00f0ff', rimAzimuth: 132, rimElevation: 24,
    fillIntensity: 1.6, fillColor: '#7b2cff',
    hemiIntensity: 0.45, skyColor: '#180d3a', groundColor: '#051824',
    envPreset: 'cyber-grid', envIntensity: 130,
  },
  'golden-hour': {
    keyIntensity: 4.2, keyColor: '#ff9642', keyAzimuth: -72, keyElevation: 22,
    rimIntensity: 1.9, rimColor: '#7da8ff', rimAzimuth: 120, rimElevation: 45,
    fillIntensity: 0.8, fillColor: '#ffcc88',
    hemiIntensity: 0.95, skyColor: '#ffd4a6', groundColor: '#47392e',
    envPreset: 'sunset', envIntensity: 90,
  },
  'clean-lab': {
    keyIntensity: 3.0, keyColor: '#f7fbff', keyAzimuth: -25, keyElevation: 72,
    rimIntensity: 2.2, rimColor: '#f0f6ff', rimAzimuth: 160, rimElevation: 60,
    fillIntensity: 1.5, fillColor: '#ffffff',
    hemiIntensity: 1.9, skyColor: '#ffffff', groundColor: '#d0d6ce',
    envPreset: 'studio-soft', envIntensity: 85,
  },
  'inspect-macro': {
    keyIntensity: 2.4, keyColor: '#ffffff', keyAzimuth: 0, keyElevation: 82,
    rimIntensity: 2.0, rimColor: '#e0ecff', rimAzimuth: 180, rimElevation: 45,
    fillIntensity: 1.8, fillColor: '#fffaf0',
    hemiIntensity: 1.6, skyColor: '#ffffff', groundColor: '#9ca396',
    envPreset: 'room', envIntensity: 110, cursorLight: true, cursorLightInt: 3.2,
  },
};

export const GFX_PRESETS = {
  default: { ...DEFAULT_GFX, preset: 'default' },
  'studio-pro': {
    ...DEFAULT_GFX,
    preset: 'studio-pro',
    ...LIGHT_PRESETS['studio-three-point'],
    lightPreset: 'studio-three-point',
    toneMapping: 'agx',
    exposure: 1.22,
    clearcoat: 35,
    roughnessMult: 85,
    metalnessMult: 115,
    ledLightBleed: 65,
    floorMode: 'reflective',
    shadowOpacity: 35,
    bgMode: 'gradient',
    bgColor: '#232922',
    bgColorBottom: '#0d100c',
    bloom: 42,
    bloomThreshold: 58,
    ssao: 48,
    sharpen: 35,
    vignette: 28,
    contrast: 108,
  },
  cyberpunk: {
    ...DEFAULT_GFX,
    preset: 'cyberpunk',
    ...LIGHT_PRESETS.cyberpunk,
    lightPreset: 'cyberpunk',
    pcbTheme: 'matte-black',
    ledTheme: 'ice-blue',
    ledLightBleed: 95,
    clearcoat: 65,
    roughnessMult: 70,
    metalnessMult: 135,
    floorMode: 'reflective',
    bgMode: 'gradient',
    bgColor: '#120824',
    bgColorBottom: '#040812',
    toneMapping: 'aces',
    exposure: 1.28,
    bloom: 85,
    bloomThreshold: 42,
    ssao: 55,
    chromaticAberration: 38,
    vignette: 45,
    grain: 18,
    contrast: 115,
    saturation: 128,
    lutPreset: 'cinema-teal-orange',
  },
  automata: {
    ...DEFAULT_GFX,
    preset: 'automata',
    ...LIGHT_PRESETS['dramatic-noir'],
    lightPreset: 'dramatic-noir',
    pcbTheme: 'matte-black',
    ledTheme: 'amber',
    ledLightBleed: 55,
    floorMode: 'grid-floor',
    bgMode: 'gradient',
    bgColor: '#2b2923',
    bgColorBottom: '#12110e',
    bloom: 50,
    ssao: 65,
    vignette: 55,
    grain: 32,
    chromaticAberration: 20,
    edgeOutline: 35,
    edgeColor: '#181612',
    lutPreset: 'automata',
  },
  'golden-hour': {
    ...DEFAULT_GFX,
    preset: 'golden-hour',
    ...LIGHT_PRESETS['golden-hour'],
    lightPreset: 'golden-hour',
    pcbTheme: 'emerald',
    ledTheme: 'amber',
    ledLightBleed: 70,
    clearcoat: 40,
    floorMode: 'matte',
    bgMode: 'gradient',
    bgColor: '#3b281c',
    bgColorBottom: '#17110d',
    exposure: 1.2,
    bloom: 58,
    ssao: 45,
    vignette: 36,
    temperature: 28,
    lutPreset: 'kodak-portra',
  },
  'macro-tilt': {
    ...DEFAULT_GFX,
    preset: 'macro-tilt',
    ...LIGHT_PRESETS['studio-three-point'],
    lightPreset: 'studio-three-point',
    fov: 24,
    dof: 78,
    dofAperture: 70,
    dofAutoFocus: true,
    bloom: 48,
    ssao: 52,
    vignette: 40,
    grain: 15,
    sharpen: 30,
    clearcoat: 30,
    ledLightBleed: 60,
  },
  'cad-blueprint': {
    ...DEFAULT_GFX,
    preset: 'cad-blueprint',
    ...LIGHT_PRESETS['clean-lab'],
    lightPreset: 'clean-lab',
    projection: 'orthographic',
    shadingMode: 'wire-on-shaded',
    floorMode: 'grid-floor',
    bgMode: 'solid',
    bgColor: '#0c2340',
    edgeOutline: 85,
    edgeColor: '#ccf0ff',
    ssao: 40,
    lutPreset: 'blueprint',
  },
  'thermal-flir': {
    ...DEFAULT_GFX,
    preset: 'thermal-flir',
    ...LIGHT_PRESETS['clean-lab'],
    lightPreset: 'clean-lab',
    bgMode: 'darkroom',
    floorMode: 'none',
    bloom: 55,
    bloomThreshold: 40,
    vignette: 35,
    grain: 22,
    lutPreset: 'thermal',
  },
  'retro-crt': {
    ...DEFAULT_GFX,
    preset: 'retro-crt',
    pcbTheme: 'emerald',
    ledTheme: 'amber',
    ledLightBleed: 75,
    bgMode: 'darkroom',
    bloom: 70,
    chromaticAberration: 45,
    lensDistortion: 24,
    vignette: 55,
    grain: 28,
    lutPreset: 'crt-retro',
  },
  'xray-holo': {
    ...DEFAULT_GFX,
    preset: 'xray-holo',
    shadingMode: 'xray',
    bgMode: 'darkroom',
    floorMode: 'grid-floor',
    bloom: 80,
    bloomThreshold: 30,
    chromaticAberration: 22,
    vignette: 40,
  },
  'clay-sculpt': {
    ...DEFAULT_GFX,
    preset: 'clay-sculpt',
    ...LIGHT_PRESETS['studio-three-point'],
    lightPreset: 'studio-three-point',
    shadingMode: 'clay',
    floorMode: 'matte',
    bgMode: 'paper',
    ssao: 75,
    vignette: 25,
    contrast: 108,
  },
  'anime-cel': {
    ...DEFAULT_GFX,
    preset: 'anime-cel',
    ...LIGHT_PRESETS['clean-lab'],
    lightPreset: 'clean-lab',
    shadingMode: 'toon',
    edgeOutline: 92,
    edgeColor: '#141812',
    saturation: 125,
    contrast: 112,
  },
};

export const PCB_THEMES = {
  default: null,
  emerald: '#0b5c34',
  'matte-black': '#171918',
  'osh-purple': '#3b1d5e',
  crimson: '#7a161e',
  'arctic-white': '#dce0da',
  'cyber-gold': '#8c6518',
};

export const LED_THEMES = {
  default: { on: 0xf55f48, em: 0xff2921, off: 0x491c20, segOn: 0xe84e3c, segOff: 0x361c22, pwrOn: 0x4fd577, pwrEm: 0x39d66b },
  amber: { on: 0xffb340, em: 0xff8800, off: 0x4a3014, segOn: 0xffa62b, segOff: 0x382612, pwrOn: 0xffcc44, pwrEm: 0xffaa00 },
  emerald: { on: 0x48f582, em: 0x00e65c, off: 0x163d24, segOn: 0x3ce875, segOff: 0x163320, pwrOn: 0x4fd577, pwrEm: 0x39d66b },
  'ice-blue': { on: 0x5ce6ff, em: 0x00c8ff, off: 0x153542, segOn: 0x47dcff, segOff: 0x142c36, pwrOn: 0x70f5ff, pwrEm: 0x00e1ff },
  ultraviolet: { on: 0xe26eff, em: 0xc829ff, off: 0x381745, segOn: 0xd959ff, segOff: 0x2f1538, pwrOn: 0xff55b8, pwrEm: 0xff1f9c },
  'pure-white': { on: 0xf5f9ff, em: 0xdcebff, off: 0x333840, segOn: 0xf0f6ff, segOff: 0x2a2e33, pwrOn: 0xd4ffe4, pwrEm: 0x8cffb5 },
};

const CHAR_7SEG = {
  ' ': 0x00,
  '0': 0x3f, '1': 0x06, '2': 0x5b, '3': 0x4f, '4': 0x66, '5': 0x6d, '6': 0x7d, '7': 0x07, '8': 0x7f, '9': 0x6f,
  A: 0x77, B: 0x7c, C: 0x39, D: 0x5e, E: 0x79, F: 0x71, G: 0x3d, H: 0x76, I: 0x06, J: 0x1e,
  K: 0x75, L: 0x38, M: 0x37, N: 0x54, O: 0x3f, P: 0x73, Q: 0x67, R: 0x50, S: 0x6d, T: 0x78,
  U: 0x3e, V: 0x1c, W: 0x2a, X: 0x76, Y: 0x6e, Z: 0x5b,
  '-': 0x40, '_': 0x08, '=': 0x48, '[': 0x39, ']': 0x0f, '°': 0x63,
};

export function encode7SegText(text = '') {
  const out = [0, 0, 0, 0];
  let idx = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length && idx < 4; i++) {
    const ch = s[i].toUpperCase();
    if (ch === '.' && idx > 0 && !(out[idx - 1] & 0x80)) {
      out[idx - 1] |= 0x80;
      continue;
    }
    out[idx] = CHAR_7SEG[ch] ?? 0x00;
    if (s[i + 1] === '.') {
      out[idx] |= 0x80;
      i++;
    }
    idx++;
  }
  return out;
}

const VERT_POST = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG_BLOOM_EXTRACT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec4 col = texture2D(tDiffuse, vUv);
  vec3 safeCol = min(col.rgb, vec3(2.8));
  float luma = dot(safeCol, vec3(0.2126, 0.7152, 0.0722));
  float peak = max(safeCol.r, max(safeCol.g, safeCol.b));
  float brightness = max(luma, peak * 0.94);
  float knee = uThreshold * 0.18 + 0.0001;
  float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee);
  float contrib = max(soft, brightness - uThreshold) / max(brightness, 0.0001);
  gl_FragColor = vec4(safeCol * clamp(contrib, 0.0, 2.5), 1.0);
}
`;

const FRAG_BLOOM_BLUR = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
  sum += texture2D(tDiffuse, vUv + uStep * 1.384615).rgb * 0.316216;
  sum += texture2D(tDiffuse, vUv - uStep * 1.384615).rgb * 0.316216;
  sum += texture2D(tDiffuse, vUv + uStep * 3.230769).rgb * 0.070270;
  sum += texture2D(tDiffuse, vUv - uStep * 3.230769).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const FRAG_UBER_POST = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform int uIsOrtho;
uniform int uToneMap;
uniform float uExposure;
uniform float uBloom;
uniform float uSsao;
uniform float uSsaoRadius;
uniform float uDof;
uniform float uDofFocus;
uniform float uDofAperture;
uniform float uChroma;
uniform float uDistortion;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uSharpen;
uniform float uEdgeOutline;
uniform vec3 uEdgeColor;
uniform float uContrast;
uniform float uSaturation;
uniform float uBrightness;
uniform float uTemperature;
uniform float uTint;
uniform int uLut;
uniform int uBgGradient;
uniform int uHasDepth;
uniform int uBgHasSolid;
uniform vec3 uBgSolid;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
varying vec2 vUv;

float readLinearDepth(vec2 coord) {
  float z = texture2D(tDepth, coord).x;
  if (z >= 0.99999) return uFar;
  if (uIsOrtho == 1) {
    return mix(uNear, uFar, z);
  }
  float zNdc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - zNdc * (uFar - uNear));
}

vec3 toneMapACES(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toneMapAgX(vec3 col) {
  col = max(col, 0.0);
  col = col / (col + vec3(0.65));
  return pow(clamp(col, 0.0, 1.0), vec3(0.92));
}

vec3 toneMapNeutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

vec3 toneMapReinhard(vec3 x) {
  return clamp(x / (1.0 + x), 0.0, 1.0);
}

vec3 toneMapCineon(vec3 texColor) {
  vec3 x = max(vec3(0.0), texColor - 0.004);
  return pow((x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06), vec3(2.2));
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 ironbowPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.04, 0.02, 0.18);
  vec3 c1 = vec3(0.45, 0.03, 0.58);
  vec3 c2 = vec3(0.88, 0.18, 0.16);
  vec3 c3 = vec3(0.99, 0.68, 0.05);
  vec3 c4 = vec3(1.00, 0.99, 0.88);
  if (t < 0.25) return mix(c0, c1, t * 4.0);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
  if (t < 0.78) return mix(c2, c3, (t - 0.50) / 0.28);
  return mix(c3, c4, (t - 0.78) / 0.22);
}

void main() {
  vec2 uv = vUv;
  vec2 centered = uv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 aspectCoord = vec2(centered.x * aspect, centered.y);
  float r2 = dot(aspectCoord, aspectCoord);

  if (abs(uDistortion) > 0.001) {
    float k = uDistortion * 0.18;
    uv = (centered * (1.0 + k * r2 + k * 0.3 * r2 * r2)) * 0.5 + 0.5;
  }

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  vec4 baseSample = texture2D(tDiffuse, uv);
  vec3 col = baseSample.rgb;
  float alpha = baseSample.a;

  // Chromatic aberration
  if (uChroma > 0.001) {
    vec2 dir = (uv - 0.5) * uChroma * 0.018 * (0.4 + r2);
    col.r = texture2D(tDiffuse, clamp(uv + dir, 0.001, 0.999)).r;
    col.b = texture2D(tDiffuse, clamp(uv - dir, 0.001, 0.999)).b;
  }

  float centerDepth = uHasDepth == 1 ? readLinearDepth(uv) : uFar;
  bool isBackground = uHasDepth == 1 ? (centerDepth >= uFar * 0.995) : (alpha < 0.002);

  if (uHasDepth == 0 && alpha > 0.001) {
    col = col / alpha;
  }

  // Gradient studio backdrop (depth path)
  if (uHasDepth == 1 && isBackground && uBgGradient == 1) {
    float gradT = clamp(uv.y * 0.85 + 0.15 * (1.0 - r2 * 0.35), 0.0, 1.0);
    col = pow(mix(uBgBottom, uBgTop, gradT), vec3(2.2));
  }

  // Depth of Field (12-tap Golden Angle Bokeh Spiral)
  if (uHasDepth == 1 && uDof > 0.001) {
    float coc = clamp(abs(centerDepth - uDofFocus) / max(uDofFocus * (1.35 - uDofAperture * 0.95), 8.0), 0.0, 1.0);
    float blurRadius = coc * uDof * 9.5;
    if (blurRadius > 0.25) {
      vec3 acc = col;
      float wSum = 1.0;
      for (int i = 1; i <= 12; i++) {
        float fi = float(i);
        float ang = fi * 2.3999632;
        float rad = sqrt(fi / 12.0) * blurRadius;
        vec2 sUv = clamp(uv + vec2(cos(ang), sin(ang)) * texel * rad, 0.001, 0.999);
        float sDepth = readLinearDepth(sUv);
        float sCoc = clamp(abs(sDepth - uDofFocus) / max(uDofFocus * (1.35 - uDofAperture * 0.95), 8.0), 0.0, 1.0);
        float w = (sDepth < centerDepth ? sCoc : 1.0) * 0.85 + 0.15;
        acc += texture2D(tDiffuse, sUv).rgb * w;
        wSum += w;
      }
      col = acc / wSum;
    }
  }

  // Sharpening (Unsharp mask)
  if (uSharpen > 0.001 && !isBackground) {
    vec3 n = texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb;
    vec3 s = texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
    vec3 e = texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb;
    vec3 w = texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb;
    vec3 detail = col - 0.25 * (n + s + e + w);
    col = max(vec3(0.0), col + detail * uSharpen * 1.45);
  }

  // Screen-Space Ambient Occlusion (Symmetric Paired Valley SSAO — slope-invariant on flat surfaces)
  if (uHasDepth == 1 && uSsao > 0.001 && !isBackground) {
    float occ = 0.0;
    float radPx = (1.5 + uSsaoRadius * 4.5);
    float jitter = fract(sin(dot(uv * uResolution, vec2(12.9898, 78.233))) * 43758.5453) * 0.785398;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float ang = fi * 0.5235988 + jitter;
      float r = (0.4 + 0.6 * fract(fi * 0.41)) * radPx;
      vec2 off = vec2(cos(ang), sin(ang)) * texel * r;
      float dPlus = readLinearDepth(uv + off);
      float dMinus = readLinearDepth(uv - off);
      if (abs(dPlus - centerDepth) < 7.0 && abs(dMinus - centerDepth) < 7.0) {
        float avgDepth = 0.5 * (dPlus + dMinus);
        float valley = centerDepth - avgDepth;
        if (valley > 0.05) {
          occ += smoothstep(0.05, 1.8, valley) * smoothstep(7.0, 0.4, valley);
        }
      }
    }
    float ao = clamp(1.0 - (occ / 6.0) * uSsao * 1.45, 0.22, 1.0);
    col *= ao;
  }

  // Add HDR Bloom (Pre-Tonemap + Post-Tonemap Optical Halo)
  vec3 bloomCol = vec3(0.0);
  if (uBloom > 0.001) {
    bloomCol = texture2D(tBloom, uv).rgb;
    float bPeak = max(bloomCol.r, max(bloomCol.g, bloomCol.b));
    vec3 hotCore = vec3(max(bPeak - 0.55, 0.0) * 0.24);
    col += (bloomCol + hotCore) * uBloom * 1.45;
  }

  // Exposure & Tone Mapping (preserve exact theme backdrop & smooth MSAA edges)
  if (uHasDepth == 0) {
    vec3 fg = col * uExposure;
    if (uToneMap == 0) fg = toneMapACES(fg);
    else if (uToneMap == 1) fg = toneMapAgX(fg);
    else if (uToneMap == 2) fg = toneMapNeutral(fg);
    else if (uToneMap == 3) fg = toneMapReinhard(fg);
    else if (uToneMap == 4) fg = toneMapCineon(fg);
    else fg = clamp(fg, 0.0, 1.0);
    vec3 fgSrgb = linearToSrgb(fg);
    if (uBgGradient == 1) {
      float gradT = clamp(uv.y * 0.85 + 0.15 * (1.0 - r2 * 0.35), 0.0, 1.0);
      vec3 bgSrgb = linearToSrgb(mix(uBgBottom, uBgTop, gradT));
      col = mix(bgSrgb, fgSrgb, clamp(alpha, 0.0, 1.0));
      alpha = 1.0;
    } else if (uBgHasSolid == 1) {
      vec3 bgSrgb = linearToSrgb(uBgSolid);
      col = mix(bgSrgb, fgSrgb, clamp(alpha, 0.0, 1.0));
      alpha = 1.0;
    } else {
      col = fgSrgb;
    }
  } else {
    if (!isBackground || uBgGradient == 1) {
      col *= uExposure;
      if (uToneMap == 0) col = toneMapACES(col);
      else if (uToneMap == 1) col = toneMapAgX(col);
      else if (uToneMap == 2) col = toneMapNeutral(col);
      else if (uToneMap == 3) col = toneMapReinhard(col);
      else if (uToneMap == 4) col = toneMapCineon(col);
      else col = clamp(col, 0.0, 1.0);
    } else {
      col = clamp(col, 0.0, 1.0);
    }
    col = linearToSrgb(col);
  }

  if (uBloom > 0.001) {
    vec3 srgbHalo = linearToSrgb(bloomCol * uBloom * 0.65);
    col = clamp(col + srgbHalo * (1.0 - col * 0.42), 0.0, 1.0);
  }

  // Sobel Depth & Luma Edge Outline
  if (uHasDepth == 1 && uEdgeOutline > 0.001) {
    float dN = readLinearDepth(uv + vec2(0.0, texel.y));
    float dS = readLinearDepth(uv - vec2(0.0, texel.y));
    float dE = readLinearDepth(uv + vec2(texel.x, 0.0));
    float dW = readLinearDepth(uv - vec2(texel.x, 0.0));
    float edgeD = clamp((abs(dN - dS) + abs(dE - dW)) / max(centerDepth * 0.055, 0.4), 0.0, 1.0);
    vec3 cN = texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb;
    vec3 cS = texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
    vec3 cE = texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb;
    vec3 cW = texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb;
    float edgeC = clamp(length(cN - cS) + length(cE - cW), 0.0, 1.0);
    float edge = smoothstep(0.18, 0.65, max(edgeD, edgeC * 0.65)) * uEdgeOutline;
    col = mix(col, uEdgeColor, clamp(edge, 0.0, 1.0));
  }

  // White Balance (Temperature & Tint)
  if (abs(uTemperature) > 0.001 || abs(uTint) > 0.001) {
    col.r += uTemperature * 0.14;
    col.b -= uTemperature * 0.14;
    col.g += uTint * 0.11;
    col = clamp(col, 0.0, 1.0);
  }

  // Brightness, Contrast & Saturation
  if (abs(uBrightness) > 0.001) {
    col = clamp(col + uBrightness * 0.45, 0.0, 1.0);
  }
  if (abs(uContrast - 1.0) > 0.001) {
    col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  }
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (abs(uSaturation - 1.0) > 0.001) {
    col = clamp(mix(vec3(luma), col, uSaturation), 0.0, 1.0);
  }

  // Creative LUT / Look Filters
  if (uLut == 1) {
    // Cinema Teal & Orange
    vec3 shadows = vec3(0.04, 0.22, 0.28);
    vec3 highlights = vec3(1.05, 0.88, 0.72);
    col = mix(col * highlights, mix(shadows, highlights, luma), 0.28);
    col = smoothstep(0.02, 0.98, col);
  } else if (uLut == 2) {
    // Kodak Portra Warm Film
    col = pow(col, vec3(0.92, 0.96, 1.04));
    col = mix(vec3(0.06, 0.04, 0.03), vec3(1.0, 0.97, 0.91), col);
  } else if (uLut == 3) {
    // Fuji Velvia Vivid Slide
    col = smoothstep(0.04, 0.96, col);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3(l), col, 1.35), 0.0, 1.0);
  } else if (uLut == 4) {
    // Silver Noir B&W
    float bw = dot(col, vec3(0.299, 0.587, 0.114));
    bw = smoothstep(0.05, 0.94, bw);
    col = vec3(bw);
  } else if (uLut == 5) {
    // Automata Bunker Tactical Sepia/Desaturated
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 sepia = vec3(g * 1.04, g * 0.99, g * 0.87);
    col = mix(sepia, col, 0.22);
    col = smoothstep(0.03, 0.97, col);
  } else if (uLut == 6) {
    // Blueprint CAD Cyanotype
    float bLuma = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 bpBg = vec3(0.04, 0.15, 0.34);
    vec3 bpLine = vec3(0.82, 0.96, 1.0);
    col = mix(bpBg, bpLine, smoothstep(0.15, 0.88, 1.0 - bLuma * 0.65));
  } else if (uLut == 7) {
    // FLIR Thermal Infrared
    float heat = clamp(luma * 0.85 + max(col.r - col.b, 0.0) * 0.65, 0.0, 1.0);
    if (isBackground) heat = 0.04;
    col = ironbowPalette(heat);
  } else if (uLut == 8) {
    // Night Vision Goggles (NVG)
    float nv = pow(clamp(luma * 1.35, 0.0, 1.0), 0.8);
    float scan = 0.9 + 0.1 * sin(uv.y * uResolution.y * 1.4);
    col = vec3(nv * 0.18, nv * 1.05, nv * 0.32) * scan;
  } else if (uLut == 9) {
    // Retro CRT Scanlines & Phosphor Mask
    float scanline = 0.82 + 0.18 * sin(uv.y * uResolution.y * 1.15);
    float grille = 0.92 + 0.08 * sin(uv.x * uResolution.x * 2.1);
    col *= scanline * grille;
  }

  // Vignette
  if (uVignette > 0.001) {
    float vig = 1.0 - smoothstep(0.35, 1.45, r2) * uVignette * 0.88;
    col *= clamp(vig, 0.0, 1.0);
  }

  // Film Grain
  if (uGrain > 0.001) {
    float n = fract(sin(dot(uv * uResolution + vec2(uTime * 17.3, uTime * 31.7), vec2(12.9898, 78.233))) * 43758.5453);
    float grainWeight = (1.0 - abs(luma * 2.0 - 1.0) * 0.55) * uGrain * 0.14;
    col = clamp(col + (n - 0.5) * grainWeight, 0.0, 1.0);
  }

  gl_FragColor = vec4(col, alpha);
}
`;

const FRAG_FXAA = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uInvRes;
varying vec2 vUv;

float fxaaLuma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec4 center = texture2D(tDiffuse, vUv);
  float lumaM = fxaaLuma(center.rgb);
  float lumaN = fxaaLuma(texture2D(tDiffuse, vUv + vec2(0.0, uInvRes.y)).rgb);
  float lumaS = fxaaLuma(texture2D(tDiffuse, vUv - vec2(0.0, uInvRes.y)).rgb);
  float lumaE = fxaaLuma(texture2D(tDiffuse, vUv + vec2(uInvRes.x, 0.0)).rgb);
  float lumaW = fxaaLuma(texture2D(tDiffuse, vUv - vec2(uInvRes.x, 0.0)).rgb);

  float lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
  float lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
  float lumaRange = lumaMax - lumaMin;

  if (lumaRange < max(0.0312, lumaMax * 0.125)) {
    gl_FragColor = center;
    return;
  }

  float lumaNW = fxaaLuma(texture2D(tDiffuse, vUv + vec2(-uInvRes.x,  uInvRes.y)).rgb);
  float lumaNE = fxaaLuma(texture2D(tDiffuse, vUv + vec2( uInvRes.x,  uInvRes.y)).rgb);
  float lumaSW = fxaaLuma(texture2D(tDiffuse, vUv + vec2(-uInvRes.x, -uInvRes.y)).rgb);
  float lumaSE = fxaaLuma(texture2D(tDiffuse, vUv + vec2( uInvRes.x, -uInvRes.y)).rgb);

  float lumaNS = lumaN + lumaS;
  float lumaEW = lumaE + lumaW;
  float lumaNWSW = lumaNW + lumaSW;
  float lumaNENE = lumaNE + lumaSE;
  float lumaNWNE = lumaNW + lumaNE;
  float lumaSWSE = lumaSW + lumaSE;

  float edgeHorz = abs(-2.0 * lumaW + lumaNWSW) + abs(-2.0 * lumaM + lumaNS) * 2.0 + abs(-2.0 * lumaE + lumaNENE);
  float edgeVert = abs(-2.0 * lumaN + lumaNWNE) + abs(-2.0 * lumaM + lumaEW) * 2.0 + abs(-2.0 * lumaS + lumaSWSE);
  bool isHorz = edgeHorz >= edgeVert;

  float luma1 = isHorz ? lumaS : lumaW;
  float luma2 = isHorz ? lumaN : lumaE;
  float grad1 = abs(luma1 - lumaM);
  float grad2 = abs(luma2 - lumaM);
  bool is1Steepest = grad1 >= grad2;
  float gradScaled = 0.25 * max(grad1, grad2);

  float stepLen = isHorz ? uInvRes.y : uInvRes.x;
  float lumaLocalAvg;
  if (is1Steepest) {
    stepLen = -stepLen;
    lumaLocalAvg = 0.5 * (luma1 + lumaM);
  } else {
    lumaLocalAvg = 0.5 * (luma2 + lumaM);
  }

  vec2 curUv = vUv;
  if (isHorz) curUv.y += stepLen * 0.5;
  else curUv.x += stepLen * 0.5;

  vec2 offset = isHorz ? vec2(uInvRes.x, 0.0) : vec2(0.0, uInvRes.y);
  vec2 uv1 = curUv - offset;
  vec2 uv2 = curUv + offset;
  float lumaEnd1 = fxaaLuma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAvg;
  float lumaEnd2 = fxaaLuma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAvg;
  bool reached1 = abs(lumaEnd1) >= gradScaled;
  bool reached2 = abs(lumaEnd2) >= gradScaled;

  for (int i = 0; i < 7; i++) {
    if (reached1 && reached2) break;
    float mult = i < 3 ? 1.0 : (i < 5 ? 2.0 : 4.0);
    if (!reached1) {
      uv1 -= offset * mult;
      lumaEnd1 = fxaaLuma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAvg;
      reached1 = abs(lumaEnd1) >= gradScaled;
    }
    if (!reached2) {
      uv2 += offset * mult;
      lumaEnd2 = fxaaLuma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAvg;
      reached2 = abs(lumaEnd2) >= gradScaled;
    }
  }

  float dist1 = isHorz ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
  float dist2 = isHorz ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
  bool isDir1 = dist1 < dist2;
  float distFinal = min(dist1, dist2);
  float edgeLen = max(dist1 + dist2, 0.0001);
  float pixelOffset = -distFinal / edgeLen + 0.5;

  bool isLumaCenterSmaller = lumaM < lumaLocalAvg;
  bool correctVar = ((isDir1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaCenterSmaller;
  float finalOffset = correctVar ? pixelOffset : 0.0;

  float lumaAvg = (1.0 / 12.0) * (2.0 * (lumaNS + lumaEW) + lumaNWSW + lumaNENE);
  float subOff1 = clamp(abs(lumaAvg - lumaM) / lumaRange, 0.0, 1.0);
  float subOff2 = (-2.0 * subOff1 + 3.0) * subOff1 * subOff1;
  float subOffFinal = subOff2 * subOff2 * 0.75;
  finalOffset = max(finalOffset, subOffFinal);

  vec2 finalUv = vUv;
  if (isHorz) finalUv.y += finalOffset * stepLen;
  else finalUv.x += finalOffset * stepLen;

  gl_FragColor = vec4(texture2D(tDiffuse, finalUv).rgb, center.a);
}
`;

const LUT_INDEX = {
  none: 0,
  'cinema-teal-orange': 1,
  'kodak-portra': 2,
  'fuji-velvia': 3,
  'noir-bw': 4,
  automata: 5,
  blueprint: 6,
  thermal: 7,
  'night-vision': 8,
  'crt-retro': 9,
};

function makeUvCheckerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const cells = 16, step = 512 / cells;
  const palette = ['#2a6f97', '#468faf', '#61a5c2', '#89c2d9', '#2b9348', '#55a630', '#ee9b00', '#ca6702'];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#1f2421' : palette[(x + y * 3) % palette.length];
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 1;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(512, i * step); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeToonGradientTexture() {
  const data = new Uint8Array([55, 115, 185, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeCuttingMatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1b2c24';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = '#2d473b';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = i * 32;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(512, p); ctx.stroke();
  }
  ctx.strokeStyle = '#4f7a65';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = i * 128;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(512, p); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.14, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.34, 'rgba(255,255,255,0.34)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.10)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGfxStudio(ctx) {
  const { renderer, scene, camera, controls, model, groups, key, rim, hemi, floor, leds, segments } = ctx;
  const gfx = { ...DEFAULT_GFX };
  const stagePose = { enabled: false, text: 'FPGA', leds: [true, false, true, false], pwr: true };

  // Snapshot original materials and touch boxes
  const origMaterials = new Map();
  const touchBoxes = [];
  const pcbMeshes = [];
  const displayBezelMeshes = [];
  model.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.userData.isTouchBox) {
      touchBoxes.push(obj);
      return;
    }
    if (!/^(segment_|led_)/.test(obj.name)) {
      origMaterials.set(obj, {
        material: obj.material,
        colorHex: obj.material.color ? obj.material.color.getHex() : 0xffffff,
        roughness: obj.material.roughness ?? 0.5,
        metalness: obj.material.metalness ?? 0.0,
        envMapIntensity: obj.material.envMapIntensity ?? 1.0,
        flatShading: !!obj.material.flatShading,
        wireframe: !!obj.material.wireframe,
      });
    }
    let p = obj;
    while (p && p !== model) {
      if (p.name === 'pcb') { pcbMeshes.push(obj); break; }
      if (p.name === 'display' && !/^segment_/.test(obj.name)) { displayBezelMeshes.push(obj); break; }
      p = p.parent;
    }
  });

  // Extra Studio Lights (added to scene, never to model, preserving model.children.length === 41)
  const studioGroup = new THREE.Group();
  studioGroup.name = 'trace_studio_rig';
  scene.add(studioGroup);

  const fillLight = new THREE.DirectionalLight(0xffdfc2, 0);
  fillLight.position.set(110, 85, 95);
  studioGroup.add(fillLight);

  const cursorLight = new THREE.PointLight(0xfff6e5, 0, 95, 1.6);
  cursorLight.position.set(0, 28, 0);
  studioGroup.add(cursorLight);

  // 3D LED & Display Point Lights + Optical Halo Sprites (stored in studioGroup so model.children stays untouched)
  const tmpBox = new THREE.Box3();
  const tmpWorldPos = new THREE.Vector3();
  const glowHaloTex = makeGlowHaloTexture();
  const ledPointLights = leds.map(l => {
    const pos = tmpBox.setFromObject(l.mesh).getCenter(new THREE.Vector3());
    const pl = new THREE.PointLight(l.id === 'pwrled' ? 0x39d66b : 0xff2921, 0, 32, 1.6);
    pl.position.set(pos.x, pos.y + 3.0, pos.z);
    studioGroup.add(pl);
    return { id: l.id, light: pl, led: l };
  });
  const ledHalos = leds.map(l => {
    const pos = tmpBox.setFromObject(l.mesh).getCenter(new THREE.Vector3());
    const mat = new THREE.SpriteMaterial({
      map: glowHaloTex,
      color: l.id === 'pwrled' ? 0x39d66b : 0xff2921,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(pos.x, pos.y + 1.3, pos.z);
    sprite.scale.set(14, 14, 1);
    sprite.visible = false;
    sprite.renderOrder = 10;
    studioGroup.add(sprite);
    return sprite;
  });
  const digitPointLights = segments.map(seg => {
    const pos = tmpBox.setFromObject(seg.meshes[6]).getCenter(new THREE.Vector3());
    const pl = new THREE.PointLight(0xff2921, 0, 38, 1.5);
    pl.position.set(pos.x, pos.y + 4.2, pos.z);
    studioGroup.add(pl);
    return pl;
  });
  const digitHalos = segments.map(seg => {
    const pos = tmpBox.setFromObject(seg.meshes[6]).getCenter(new THREE.Vector3());
    const mat = new THREE.SpriteMaterial({
      map: glowHaloTex,
      color: 0xff2921,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(pos.x, pos.y + 1.8, pos.z);
    sprite.scale.set(18, 22, 1);
    sprite.visible = false;
    sprite.renderOrder = 10;
    studioGroup.add(sprite);
    return sprite;
  });

  // Floor materials
  const shadowFloorMat = floor.material;
  const matteFloorMat = new THREE.MeshStandardMaterial({ color: 0x20251f, roughness: 0.9, metalness: 0.05 });
  const reflectiveFloorMat = new THREE.MeshPhysicalMaterial({ color: 0x111512, roughness: 0.08, metalness: 0.35, clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.8 });
  let cuttingMatFloorMat = null;

  // Shading Mode override materials
  const clayMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.78, metalness: 0.04 });
  const normalMat = new THREE.MeshNormalMaterial();
  const wireOverlayMat = new THREE.MeshBasicMaterial({ color: 0x1d2618, wireframe: true, transparent: true, opacity: 0.32, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const xrayMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x2ce6ff) }, uRimColor: { value: new THREE.Color(0x80ffaa) } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPos.xyz;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uRimColor;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(vViewPosition);
        float fresnel = pow(1.0 - abs(dot(n, v)), 1.85);
        vec3 c = mix(uColor * 0.25, uRimColor, fresnel);
        gl_FragColor = vec4(c, 0.14 + fresnel * 0.68);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const depthVisMat = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 35.0 }, uFar: { value: 260.0 } },
    vertexShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mvPos.z;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNear;
      uniform float uFar;
      varying float vViewZ;
      void main() {
        float t = 1.0 - clamp((vViewZ - uNear) / max(uFar - uNear, 1.0), 0.0, 1.0);
        t = smoothstep(0.0, 1.0, t);
        gl_FragColor = vec4(vec3(t), 1.0);
      }
    `,
  });
  let uvCheckerTex = null, uvVisMat = null, toonGradTex = null;
  const derivedMatCache = new Map();

  // Procedural PMREM Environments cache
  const envCache = new Map();
  envCache.set('room', scene.environment);

  function getEnvTexture(preset) {
    if (preset === 'off') return null;
    if (envCache.has(preset)) return envCache.get(preset);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const addPanel = (color, intensity, pos, scale) => {
      const m = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
      m.position.set(...pos);
      m.scale.set(...scale);
      envScene.add(m);
    };
    if (preset === 'studio-soft') {
      envScene.background = new THREE.Color(0x141715);
      addPanel(0xffffff, 4.5, [0, 14, 0], [18, 0.5, 14]);
      addPanel(0xfff2e0, 3.2, [-14, 6, 8], [0.5, 10, 12]);
      addPanel(0xd0e4ff, 2.8, [14, 5, -8], [0.5, 9, 12]);
      addPanel(0xffffff, 1.8, [0, 4, 15], [14, 6, 0.5]);
    } else if (preset === 'cyber-grid') {
      envScene.background = new THREE.Color(0x06040d);
      addPanel(0xff1e8a, 6.0, [-12, 9, 6], [1, 8, 16]);
      addPanel(0x00f0ff, 6.0, [12, 8, -6], [1, 8, 16]);
      addPanel(0x7a28ff, 4.5, [0, 14, 0], [16, 0.5, 16]);
      addPanel(0x00ff88, 2.5, [0, -6, 12], [16, 2, 1]);
    } else if (preset === 'sunset') {
      envScene.background = new THREE.Color(0x1f1418);
      addPanel(0xff7b29, 5.5, [-14, 4, 6], [1, 8, 18]);
      addPanel(0xffb866, 3.5, [-8, 11, 4], [12, 1, 12]);
      addPanel(0x4b77be, 2.4, [12, 10, -8], [1, 10, 16]);
    } else if (preset === 'dark-void') {
      envScene.background = new THREE.Color(0x050605);
      addPanel(0xffffff, 2.2, [-10, 14, 6], [6, 0.5, 6]);
    } else {
      const room = new RoomEnvironment();
      const tex = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
      envCache.set(preset, tex);
      return tex;
    }
    const tex = pmrem.fromScene(envScene, 0.04).texture;
    boxGeo.dispose();
    pmrem.dispose();
    envCache.set(preset, tex);
    return tex;
  }

  // Post-Processing Render Targets & Fullscreen Quad
  let rtScene = null, rtSceneMsaa = null, rtPost = null, rtBloomSrc = null, rtBloomA = null, rtBloomB = null;
  let rtW = 0, rtH = 0;
  const maxMsaaSamples = Math.min(4, renderer.capabilities?.maxSamples || 0);
  const blackOccluderMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const blackBgColor = new THREE.Color(0x000000);
  const emitterBloomMats = new Map();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const bloomExtractMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.65 } },
    vertexShader: VERT_POST,
    fragmentShader: FRAG_BLOOM_EXTRACT,
    depthTest: false,
    depthWrite: false,
  });
  const bloomBlurMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uStep: { value: new THREE.Vector2() } },
    vertexShader: VERT_POST,
    fragmentShader: FRAG_BLOOM_BLUR,
    depthTest: false,
    depthWrite: false,
  });
  const fxaaMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uInvRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: VERT_POST,
    fragmentShader: FRAG_FXAA,
    depthTest: false,
    depthWrite: false,
  });
  const uberPostMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.5 },
      uFar: { value: 1600 },
      uIsOrtho: { value: 0 },
      uToneMap: { value: 0 },
      uExposure: { value: 1.15 },
      uBloom: { value: 0 },
      uSsao: { value: 0 },
      uSsaoRadius: { value: 0.5 },
      uDof: { value: 0 },
      uDofFocus: { value: 175 },
      uDofAperture: { value: 0.45 },
      uChroma: { value: 0 },
      uDistortion: { value: 0 },
      uVignette: { value: 0 },
      uGrain: { value: 0 },
      uTime: { value: 0 },
      uSharpen: { value: 0 },
      uEdgeOutline: { value: 0 },
      uEdgeColor: { value: new THREE.Color(0x1b2217) },
      uContrast: { value: 1 },
      uSaturation: { value: 1 },
      uBrightness: { value: 0 },
      uTemperature: { value: 0 },
      uTint: { value: 0 },
      uLut: { value: 0 },
      uBgGradient: { value: 0 },
      uHasDepth: { value: 1 },
      uBgHasSolid: { value: 0 },
      uBgSolid: { value: new THREE.Color(0x20261e) },
      uBgTop: { value: new THREE.Color(0x1a1f18) },
      uBgBottom: { value: new THREE.Color(0x0a0c09) },
    },
    vertexShader: VERT_POST,
    fragmentShader: FRAG_UBER_POST,
    depthTest: false,
    depthWrite: false,
  });
  const postQuad = new THREE.Mesh(quadGeo, uberPostMat);
  const postScene = new THREE.Scene();
  postScene.add(postQuad);

  function ensureRenderTargets(w, h) {
    const pw = Math.max(2, Math.floor(w));
    const ph = Math.max(2, Math.floor(h));
    if (rtScene && rtW === pw && rtH === ph) return;
    rtW = pw; rtH = ph;
    rtScene?.dispose(); rtSceneMsaa?.dispose(); rtPost?.dispose(); rtBloomSrc?.dispose(); rtBloomA?.dispose(); rtBloomB?.dispose();
    const depthTexture = new THREE.DepthTexture(pw, ph);
    depthTexture.type = THREE.UnsignedIntType;
    rtScene = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture,
    });
    rtSceneMsaa = maxMsaaSamples > 0 ? new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType,
      samples: maxMsaaSamples,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    }) : null;
    rtPost = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const bw = Math.max(2, Math.floor(pw / 2)), bh = Math.max(2, Math.floor(ph / 2));
    rtBloomSrc = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    rtBloomA = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    rtBloomB = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  }

  function isPostActive() {
    return (
      gfx.bloom > 0 ||
      gfx.ssao > 0 ||
      gfx.dof > 0 ||
      gfx.chromaticAberration > 0 ||
      Math.abs(gfx.lensDistortion) > 0 ||
      gfx.vignette > 0 ||
      gfx.grain > 0 ||
      gfx.sharpen > 0 ||
      gfx.edgeOutline > 0 ||
      gfx.contrast !== 100 ||
      gfx.saturation !== 100 ||
      gfx.brightness !== 0 ||
      gfx.temperature !== 0 ||
      gfx.tint !== 0 ||
      gfx.lutPreset !== 'none' ||
      gfx.bgMode === 'gradient'
    );
  }

  function syncQualityAndResolution() {
    const qMap = {
      low: [1, 512],
      medium: [1.5, 1024],
      high: [1.75, 2048],
      ultra: [2.25, 4096],
      extreme: [2.75, 4096],
    };
    const [baseRatio, shadowRes] = qMap[gfx.quality] || qMap.high;
    const scale = THREE.MathUtils.clamp(gfx.resScale / 100, 0.25, 2.5);
    renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * scale, baseRatio * scale));
    if (key.shadow.mapSize.x !== shadowRes) {
      key.shadow.mapSize.setScalar(shadowRes);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    renderer.shadowMap.needsUpdate = true;
    ctx.resize?.();
  }

  function syncLighting() {
    const toPos = (azDeg, elDeg, r) => {
      const az = THREE.MathUtils.degToRad(azDeg);
      const el = THREE.MathUtils.degToRad(elDeg);
      const horiz = r * Math.cos(el);
      return new THREE.Vector3(horiz * Math.sin(az), r * Math.sin(el), horiz * Math.cos(az));
    };
    key.position.copy(toPos(gfx.keyAzimuth, gfx.keyElevation, 222));
    key.intensity = gfx.keyIntensity;
    key.color.set(gfx.keyColor);

    rim.position.copy(toPos(gfx.rimAzimuth, gfx.rimElevation, 175));
    rim.intensity = gfx.rimIntensity;
    rim.color.set(gfx.rimColor);

    fillLight.intensity = gfx.fillIntensity;
    fillLight.color.set(gfx.fillColor);

    hemi.intensity = gfx.hemiIntensity;
    hemi.color.set(gfx.skyColor);
    hemi.groundColor.set(gfx.groundColor);

    scene.environment = getEnvTexture(gfx.envPreset);
    scene.environmentIntensity = gfx.envIntensity / 100;
    if (scene.environmentRotation) {
      scene.environmentRotation.set(0, THREE.MathUtils.degToRad(gfx.envRotation), 0);
    }

    cursorLight.color.set(gfx.cursorLightColor);
    cursorLight.intensity = gfx.cursorLight ? gfx.cursorLightInt : 0;

    // Shadows
    const shadowsOn = gfx.shadowType !== 'off';
    renderer.shadowMap.enabled = shadowsOn;
    key.castShadow = shadowsOn;
    if (shadowsOn) {
      const typeMap = {
        'pcf-soft': THREE.PCFSoftShadowMap,
        pcf: THREE.PCFShadowMap,
        basic: THREE.BasicShadowMap,
      };
      const nextType = typeMap[gfx.shadowType] ?? THREE.PCFSoftShadowMap;
      if (renderer.shadowMap.type !== nextType) {
        renderer.shadowMap.type = nextType;
        model.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
      }
      key.shadow.bias = (gfx.shadowBias / 100000);
    }
    shadowFloorMat.opacity = gfx.shadowOpacity / 100;
    renderer.shadowMap.needsUpdate = true;
  }

  function syncToneMappingAndBackdrop() {
    const tmMap = {
      aces: THREE.ACESFilmicToneMapping,
      agx: THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping,
      neutral: THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping,
      reinhard: THREE.ReinhardToneMapping,
      cineon: THREE.CineonToneMapping,
      linear: THREE.LinearToneMapping,
    };
    renderer.toneMapping = tmMap[gfx.toneMapping] ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = gfx.exposure;

    // Floor mode
    if (gfx.floorMode === 'none') {
      floor.material = shadowFloorMat;
      floor.userData.hideFloor = true;
    } else {
      floor.userData.hideFloor = false;
      if (gfx.floorMode === 'shadow') floor.material = shadowFloorMat;
      else if (gfx.floorMode === 'matte') floor.material = matteFloorMat;
      else if (gfx.floorMode === 'reflective') floor.material = reflectiveFloorMat;
      else if (gfx.floorMode === 'grid-floor') {
        if (!cuttingMatFloorMat) {
          cuttingMatFloorMat = new THREE.MeshStandardMaterial({ map: makeCuttingMatTexture(), roughness: 0.75, metalness: 0.05 });
        }
        floor.material = cuttingMatFloorMat;
      }
    }

    // Backdrop mode
    const style = getComputedStyle(document.documentElement);
    if (gfx.bgMode === 'theme') {
      scene.background = scene.background || new THREE.Color();
      scene.background.set(style.getPropertyValue('--board-bg').trim() || '#e9ebe4');
      renderer.setClearAlpha(1);
    } else if (gfx.bgMode === 'solid' || gfx.bgMode === 'gradient') {
      scene.background = scene.background || new THREE.Color();
      scene.background.set(gfx.bgColor);
      renderer.setClearAlpha(1);
    } else if (gfx.bgMode === 'darkroom') {
      scene.background = scene.background || new THREE.Color();
      scene.background.set('#050605');
      renderer.setClearAlpha(1);
    } else if (gfx.bgMode === 'paper') {
      scene.background = scene.background || new THREE.Color();
      scene.background.set('#f2efe6');
      renderer.setClearAlpha(1);
    } else if (gfx.bgMode === 'transparent') {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
  }

  function syncMaterialsAndShading() {
    const mode = gfx.shadingMode;
    const pcbHex = gfx.pcbTheme === 'custom' ? gfx.pcbCustomColor : PCB_THEMES[gfx.pcbTheme];
    const rScale = gfx.roughnessMult / 100;
    const mScale = gfx.metalnessMult / 100;
    const cc = gfx.clearcoat / 100;

    if (mode === 'uv' && !uvVisMat) {
      uvCheckerTex = makeUvCheckerTexture();
      uvVisMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: uvCheckerTex } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uTex;
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          void main() {
            vec2 coord = (length(vUv) > 0.0001) ? vUv : vWorldPos.xz * 0.025 + vec2(0.5);
            vec3 texCol = texture2D(uTex, coord).rgb;
            float shade = 0.65 + 0.35 * max(dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.5))), 0.0);
            gl_FragColor = vec4(texCol * shade, 1.0);
          }
        `,
      });
    }
    if (mode === 'toon' && !toonGradTex) toonGradTex = makeToonGradientTexture();

    for (const [mesh, orig] of origMaterials.entries()) {
      const isPcb = pcbMeshes.includes(mesh);
      const isDisplayBezel = displayBezelMeshes.includes(mesh);
      const isMattePcb = isPcb && orig.metalness < 0.35;
      const isMatteBezel = isDisplayBezel && orig.metalness < 0.35;
      const isMattePlastic = !isPcb && !isDisplayBezel && orig.metalness < 0.15;
      const isBrushedMetal = orig.metalness >= 0.35;
      const baseRoughness = isMattePcb
        ? Math.max(orig.roughness, 0.76)
        : isMatteBezel
          ? Math.max(orig.roughness, 0.78)
          : isMattePlastic
            ? Math.max(orig.roughness, 0.58)
            : isBrushedMetal
              ? Math.max(orig.roughness, 0.36)
              : orig.roughness;
      const targetEnvMapInt = cc > 0.01
        ? orig.envMapIntensity
        : isMattePcb
          ? Math.min(orig.envMapIntensity, 0.28)
          : isMatteBezel
            ? Math.min(orig.envMapIntensity, 0.34)
            : isMattePlastic
              ? Math.min(orig.envMapIntensity, 0.50)
              : isBrushedMetal
                ? Math.min(orig.envMapIntensity, 0.62)
                : orig.envMapIntensity;
      // Determine target base color (only tint greenish/dark solder-mask PCB surfaces when pcbTheme is set)
      let targetColor = orig.colorHex;
      if (isPcb && pcbHex) {
        const c = new THREE.Color(orig.colorHex);
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        if (hsl.l < 0.65) {
          const themeCol = new THREE.Color(pcbHex);
          const tHsl = { h: 0, s: 0, l: 0 };
          themeCol.getHSL(tHsl);
          c.setHSL(tHsl.h, tHsl.s, THREE.MathUtils.clamp(tHsl.l * (0.65 + hsl.l * 0.9), 0.03, 0.92));
          targetColor = c.getHex();
        }
      }

      if (mode === 'pbr' || mode === 'flat' || mode === 'wireframe' || mode === 'wire-on-shaded') {
        if (cc > 0.01 && !(orig.material.isMeshPhysicalMaterial)) {
          let phys = derivedMatCache.get(mesh);
          if (!phys || !phys.isMeshPhysicalMaterial) {
            phys = new THREE.MeshPhysicalMaterial({
              color: targetColor,
              roughness: THREE.MathUtils.clamp(baseRoughness * rScale, 0.02, 1),
              metalness: THREE.MathUtils.clamp(orig.metalness * mScale, 0, 1),
              clearcoat: cc,
              clearcoatRoughness: 0.12,
              envMapIntensity: targetEnvMapInt,
              flatShading: mode === 'flat',
              wireframe: mode === 'wireframe',
            });
            derivedMatCache.set(mesh, phys);
          } else {
            phys.color.setHex(targetColor);
            phys.roughness = THREE.MathUtils.clamp(baseRoughness * rScale, 0.02, 1);
            phys.metalness = THREE.MathUtils.clamp(orig.metalness * mScale, 0, 1);
            phys.clearcoat = cc;
            phys.envMapIntensity = targetEnvMapInt;
            phys.flatShading = mode === 'flat';
            phys.wireframe = mode === 'wireframe';
            phys.needsUpdate = true;
          }
          mesh.material = phys;
        } else {
          mesh.material = orig.material;
          if (mesh.material.color) mesh.material.color.setHex(targetColor);
          if (mesh.material.roughness !== undefined) mesh.material.roughness = THREE.MathUtils.clamp(baseRoughness * rScale, 0.02, 1);
          if (mesh.material.metalness !== undefined) mesh.material.metalness = THREE.MathUtils.clamp(orig.metalness * mScale, 0, 1);
          if (mesh.material.envMapIntensity !== undefined) mesh.material.envMapIntensity = targetEnvMapInt;
          const wantFlat = mode === 'flat' ? true : orig.flatShading;
          if (mesh.material.flatShading !== wantFlat) {
            mesh.material.flatShading = wantFlat;
            mesh.material.needsUpdate = true;
          }
          mesh.material.wireframe = mode === 'wireframe' ? true : orig.wireframe;
        }
      } else if (mode === 'clay') {
        mesh.material = clayMat;
      } else if (mode === 'normals') {
        mesh.material = normalMat;
      } else if (mode === 'depth') {
        mesh.material = depthVisMat;
      } else if (mode === 'uv') {
        mesh.material = uvVisMat;
      } else if (mode === 'xray') {
        mesh.material = xrayMat;
      } else if (mode === 'toon') {
        let toon = derivedMatCache.get(mesh);
        if (!toon || !toon.isMeshToonMaterial) {
          toon = new THREE.MeshToonMaterial({ color: targetColor, gradientMap: toonGradTex });
          derivedMatCache.set(mesh, toon);
        } else {
          toon.color.setHex(targetColor);
        }
        mesh.material = toon;
      } else if (mode === 'unlit') {
        let basic = derivedMatCache.get(mesh);
        if (!basic || !basic.isMeshBasicMaterial) {
          basic = new THREE.MeshBasicMaterial({ color: targetColor });
          derivedMatCache.set(mesh, basic);
        } else {
          basic.color.setHex(targetColor);
        }
        mesh.material = basic;
      }
    }
    renderer.shadowMap.needsUpdate = true;
  }

  function getLedPalette() {
    if (gfx.ledTheme === 'custom') {
      const c = new THREE.Color(gfx.ledCustomColor);
      const off = c.clone().multiplyScalar(0.22);
      const hex = c.getHex(), offHex = off.getHex();
      return { on: hex, em: hex, off: offHex, segOn: hex, segOff: offHex, pwrOn: 0x4fd577, pwrEm: 0x39d66b };
    }
    return LED_THEMES[gfx.ledTheme] || LED_THEMES.default;
  }

  function updateLedsAndSegments(now, state) {
    const pal = getLedPalette();
    const powerOn = stagePose.enabled ? stagePose.pwr : state.power;
    const ledGlowNorm = (gfx.ledGlow ?? (state.glow * 100)) / 100;
    const segGlowNorm = (gfx.segGlow ?? (state.glow * 100)) / 100;
    const bleed = Math.max(gfx.ledLightBleed / 100, (gfx.bloom / 100) * 0.42);
    const ledOverdrive = Math.max(0, ledGlowNorm - 1.0);
    const segOverdrive = Math.max(0, segGlowNorm - 1.0);

    for (let i = 0; i < leds.length; i++) {
      const led = leds[i];
      const isPwr = led.id === 'pwrled';
      const active = powerOn && (isPwr ? true : (stagePose.enabled ? !!stagePose.leds[i] : led.on));
      led.mesh.material.emissive.setHex(isPwr ? pal.pwrEm : pal.em);
      if (active) {
        const coreMix = Math.min(0.45, 0.14 + ledOverdrive * 0.22);
        led.mesh.material.emissive.lerp(new THREE.Color(0xfff4d8), coreMix);
      }
      led.mesh.material.emissiveIntensity = active ? 1.45 + ledGlowNorm * 3.1 + ledOverdrive * 2.2 : 0;
      led.mesh.material.color.setHex(isPwr ? (active ? pal.pwrOn : 0x183520) : (active ? pal.on : pal.off));
      const pl = ledPointLights[i];
      const halo = ledHalos[i];
      if (pl || halo) {
        led.mesh.getWorldPosition(tmpWorldPos);
        if (pl) {
          pl.light.position.set(tmpWorldPos.x, tmpWorldPos.y + 3.0, tmpWorldPos.z);
          pl.light.color.setHex(isPwr ? pal.pwrEm : pal.em);
          pl.light.intensity = active && bleed > 0 ? bleed * (1.1 + ledGlowNorm * 3.6) : 0;
        }
        if (halo) {
          const haloStrength = active && ledGlowNorm > 0.01 ? Math.min(1, 0.28 + ledGlowNorm * 0.56) : 0;
          halo.visible = haloStrength > 0.005;
          if (halo.visible) {
            halo.position.set(tmpWorldPos.x, tmpWorldPos.y + 1.3, tmpWorldPos.z);
            halo.material.color.setHex(isPwr ? pal.pwrEm : pal.em);
            halo.material.opacity = haloStrength;
            const s = (isPwr ? 12 : 14) * (0.72 + Math.min(1.8, ledGlowNorm) * 0.45);
            halo.scale.set(s, s, 1);
          }
        }
      }
    }

    const stagedDigits = stagePose.enabled ? encode7SegText(stagePose.text) : null;
    for (let d = 0; d < segments.length; d++) {
      const digit = segments[d];
      const retained = state.persistence > 0 && now - digit.lastActive < 20 + state.persistence * 240;
      const byte = stagePose.enabled ? stagedDigits[d] : (digit.enabled ? digit.segs : digit.latched);
      const digActive = stagePose.enabled ? true : (digit.enabled || retained);
      let digLitBits = 0;
      for (let bit = 0; bit < 8; bit++) {
        const on = powerOn && digActive && !!(byte & (1 << bit));
        if (on) digLitBits++;
        const material = digit.meshes[bit].material;
        material.emissive.setHex(pal.em);
        if (on) {
          const coreMix = Math.min(0.45, 0.14 + segOverdrive * 0.22);
          material.emissive.lerp(new THREE.Color(0xfff4d8), coreMix);
        }
        material.emissiveIntensity = on ? 1.6 + segGlowNorm * 2.6 + segOverdrive * 2.2 : 0;
        material.color.setHex(on ? pal.segOn : pal.segOff);
      }
      const dLight = digitPointLights[d];
      const dHalo = digitHalos[d];
      if (dLight || dHalo) {
        digit.meshes[6].getWorldPosition(tmpWorldPos);
        const litFrac = digLitBits / 7;
        if (dLight) {
          dLight.position.set(tmpWorldPos.x, tmpWorldPos.y + 4.2, tmpWorldPos.z);
          dLight.color.setHex(pal.em);
          dLight.intensity = bleed > 0 && digLitBits > 0 ? bleed * litFrac * (1.2 + segGlowNorm * 3.2) : 0;
        }
        if (dHalo) {
          const haloStrength = powerOn && digLitBits > 0 && segGlowNorm > 0.01 ? Math.min(0.72, (0.14 + litFrac * 0.34) * (0.45 + segGlowNorm * 0.72)) : 0;
          dHalo.visible = haloStrength > 0.005;
          if (dHalo.visible) {
            dHalo.position.set(tmpWorldPos.x, tmpWorldPos.y + 1.8, tmpWorldPos.z);
            dHalo.material.color.setHex(pal.em);
            dHalo.material.opacity = haloStrength;
            const sc = 0.82 + Math.min(1.6, segGlowNorm) * 0.32;
            dHalo.scale.set(17 * sc, 21 * sc, 1);
          }
        }
      }
    }
  }

  function updateCameraOptics() {
    controls.autoRotateSpeed = gfx.orbitSpeed;
    const dist = Math.max(10, camera.position.distanceTo(controls.target));
    if (gfx.projection === 'orthographic') {
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(gfx.fov * 0.5));
      const halfW = halfH * (camera.aspect || 1);
      camera.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, -600, 1600);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    } else {
      const baseHalfFov = gfx.fov * 0.5;
      const newFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseHalfFov)) * (camera.aspect < 1 ? 1.18 : 1) / Math.min(1, camera.aspect)));
      if (Math.abs(camera.fov - newFov) > 0.01 || camera.userData.wasOrtho) {
        camera.fov = newFov;
        camera.updateProjectionMatrix();
      }
    }
    camera.userData.wasOrtho = gfx.projection === 'orthographic';

    if (Math.abs(gfx.cameraRoll) > 0.01) {
      camera.rotateZ(THREE.MathUtils.degToRad(gfx.cameraRoll));
    }

    if (gfx.dofAutoFocus) {
      if (ctx.getSelectedBox) {
        const selBox = ctx.getSelectedBox();
        if (selBox && !selBox.isEmpty()) {
          gfx.dofFocus = Math.round(camera.position.distanceTo(selBox.getCenter(new THREE.Vector3())));
          return;
        }
      }
      gfx.dofFocus = Math.round(dist);
    }
  }

  function updateCursorLightPosition(worldPoint) {
    if (!worldPoint) return;
    cursorLight.position.set(worldPoint.x, Math.max(worldPoint.y + 22, 18), worldPoint.z);
  }

  function renderEmissiveBloomSource() {
    const prevBg = scene.background;
    const hideTargets = [floor, studioGroup, ctx.grid, ctx.labels, ctx.netGuides, ctx.highlight, ctx.hoverHighlight].filter(Boolean);
    const prevVis = hideTargets.map(o => o.visible);
    for (const o of hideTargets) o.visible = false;

    const saved = [];
    for (const mesh of origMaterials.keys()) {
      saved.push([mesh, mesh.material]);
      mesh.material = blackOccluderMat;
    }
    const swapEmitter = mesh => {
      const src = mesh.material;
      saved.push([mesh, src]);
      let bm = emitterBloomMats.get(mesh);
      if (!bm) {
        bm = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
        emitterBloomMats.set(mesh, bm);
      }
      if (src && src.emissive && src.emissiveIntensity > 0.01) {
        bm.color.copy(src.emissive).multiplyScalar(Math.min(src.emissiveIntensity * 0.68, 2.6));
      } else {
        bm.color.setHex(0x000000);
      }
      mesh.material = bm;
    };
    for (const led of leds) swapEmitter(led.mesh);
    for (const digit of segments) for (const mesh of digit.meshes) swapEmitter(mesh);

    scene.background = blackBgColor;
    renderer.setRenderTarget(rtBloomSrc);
    renderer.clear();
    renderer.render(scene, camera);

    for (let i = 0; i < saved.length; i++) saved[i][0].material = saved[i][1];
    scene.background = prevBg;
    for (let i = 0; i < hideTargets.length; i++) hideTargets[i].visible = prevVis[i];
  }

  function renderFrame(now = performance.now()) {
    floor.visible = !floor.userData.hideFloor && camera.position.y > 0;

    if (!isPostActive()) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      if (gfx.shadingMode === 'wire-on-shaded') {
        renderWireOverlayPass();
      }
      return;
    }

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    ensureRenderTargets(size.x, size.y);

    // 1. Render Scene to HDR RenderTarget (4x hardware MSAA when depth-buffer FX are off, depth target otherwise)
    const needsDepth = gfx.ssao > 0 || gfx.dof > 0 || gfx.edgeOutline > 0 || gfx.lutPreset === 'thermal-flir';
    const useMsaa = !needsDepth && !!rtSceneMsaa;
    const activeSceneRT = useMsaa ? rtSceneMsaa : rtScene;
    const prevBg = scene.background;
    const prevClearAlpha = renderer.getClearAlpha();
    if (useMsaa) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    renderer.setRenderTarget(activeSceneRT);
    renderer.clear();
    renderer.render(scene, camera);
    if (gfx.shadingMode === 'wire-on-shaded') {
      renderWireOverlayPass();
    }
    if (useMsaa) {
      scene.background = prevBg;
      renderer.setClearAlpha(prevClearAlpha);
    }

    // 2. Render Bloom Passes if enabled
    if (gfx.bloom > 0) {
      const selectiveEmissive = gfx.shadingMode === 'pbr' && gfx.bloomThreshold >= 70;
      if (selectiveEmissive) {
        renderEmissiveBloomSource();
      } else {
        bloomExtractMat.uniforms.tDiffuse.value = activeSceneRT.texture;
        bloomExtractMat.uniforms.uThreshold.value = (gfx.bloomThreshold / 100) * 1.35;
        postQuad.material = bloomExtractMat;
        renderer.setRenderTarget(rtBloomA);
        renderer.render(postScene, postCamera);
      }

      const radiusScale = 0.65 + (gfx.bloomRadius / 100) * 2.6;
      const bw = rtBloomA.width, bh = rtBloomA.height;
      const passes = [1.0, 2.2, 4.0, 6.8];
      for (let i = 0; i < passes.length; i++) {
        const spread = passes[i] * radiusScale;
        bloomBlurMat.uniforms.tDiffuse.value = (i === 0 && selectiveEmissive) ? rtBloomSrc.texture : rtBloomA.texture;
        bloomBlurMat.uniforms.uStep.value.set(spread / bw, 0);
        postQuad.material = bloomBlurMat;
        renderer.setRenderTarget(rtBloomB);
        renderer.render(postScene, postCamera);

        bloomBlurMat.uniforms.tDiffuse.value = rtBloomB.texture;
        bloomBlurMat.uniforms.uStep.value.set(0, spread / bh);
        renderer.setRenderTarget(rtBloomA);
        renderer.render(postScene, postCamera);
      }
    }

    // 3. Render Master Uber-Post Shader Pass -> rtPost, then FXAA 3.11 -> Screen
    const u = uberPostMat.uniforms;
    u.tDiffuse.value = activeSceneRT.texture;
    u.tBloom.value = rtBloomA.texture;
    u.tDepth.value = rtScene.depthTexture;
    u.uHasDepth.value = useMsaa ? 0 : 1;
    u.uBgHasSolid.value = (useMsaa && prevBg && prevBg.isColor) ? 1 : 0;
    if (prevBg && prevBg.isColor) u.uBgSolid.value.copy(prevBg);
    u.uResolution.value.set(size.x, size.y);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uIsOrtho.value = gfx.projection === 'orthographic' ? 1 : 0;
    const tmIdx = { aces: 0, agx: 1, neutral: 2, reinhard: 3, cineon: 4, linear: 5 };
    u.uToneMap.value = tmIdx[gfx.toneMapping] ?? 0;
    u.uExposure.value = gfx.exposure;
    u.uBloom.value = gfx.bloom / 100;
    u.uSsao.value = gfx.ssao / 100;
    u.uSsaoRadius.value = gfx.ssaoRadius / 100;
    u.uDof.value = gfx.dof / 100;
    u.uDofFocus.value = gfx.dofFocus;
    u.uDofAperture.value = gfx.dofAperture / 100;
    u.uChroma.value = gfx.chromaticAberration / 100;
    u.uDistortion.value = gfx.lensDistortion / 100;
    u.uVignette.value = gfx.vignette / 100;
    u.uGrain.value = gfx.grain / 100;
    u.uTime.value = (now * 0.001) % 100;
    u.uSharpen.value = gfx.sharpen / 100;
    u.uEdgeOutline.value = gfx.edgeOutline / 100;
    u.uEdgeColor.value.set(gfx.edgeColor);
    u.uContrast.value = gfx.contrast / 100;
    u.uSaturation.value = gfx.saturation / 100;
    u.uBrightness.value = gfx.brightness / 100;
    u.uTemperature.value = gfx.temperature / 100;
    u.uTint.value = gfx.tint / 100;
    u.uLut.value = LUT_INDEX[gfx.lutPreset] ?? 0;
    u.uBgGradient.value = gfx.bgMode === 'gradient' ? 1 : 0;
    u.uBgTop.value.set(gfx.bgColor);
    u.uBgBottom.value.set(gfx.bgColorBottom);

    postQuad.material = uberPostMat;
    renderer.setRenderTarget(rtPost);
    renderer.clear();
    renderer.render(postScene, postCamera);

    // 4. Final FXAA 3.11 Anti-Aliasing Pass to Screen
    fxaaMat.uniforms.tDiffuse.value = rtPost.texture;
    fxaaMat.uniforms.uInvRes.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
    postQuad.material = fxaaMat;
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  }

  function renderWireOverlayPass() {
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevFloorVis = floor.visible;
    for (const tb of touchBoxes) tb.visible = false;
    floor.visible = false;
    renderer.autoClear = false;
    scene.overrideMaterial = wireOverlayMat;
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAutoClear;
    floor.visible = prevFloorVis;
    for (const tb of touchBoxes) tb.visible = true;
  }

  function applyGfx(patch = {}) {
    if (patch.preset && GFX_PRESETS[patch.preset] && Object.keys(patch).length === 1) {
      Object.assign(gfx, GFX_PRESETS[patch.preset]);
    } else if (patch.lightPreset && LIGHT_PRESETS[patch.lightPreset] && Object.keys(patch).length === 1) {
      Object.assign(gfx, LIGHT_PRESETS[patch.lightPreset], { lightPreset: patch.lightPreset, preset: 'custom' });
    } else {
      Object.assign(gfx, patch);
    }
    syncQualityAndResolution();
    syncLighting();
    syncToneMappingAndBackdrop();
    syncMaterialsAndShading();
    return { ...gfx };
  }

  function resetGfx() {
    return applyGfx({ preset: 'default' });
  }

  function setStagePose(patch = {}) {
    Object.assign(stagePose, patch);
    return { ...stagePose };
  }

  function capturePhoto(opts = {}) {
    const {
      resolution = 'viewport',
      aspect = 'free',
      format = 'png',
      transparent = false,
      stamp = 'off',
      caption = '',
      simInfo = '',
    } = opts;

    const canvas = renderer.domElement;
    const origW = canvas.clientWidth || canvas.width;
    const origH = canvas.clientHeight || canvas.height;
    const origPixelRatio = renderer.getPixelRatio();
    const origBgMode = gfx.bgMode;

    const aspectMap = {
      free: origW / Math.max(origH, 1),
      '16:9': 16 / 9,
      '21:9': 21 / 9,
      '4:3': 4 / 3,
      '3:2': 3 / 2,
      '1:1': 1,
      '9:16': 9 / 16,
    };
    const targetAspect = aspectMap[aspect] || (origW / Math.max(origH, 1));
    const baseHeightMap = { viewport: origH, '1080p': 1080, '1440p': 1440, '4k': 2160 };
    let targetH = baseHeightMap[resolution] || origH;
    let targetW = Math.round(targetH * targetAspect);
    if (aspect === '9:16' && resolution !== 'viewport') {
      targetW = baseHeightMap[resolution] || 1080;
      targetH = Math.round(targetW * (16 / 9));
    }

    if (transparent) {
      gfx.bgMode = 'transparent';
      syncToneMappingAndBackdrop();
    }

    renderer.setPixelRatio(1);
    renderer.setSize(targetW, targetH, false);
    camera.aspect = targetW / targetH;
    camera.updateProjectionMatrix();
    updateCameraOptics();
    renderFrame(performance.now());

    // Compose onto export 2D canvas (adds optional studio metadata stamp)
    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetW;
    outCanvas.height = targetH;
    const ctx2d = outCanvas.getContext('2d');
    if (format === 'jpeg' && (transparent || gfx.bgMode === 'transparent')) {
      ctx2d.fillStyle = '#141813';
      ctx2d.fillRect(0, 0, targetW, targetH);
    }
    ctx2d.drawImage(canvas, 0, 0, targetW, targetH);

    if (stamp && stamp !== 'off') {
      drawPhotoStamp(ctx2d, targetW, targetH, stamp, caption, simInfo);
    }

    const mime = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = outCanvas.toDataURL(mime, 0.95);

    // Restore original viewport state
    if (transparent) {
      gfx.bgMode = origBgMode;
      syncToneMappingAndBackdrop();
    }
    renderer.setPixelRatio(origPixelRatio);
    renderer.setSize(origW, origH, false);
    camera.aspect = origW / Math.max(origH, 1);
    camera.updateProjectionMatrix();
    updateCameraOptics();
    renderFrame(performance.now());

    return { dataUrl, width: targetW, height: targetH, format, mime };
  }

  function drawPhotoStamp(ctx2d, w, h, position, caption, simInfo) {
    const scale = Math.max(0.75, Math.min(2.4, Math.min(w, h) / 900));
    const pad = Math.round(24 * scale);
    const boxH = Math.round((caption ? 66 : 48) * scale);
    const titleText = caption || 'RZ-EASYFPGA A2.2 · CYCLONE IV EP4CE6E22C8N';
    const focalMm = Math.round(24 / (2 * Math.tan(THREE.MathUtils.degToRad(gfx.fov * 0.5))));
    const subText = `trace. workbench · ${focalMm}mm (${gfx.fov}°) · ${gfx.shadingMode.toUpperCase()}${simInfo ? ' · ' + simInfo : ''}`;

    ctx2d.save();
    ctx2d.font = `600 ${Math.round(14 * scale)}px "Segoe UI", system-ui, sans-serif`;
    const w1 = ctx2d.measureText(titleText).width;
    ctx2d.font = `400 ${Math.round(11 * scale)}px "Cascadia Code", Consolas, monospace`;
    const w2 = ctx2d.measureText(subText).width;
    const boxW = Math.round(Math.max(w1, w2) + 56 * scale);

    let x = pad, y = h - pad - boxH;
    if (position === 'top-left') { x = pad; y = pad; }
    else if (position === 'bottom-right') { x = w - pad - boxW; y = h - pad - boxH; }

    ctx2d.fillStyle = 'rgba(20, 24, 19, 0.78)';
    ctx2d.strokeStyle = 'rgba(210, 233, 145, 0.38)';
    ctx2d.lineWidth = Math.max(1, scale);
    ctx2d.beginPath();
    ctx2d.roundRect(x, y, boxW, boxH, Math.round(8 * scale));
    ctx2d.fill();
    ctx2d.stroke();

    // Accent bar
    ctx2d.fillStyle = '#d2e991';
    ctx2d.beginPath();
    ctx2d.roundRect(x + Math.round(12 * scale), y + Math.round(12 * scale), Math.round(4 * scale), boxH - Math.round(24 * scale), 2);
    ctx2d.fill();

    ctx2d.fillStyle = '#f2f5ec';
    ctx2d.font = `600 ${Math.round(13.5 * scale)}px "Segoe UI", system-ui, sans-serif`;
    ctx2d.fillText(titleText, x + Math.round(26 * scale), y + Math.round(24 * scale));

    ctx2d.fillStyle = '#b7c2ab';
    ctx2d.font = `400 ${Math.round(10.5 * scale)}px "Cascadia Code", Consolas, monospace`;
    ctx2d.fillText(subText, x + Math.round(26 * scale), y + Math.round(42 * scale));
    ctx2d.restore();
  }

  syncLighting();
  syncMaterialsAndShading();

  return {
    get gfx() { return gfx; },
    get stagePose() { return stagePose; },
    applyGfx,
    resetGfx,
    setStagePose,
    syncToneMappingAndBackdrop,
    updateLedsAndSegments,
    updateCameraOptics,
    updateCursorLightPosition,
    renderFrame,
    capturePhoto,
  };
}
