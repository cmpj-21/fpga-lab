import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { PIN_NET, COMPONENTS } from './boardDef.js';

export async function createBoard3D(canvas, opts = {}) {
  const asset = await new GLTFLoader().loadAsync('/assets/rz-easyfpga-a2.2.glb');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ebe4);
  const camera = new THREE.PerspectiveCamera(38, 1, .5, 1600);
  camera.position.set(110, 140, 155);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  controls.minDistance = 24;
  controls.maxDistance = 550;
  controls.target.set(0, 3, 0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, .04).texture;
  scene.environmentIntensity = .65;
  room.dispose();
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xfffaf2, 2.7);
  key.position.set(-80, 180, 100);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 20, far: 450 });
  key.shadow.bias = -.00015;
  key.shadow.normalBias = .04;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe8eeff, 1.5);
  rim.position.set(80, 100, -120);
  scene.add(rim, new THREE.HemisphereLight(0xffffff, 0x8b8d85, 1.4));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.ShadowMaterial({ opacity: .13 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -4;
  floor.receiveShadow = true;
  scene.add(floor);
  const model = asset.scene;
  model.name = 'RZ-EasyFPGA-A2.2';
  model.scale.setScalar(1000);
  model.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  scene.add(model);
  model.updateMatrixWorld(true);
  const groups = Object.fromEntries(model.children.map(object => [object.name, object]));
  const state = { power: true, persistence: .6, glow: .4, explode: 0, explodeTarget: 0, tween: null };
  const segments = Array.from({ length: 4 }, (_, digit) => ({ segs: 0, latched: 0, enabled: false, lastActive: -Infinity,
    meshes: Array.from({ length: 8 }, (_, bit) => {
      const mesh = model.getObjectByName(`segment_${digit}_${bit}`);
      mesh.material = mesh.material.clone();
      mesh.material.color.set(0x361c22);
      mesh.material.emissive.set(0xff2921);
      mesh.material.emissiveIntensity = 0;
      return mesh;
    })
  }));
  const leds = ['led1', 'led2', 'led3', 'led4', 'pwrled'].map(id => {
    const mesh = model.getObjectByName(`led_${id}_lens`);
    mesh.material = mesh.material.clone();
    mesh.material.emissive.set(id === 'pwrled' ? 0x39d66b : 0xff2921);
    return { id, mesh, on: false };
  });
  const keys = ['key1', 'key2', 'key3', 'key4', 'reset'].map(id => {
    const cap = model.getObjectByName(`key_${id}_cap`);
    cap.userData.key = id;
    return { id, cap, baseY: cap.position.y, target: 0, press: 0 };
  });
  for (const { id } of keys) groups[id].traverse(object => { if (object.isMesh) object.userData.key = id; });
  const floating = Object.values(groups).filter(g => !['pcb', 'pcb_details', 'routing', 'passives'].includes(g.name)).map(g => ({ group: g, y: g.position.y, lift: g.name === 'fpga' ? .035 : .018 }));
  const labels = new THREE.Group();
  labels.visible = false;
  scene.add(labels);
  for (const [id, title] of [['fpga', 'EP4CE6 · EQFP-144'], ['display', 'Multiplexed display'], ['sdram', '64 Mbit SDRAM'], ['oscillator', '50 MHz oscillator'], ['jtag', 'JTAG'], ['as', 'AS configuration'], ['vga', 'VGA'], ['rs232', 'RS-232']]) {
    const image = document.createElement('canvas'); image.width = 384; image.height = 64;
    const texture = new THREE.CanvasTexture(image); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
    sprite.scale.set(31, 5.2, 1); sprite.userData.component = groups[id]; sprite.userData.title = title; labels.add(sprite);
  }
  const grid = new THREE.GridHelper(300, 30, 0xa5ac9c, 0xc9cec0);
  grid.position.y = -4; grid.visible = false; scene.add(grid);
  function setTheme() {
    const style = getComputedStyle(document.documentElement);
    scene.background.set(style.getPropertyValue('--board-bg').trim());
    grid.material.transparent = true;
    grid.material.opacity = document.documentElement.dataset.theme === 'dark' ? .2 : 1;
    for (const sprite of labels.children) {
      const texture = sprite.material.map, context = texture.image.getContext('2d');
      context.clearRect(0, 0, 384, 64);
      context.fillStyle = style.getPropertyValue('--label-bg').trim();
      context.beginPath(); context.roundRect(1, 1, 382, 62, 10); context.fill();
      context.font = '26px Segoe UI'; context.fillStyle = style.getPropertyValue('--label-text').trim();
      context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(sprite.userData.title, 192, 32);
      texture.needsUpdate = true;
    }
  }
  setTheme();
  const netGuides = new THREE.Group(); netGuides.visible = false; scene.add(netGuides);
  for (const id of ['key1', 'key2', 'key3', 'key4', 'reset', 'display', 'led1', 'led2', 'led3', 'led4']) {
    const a = groups.fpga.getWorldPosition(new THREE.Vector3());
    const b = groups[id].getWorldPosition(new THREE.Vector3());
    a.y = b.y = 13;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({ color: 0x6c864d, dashSize: 2, gapSize: 1.2, transparent: true, opacity: .65 }));
    line.computeLineDistances(); netGuides.add(line);
  }
  const highlight = new THREE.Box3Helper(new THREE.Box3(), 0x87a751);
  highlight.visible = false; scene.add(highlight);
  let highlightUntil = 0;
  const presets = {
    hero: { pos: [110, 140, 155], target: [0, 3, 0] },
    top: { pos: [0, 240, .5], target: [0, 0, 0] },
    underside: { pos: [75, -210, 142], target: [0, 0, 0] },
    fpga: { pos: [12, 61, 64], target: [-13, 3, -1] },
    display: { pos: [36, 52, 24], target: [25.3, 6, -35.8] },
    dtubes: { pos: [25.3, 65, -16], target: [25.3, 9.8, -35.8] },
    leds: { pos: [34.5, 45, -1], target: [34.5, 2, -22] },
    io: { pos: [162, 43, 38], target: [58, 5, 4] }
  };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setCamera(name) {
    const preset = presets[name] || presets.hero;
    const pos = new THREE.Vector3(...preset.pos), target = new THREE.Vector3(...preset.target);
    if (reducedMotion) { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
    else state.tween = { pos, target };
  }
  controls.addEventListener('start', () => { state.tween = null; });
  function resize() {
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(19)) * (camera.aspect < 1 ? 1.18 : 1) / Math.min(1, camera.aspect)));
    camera.updateProjectionMatrix();
  }
  function setQuality(quality) {
    const config = { low: [1, 512], medium: [1.5, 1024], high: [1.75, 2048] }[quality];
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, config[0]));
    key.shadow.mapSize.setScalar(config[1]);
    key.shadow.map?.dispose(); key.shadow.map = null;
    renderer.shadowMap.needsUpdate = true; resize();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  setQuality('high');
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let activeKey = null;
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(model, true)[0];
    return hit?.object.userData.key || null;
  }
  canvas.addEventListener('pointerdown', event => {
    if (!state.power || event.button !== 0) return;
    const id = pick(event);
    if (!id) return;
    activeKey = id; controls.enabled = false;
    opts.onKey?.(id, true); canvas.setPointerCapture(event.pointerId);
  }, { capture: true });
  function releaseKey() {
    if (!activeKey) return;
    opts.onKey?.(activeKey, false); activeKey = null; controls.enabled = true;
  }
  canvas.addEventListener('pointerup', releaseKey);
  canvas.addEventListener('pointercancel', releaseKey);
  canvas.addEventListener('lostpointercapture', releaseKey);
  window.addEventListener('blur', releaseKey);
  canvas.addEventListener('pointermove', event => { if (!activeKey) canvas.style.cursor = state.power && pick(event) ? 'pointer' : 'grab'; });
  let previous = performance.now(), fps = 60;
  function update(now, dt) {
    if (state.tween) {
      const speed = 1 - Math.exp(-dt * 9);
      camera.position.lerp(state.tween.pos, speed); controls.target.lerp(state.tween.target, speed);
      if (camera.position.distanceTo(state.tween.pos) < .05) {
        camera.position.copy(state.tween.pos); controls.target.copy(state.tween.target); state.tween = null;
      }
    }
    controls.update();
    floor.visible = camera.position.y > 0;
    const delta = state.explodeTarget - state.explode;
    if (Math.abs(delta) > .0001) {
      state.explode += delta * (reducedMotion ? 1 : Math.min(1, dt * 8));
      for (const { group, y, lift } of floating) group.position.y = y + lift * state.explode;
      renderer.shadowMap.needsUpdate = true;
    }
    for (const key of keys) {
      key.press += (key.target - key.press) * (reducedMotion ? 1 : Math.min(1, dt * 22));
      key.cap.position.y = key.baseY - key.press * .0006;
    }
    for (const led of leds) {
      const on = state.power && (led.id === 'pwrled' || led.on);
      led.mesh.material.emissiveIntensity = on ? .7 + state.glow * 2.4 : 0;
      led.mesh.material.color.setHex(led.id === 'pwrled' ? (on ? 0x4fd577 : 0x183520) : (on ? 0xf55f48 : 0x491c20));
    }
    for (const digit of segments) {
      const retained = state.persistence > 0 && now - digit.lastActive < 20 + state.persistence * 240;
      const byte = digit.enabled ? digit.segs : digit.latched;
      for (let bit = 0; bit < 8; bit++) {
        const on = state.power && (digit.enabled || retained) && !!(byte & (1 << bit));
        const material = digit.meshes[bit].material;
        material.emissiveIntensity = on ? 1 + state.glow * 1.7 : 0;
        material.color.setHex(on ? 0xe84e3c : 0x361c22);
      }
    }
    if (labels.visible) for (const sprite of labels.children) {
      sprite.userData.component.getWorldPosition(sprite.position); sprite.position.y += 17;
    }
    highlight.visible = now < highlightUntil;
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - previous) / 1000); previous = now;
    fps += (1 / Math.max(dt, .0001) - fps) * .04;
    update(now, dt); renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  return {
    scene, camera, renderer, controls, model,
    setLed(i, on) { if (leds[i]) leds[i].on = on; },
    setLedById(id, on) { const led = leds.find(item => item.id === id); if (led) led.on = on; },
    setSegDigit(index, segs, enabled) {
      const digit = segments[index]; digit.segs = segs; digit.enabled = enabled;
      if (enabled) { digit.latched = segs; digit.lastActive = performance.now(); }
    },
    clearOutputs() {
      for (const digit of segments) Object.assign(digit, { segs: 0, latched: 0, enabled: false, lastActive: -Infinity });
      for (const led of leds) led.on = false;
    },
    get displayState() { return segments.map(({ segs, latched, enabled }) => ({ segs, latched, enabled })); },
    setKeyVisual(id, pressed) { const key = keys.find(k => k.id === id); if (key) key.target = pressed ? 1 : 0; },
    setBuzzer(on) { groups.buzzer.userData.active = state.power && on; },
    setPower(on) {
      state.power = on;
      model.getObjectByName('power_cap').position.y = on ? .0066 : .0075;
      renderer.shadowMap.needsUpdate = true;
      if (!on) { releaseKey(); for (const key of keys) key.target = 0; }
    },
    setDip(mask) { for (let i = 0; i < 4; i++) model.getObjectByName(`dip_${i}`).position.z = mask & (1 << i) ? -.00085 : .00085; },
    highlightPin(pin) {
      const net = PIN_NET[pin];
      const component = COMPONENTS.find(c => c.net === net);
      const id = component?.id || (/^(seg_|dtube)/.test(net) ? 'display' : /^vga_/.test(net) ? 'vga' : /^uart_/.test(net) ? 'rs232' : net === 'clk' ? 'oscillator' : net === 'beep' ? 'buzzer' : null);
      if (!id) return;
      highlight.box.setFromObject(groups[id]).expandByScalar(1); highlightUntil = performance.now() + 1800;
    },
    setExplode(value) { state.explodeTarget = value; },
    setPersistence(value) { state.persistence = value; },
    setGlow(value) { state.glow = value; },
    setLabels(value) { labels.visible = value; },
    setGrid(value) { grid.visible = value; },
    setTraces(value) { netGuides.visible = value; },
    setAutoOrbit(value) { controls.autoRotate = value; controls.autoRotateSpeed = .6; },
    setQuality, setCamera, setTheme,
    screenshot() { update(performance.now(), .05); renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    resetView() { setCamera('hero'); },
    get fps() { return fps; }
  };
}
