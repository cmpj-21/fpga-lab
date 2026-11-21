import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { PIN_NET, COMPONENTS, BOARD_PARTS } from './boardDef.js';
import { createGfxStudio } from './gfxStudio.js';

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
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8b8d85, 1.4);
  scene.add(rim, hemi);
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
  const state = { power: true, persistence: .6, glow: .4, explode: 0, explodeTarget: 0, tween: null, navMode: 'orbit', toolMode: 'interact', selected: null, hovered: null, hideOutline: false };
  function syncCameraButtons() {
    const mode = state.navMode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.mouseButtons.LEFT = mode;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = state.navMode === 'pan' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    if (controls.touches) controls.touches.ONE = state.navMode === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }
  syncCameraButtons();
  canvas.addEventListener('contextmenu', event => event.preventDefault());
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
    cap.userData.partId = id;
    return { id, cap, baseY: cap.position.y, target: 0, press: 0 };
  });
  for (const { id } of keys) groups[id].traverse(object => { if (object.isMesh) { object.userData.key = id; object.userData.partId = id; } });
  const touchMat = new THREE.MeshBasicMaterial({ visible: false });
  const dipLevers = [0, 1, 2, 3].map(i => model.getObjectByName(`dip_${i}`));
  dipLevers.forEach((lever, i) => { if (lever) { lever.userData.dip = i; lever.userData.partId = `dip_${i}`; } });
  if (groups.dip && dipLevers.every(Boolean)) {
    groups.dip.userData.partId = 'dip';
    const dipEdges = [-.0056, ...[0, 1, 2].map(i => (dipLevers[i].position.x + dipLevers[i + 1].position.x) / 2), .0056];
    for (let i = 0; i < 4; i++) {
      // Expand raycast touch boxes to cover each full switch lane (ON label, slot, lever, and digit)
      const hitBox = new THREE.Mesh(new THREE.BoxGeometry(dipEdges[i + 1] - dipEdges[i], .0043, .0112), touchMat);
      hitBox.name = `dip_touch_${i}`;
      hitBox.position.set((dipEdges[i] + dipEdges[i + 1]) / 2, .00465, 0);
      hitBox.userData = { dip: i, partId: `dip_${i}`, isTouchBox: true };
      groups.dip.add(hitBox);
    }
  }
  if (groups.display) {
    groups.display.userData.partId = 'display';
    for (let d = 0; d < 4; d++) {
      const hitBox = new THREE.Mesh(new THREE.BoxGeometry(.0098, .0032, .0144), touchMat);
      hitBox.name = `dtube_touch_${d}`;
      hitBox.position.set((-1.5 + d) * .0095, .0076, 0);
      hitBox.userData = { partId: `dtube${d + 1}`, isTouchBox: true };
      groups.display.add(hitBox);
    }
  }
  const floating = Object.values(groups).filter(g => !['pcb', 'pcb_details', 'routing', 'passives'].includes(g.name)).map(g => ({ group: g, y: g.position.y, lift: g.name === 'fpga' ? .035 : .018 }));
  for (const { group: g } of floating) {
    if (!g.userData.partId) g.userData.partId = g.name;
    if (g.name === 'power_switch') g.userData.power = true;
    if (g.name === 'dip' || g.name === 'display') continue;
    g.updateWorldMatrix(true, true);
    const inv = g.matrixWorld.clone().invert(), localBox = new THREE.Box3();
    g.traverse(m => {
      if (m.isMesh && !m.userData.isTouchBox) {
        m.geometry.computeBoundingBox();
        localBox.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv));
      }
    });
    if (localBox.isEmpty()) continue;
    const size = localBox.getSize(new THREE.Vector3()), center = localBox.getCenter(new THREE.Vector3());
    const isRowLed = /^led[1-4]$/.test(g.name);
    const sx = Math.max(size.x + .0012, isRowLed ? .0058 : .0052);
    const sy = Math.max(size.y + .0014, .0034);
    const sz = Math.max(size.z + (isRowLed ? .0004 : .0012), isRowLed ? .0033 : .0052);
    const hitBox = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), touchMat);
    hitBox.name = `part_touch_${g.name}`;
    hitBox.position.set(center.x, Math.max(center.y, sy * .5), center.z);
    hitBox.userData = { partId: g.name, key: keys.find(k => k.id === g.name)?.id || null, power: g.name === 'power_switch', isTouchBox: true };
    g.add(hitBox);
  }
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
  let studio = null;
  function setTheme() {
    const style = getComputedStyle(document.documentElement);
    if (!studio || studio.gfx.bgMode === 'theme') {
      if (!scene.background) scene.background = new THREE.Color();
      scene.background.set(style.getPropertyValue('--board-bg').trim());
    } else {
      studio.syncToneMappingAndBackdrop();
    }
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
  const hoverHighlight = new THREE.Box3Helper(new THREE.Box3(), 0x9ab074);
  hoverHighlight.material.transparent = true; hoverHighlight.material.opacity = .5;
  hoverHighlight.visible = false; scene.add(hoverHighlight);
  let highlightUntil = 0;
  function computePartBox(partId, outBox = new THREE.Box3()) {
    outBox.makeEmpty();
    const meta = BOARD_PARTS[partId];
    if (meta?.subMesh) {
      const sub = model.getObjectByName(meta.subMesh);
      if (sub) { outBox.setFromObject(sub).expandByScalar(.35); return outBox; }
    }
    const group = groups[meta?.group || partId];
    if (!group) return outBox;
    group.traverse(m => { if (m.isMesh && !m.userData.isTouchBox) outBox.expandByObject(m); });
    if (!outBox.isEmpty()) outBox.expandByScalar(.65);
    return outBox;
  }
  function selectPart(partId) {
    const next = partId && BOARD_PARTS[partId] ? partId : null;
    state.selected = next;
    if (next) computePartBox(next, highlight.box);
    opts.onSelect?.(next ? BOARD_PARTS[next] : null);
    return next ? BOARD_PARTS[next] : null;
  }
  const presets = {
    hero: { pos: [110, 140, 155], target: [0, 3, 0] },
    top: { pos: [0, 240, .5], target: [0, 0, 0] },
    underside: { pos: [75, -210, 142], target: [0, 0, 0] },
    fpga: { pos: [12, 61, 64], target: [-13, 3, -1] },
    display: { pos: [36, 52, 24], target: [25.3, 6, -35.8] },
    dtubes: { pos: [25.3, 65, -16], target: [25.3, 9.8, -35.8] },
    leds: { pos: [10.25, 45, 60], target: [10.25, 2, 39] },
    io: { pos: [162, 43, 38], target: [58, 5, 4] },
    isometric: { pos: [148, 148, 148], target: [0, 2, 0] },
    macro_low: { pos: [62, 24, 96], target: [-6, 4, 8] },
    side_profile: { pos: [0, 24, 172], target: [0, 3, 0] }
  };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setCamera(name) {
    const preset = presets[name] || presets.hero;
    const pos = new THREE.Vector3(...preset.pos), target = new THREE.Vector3(...preset.target);
    if (reducedMotion) { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
    else state.tween = { pos, target };
  }
  function centerSelected(partId = state.selected) {
    if (!partId || !BOARD_PARTS[partId]) { setCamera('hero'); return false; }
    const box = computePartBox(partId);
    if (box.isEmpty()) { setCamera('hero'); return false; }
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 6);
    const geomMean = Math.sqrt(Math.max(size.x, 4) * Math.max(size.z, 4));
    const effectiveSpan = geomMean * .65 + maxDim * .35;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-4) dir.set(.45, .75, .55);
    dir.normalize();
    if (Math.abs(dir.y) < .28) { dir.y = dir.y < 0 ? -.45 : .55; dir.normalize(); }
    const dist = THREE.MathUtils.clamp(effectiveSpan * 1.35 + 36, 42, 96);
    const pos = target.clone().addScaledVector(dir, dist);
    if (reducedMotion) { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
    else state.tween = { pos, target };
    return true;
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
    const config = { low: [1, 512], medium: [1.5, 1024], high: [1.75, 2048], ultra: [2.25, 4096], extreme: [2.75, 4096] }[quality] || [1.75, 2048];
    if (studio) studio.gfx.quality = quality;
    const scale = studio ? THREE.MathUtils.clamp(studio.gfx.resScale / 100, 0.25, 2.5) : 1;
    renderer.setPixelRatio(Math.min((devicePixelRatio || 1) * scale, config[0] * scale));
    key.shadow.mapSize.setScalar(config[1]);
    key.shadow.map?.dispose(); key.shadow.map = null;
    renderer.shadowMap.needsUpdate = true; resize();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  setQuality('high');
  studio = createGfxStudio({
    renderer, scene, camera, controls, model, groups, key, rim, hemi, floor, leds, segments,
    grid, labels, netGuides, highlight, hoverHighlight, resize,
    getSelectedBox: () => state.selected ? computePartBox(state.selected) : null,
  });
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), groundHit = new THREE.Vector3();
  let activeKey = null, pointerState = null;
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObject(model, true);
    for (const hit of hits) {
      let obj = hit.object;
      if (obj.parent?.name === 'pcb') return null;
      let keyId = null, dipIdx = undefined, power = false, partId = null;
      while (obj && obj !== model) {
        if (!keyId && obj.userData.key) keyId = obj.userData.key;
        if (dipIdx === undefined && obj.userData.dip !== undefined) dipIdx = obj.userData.dip;
        if (!power && obj.userData.power) power = true;
        if (!partId && obj.userData.partId) partId = obj.userData.partId;
        obj = obj.parent;
      }
      if (partId || keyId || dipIdx !== undefined || power) {
        return {
          partId: partId || (dipIdx !== undefined ? `dip_${dipIdx}` : keyId),
          type: keyId ? 'key' : dipIdx !== undefined ? 'dip' : power ? 'power' : 'part',
          id: keyId,
          index: dipIdx,
        };
      }
    }
    return null;
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const target = pick(event);
    if (state.toolMode === 'interact' && target?.type === 'key') {
      activeKey = target.id; controls.enabled = false;
      opts.onKey?.(target.id, true); canvas.setPointerCapture(event.pointerId);
      return;
    }
    pointerState = { x: event.clientX, y: event.clientY, dragged: false, target };
  }, { capture: true });
  canvas.addEventListener('dblclick', event => {
    if (event.button !== 0 || state.toolMode !== 'select') return;
    const target = pick(event);
    if (!target) return;
    selectPart(target.partId);
    centerSelected(target.partId);
  });
  function releaseKey(event) {
    if (pointerState && (!event || event.button === undefined || event.button === 0)) {
      const { dragged, target } = pointerState;
      pointerState = null;
      if (!dragged && event?.type === 'pointerup') {
        if (state.photoFocusPick) {
          const rect = canvas.getBoundingClientRect();
          pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
          ray.setFromCamera(pointer, camera);
          const hits = ray.intersectObject(model, true).filter(h => !h.object.userData.isTouchBox);
          if (hits.length) {
            const dist = Math.round(hits[0].distance);
            studio.applyGfx({ dofFocus: dist, dofAutoFocus: false });
            opts.onFocusPick?.(dist, event.clientX - rect.left, event.clientY - rect.top);
          }
        } else if (state.toolMode === 'select') {
          selectPart(target ? target.partId : null);
        } else if (target) {
          if (target.type === 'power') opts.onPower?.(!state.power);
          else if (target.type === 'dip') opts.onDip?.(target.index);
        }
      }
    }
    if (!activeKey) return;
    opts.onKey?.(activeKey, false); activeKey = null; controls.enabled = true;
  }
  canvas.addEventListener('pointerup', releaseKey);
  canvas.addEventListener('pointercancel', () => { pointerState = null; releaseKey(); });
  canvas.addEventListener('lostpointercapture', () => { pointerState = null; releaseKey(); });
  window.addEventListener('blur', () => { pointerState = null; releaseKey(); });
  canvas.addEventListener('pointerleave', () => { state.hovered = null; hoverHighlight.visible = false; });
  canvas.addEventListener('pointermove', event => {
    if (pointerState) {
      if (Math.hypot(event.clientX - pointerState.x, event.clientY - pointerState.y) > 4) pointerState.dragged = true;
      if (pointerState.dragged) { hoverHighlight.visible = false; canvas.style.cursor = 'grabbing'; return; }
    }
    if (activeKey) return;
    if (studio?.gfx.cursorLight) {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(pointer, camera);
      if (ray.ray.intersectPlane(groundPlane, groundHit)) studio.updateCursorLightPosition(groundHit);
    }
    const hit = pick(event);
    if (state.toolMode === 'select') {
      state.hovered = hit?.partId || null;
      if (!state.hideOutline && state.hovered && state.hovered !== state.selected) {
        computePartBox(state.hovered, hoverHighlight.box);
        hoverHighlight.visible = true;
      } else {
        hoverHighlight.visible = false;
      }
      const meta = state.hovered ? BOARD_PARTS[state.hovered] : null;
      canvas.title = meta ? `${meta.title} (${meta.part})` : '';
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    } else {
      state.hovered = null;
      hoverHighlight.visible = false;
      canvas.title = '';
      const canInteract = hit && (hit.type === 'power' || (state.power && (hit.type === 'key' || hit.type === 'dip')));
      canvas.style.cursor = canInteract ? 'pointer' : 'grab';
    }
  });
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
      if (state.selected) computePartBox(state.selected, highlight.box);
      if (state.hovered) computePartBox(state.hovered, hoverHighlight.box);
    }
    for (const key of keys) {
      const prevPress = key.press;
      key.press += (key.target - key.press) * (reducedMotion ? 1 : Math.min(1, dt * 22));
      key.cap.position.y = key.baseY - key.press * .0006;
      if (Math.abs(key.press - prevPress) > 1e-4) renderer.shadowMap.needsUpdate = true;
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
    studio?.updateLedsAndSegments(now, state);
    studio?.updateCameraOptics();
    if (labels.visible) for (const sprite of labels.children) {
      sprite.userData.component.getWorldPosition(sprite.position); sprite.position.y += 17;
    }
    highlight.visible = !state.hideOutline && (!!state.selected || now < highlightUntil);
  }
  let lastRender = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (studio?.gfx.fpsCap > 0 && now - lastRender < (1000 / studio.gfx.fpsCap) * 0.92) return;
    lastRender = now;
    const dt = Math.min(.05, (now - previous) / 1000); previous = now;
    fps += (1 / Math.max(dt, .0001) - fps) * .04;
    update(now, dt);
    if (studio) studio.renderFrame(now);
    else renderer.render(scene, camera);
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
    setDip(mask) { for (let i = 0; i < 4; i++) model.getObjectByName(`dip_${i}`).position.z = mask & (1 << i) ? -.00085 : .00085; renderer.shadowMap.needsUpdate = true; },
    highlightPin(pin) {
      const net = PIN_NET[pin];
      const component = COMPONENTS.find(c => c.net === net);
      const id = component?.id || (/^dtube([1-4])$/.test(net) ? net : /^seg_/.test(net) ? 'display' : /^vga_/.test(net) ? 'vga' : /^uart_/.test(net) ? 'rs232' : /^i2c_/.test(net) ? 'eeprom' : /^ps2_/.test(net) ? 'p3' : net === 'ir_rx' ? 'ir' : net === 'clk' ? 'oscillator' : net === 'beep' ? 'buzzer' : null);
      if (!id) return;
      selectPart(id);
      highlightUntil = performance.now() + 1800;
    },
    selectPart,
    centerSelected,
    get selectedPart() { return state.selected ? BOARD_PARTS[state.selected] : null; },
    setNavMode(mode) { state.navMode = mode === 'pan' ? 'pan' : 'orbit'; syncCameraButtons(); },
    get navMode() { return state.navMode; },
    setToolMode(mode) {
      state.toolMode = mode === 'select' ? 'select' : 'interact';
      if (state.toolMode !== 'select') {
        state.hovered = null;
        hoverHighlight.visible = false;
        selectPart(null);
      }
    },
    get toolMode() { return state.toolMode; },
    setHideOutline(value) {
      state.hideOutline = !!value;
      if (state.hideOutline) { highlight.visible = false; hoverHighlight.visible = false; }
    },
    get hideOutline() { return state.hideOutline; },
    setExplode(value) { state.explodeTarget = value; },
    setPersistence(value) { state.persistence = value; },
    setGlow(value) { state.glow = value; if (studio) { studio.gfx.ledGlow = Math.round(value * 100); studio.gfx.segGlow = Math.round(value * 100); } },
    setLabels(value) { labels.visible = value; },
    setGrid(value) { grid.visible = value; },
    setTraces(value) { netGuides.visible = value; },
    setAutoOrbit(value) { controls.autoRotate = value; controls.autoRotateSpeed = studio ? studio.gfx.orbitSpeed : .6; },
    setQuality, setCamera, setTheme,
    screenshot() { update(performance.now(), .05); if (studio) studio.renderFrame(performance.now()); else renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    resetView() { setCamera('hero'); },
    get fps() { return fps; },
    studio,
    getGfx() { return studio.gfx; },
    setGfx(patch) { return studio.applyGfx(patch); },
    resetGfx() { return studio.resetGfx(); },
    setStagePose(patch) { return studio.setStagePose(patch); },
    get stagePose() { return studio.stagePose; },
    setPhotoFocusMode(on) { state.photoFocusPick = !!on; },
    get photoFocusMode() { return !!state.photoFocusPick; },
    capturePhoto(options) { update(performance.now(), .05); return studio.capturePhoto(options); }
  };
}
