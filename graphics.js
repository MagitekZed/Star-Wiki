import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { getPageStar, fetchSummary, fetchWikidataFacts, summaryCache, starCache } from "./wikipedia.js";

// ====== Scene setup ======
const container = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080f);

const camera = new THREE.PerspectiveCamera(60, container.clientWidth/container.clientHeight, 0.1, 3000);
const DEFAULT_CAM_POS = new THREE.Vector3(0, 10, 28);
camera.position.copy(DEFAULT_CAM_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.autoRotate = false;
controls.autoRotateSpeed = 0.3; // very gentle idle drift

// Idle drift: after a few seconds of no interaction, slowly orbit. Honor reduced-motion.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IDLE_MS = 5000;
let lastInteraction = performance.now();
function markInteraction(){ lastInteraction = performance.now(); }
renderer.domElement.addEventListener('pointerdown', markInteraction);
renderer.domElement.addEventListener('wheel', markInteraction, { passive: true });
controls.addEventListener('start', markInteraction);

// Background starfield for depth
const bgStars = createBackgroundStars();
scene.add(bgStars);

// ====== Post-processing (bloom) ======
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 2));
// The renderer's own antialias only applies to the default framebuffer, not the
// composer's offscreen targets — so route rendering through multisampled targets,
// otherwise thin ray/trail lines shimmer and flicker through post-processing.
composer.renderTarget1.samples = 4;
composer.renderTarget2.samples = 4;
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(container.clientWidth, container.clientHeight),
  0.9,  // strength
  0.5,  // radius
  0.1   // threshold — only the bright additive stars/rays bloom
);
composer.addPass(bloomPass);
const vignettePass = new ShaderPass(VignetteShader);
vignettePass.uniforms.offset.value = 1.05;
vignettePass.uniforms.darkness.value = 1.25;
composer.addPass(vignettePass);
composer.addPass(new OutputPass());
// Reallocate the render targets at the correct size now that MSAA is enabled.
composer.setSize(container.clientWidth, container.clientHeight);

// Resize handling
window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  // Fat lines need their resolution kept in sync or their pixel width is wrong.
  scene.traverse(o => { if (o.material && o.material.isLineMaterial) o.material.resolution.set(w, h); });
  updateViewOffset();
});

// Tooltip
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
container.appendChild(tooltip);

const previewOverlay = document.getElementById('previewOverlay');
const previewModal = document.getElementById('previewModal');
const previewBody = document.getElementById('previewBody');
const previewTitle = document.getElementById('previewTitle');
const previewExtract = document.getElementById('previewExtract');
const previewThumb = document.getElementById('previewThumb');
const previewLink = document.getElementById('previewLink');

// ====== Star groups ======
let starGroup = new THREE.Group();
let edgeGroup = new THREE.Group();
scene.add(starGroup);
scene.add(edgeGroup);

const starTexture = createStarTexture();
const materialCenter = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffffff,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const materialNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x7aa2f7,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const materialNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xa9c6ff,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const materialBackNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffd36e,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const materialBackNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffe9b0,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const materialVisited = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x4b5570,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});
const RETURN_COLOR = 0xf7768e;
const materialRayHover = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, linewidth: 2, depthWrite: false });

// Shared materials that must never be disposed when tearing down a group
// (they are referenced by many meshes / lines simultaneously).
const SHARED_MATERIALS = new Set([
  materialCenter, materialNeighbor, materialNeighborHover,
  materialBackNeighbor, materialBackNeighborHover, materialVisited,
  materialRayHover
]);

// ====== Trail Mode state ======
const clusterGroups = new Map(); // title -> {star, edge}
const centerPositions = new Map(); // title -> THREE.Vector3
const ghostQueue = []; // order of ghost titles
const MAX_GHOSTS = 5;
const SEGMENT_DIST = 40; // fixed spacing between centers

const trailMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
const trailGeometry = new THREE.BufferGeometry();
const trailLine = new THREE.Line(trailGeometry, trailMaterial);
scene.add(trailLine);

// ====== Interaction ======
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.1;
raycaster.params.Line2 = { threshold: 6 }; // px tolerance for hovering fat lines
const mouse = new THREE.Vector2();
const mousePx = { x: 0, y: 0 }; // cursor position relative to the canvas, in px
let hovered = null;
let previewTarget = null;

container.addEventListener('mousemove', (e)=>{
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  mousePx.x = e.clientX - rect.left;
  mousePx.y = e.clientY - rect.top;
});

container.addEventListener('click', (e)=>{
  if (isAnimating) return; // ignore clicks during animation
  if (hovered && hovered.object && hovered.object.userData && hovered.object.userData.title && hovered.object.userData.kind !== 'center') {
    const toTitle = hovered.object.userData.title;
    const prev = getChainPrev();
    if (prev && toTitle === prev && hovered.object.userData.kind === 'ray') {
      goBackOne();
    } else {
      openPreview(toTitle, e.clientX, e.clientY);
    }
  } else if (previewTarget) {
    closePreview();
  }
});

// ====== Utility ======
function seededHash(str){
  let h = 2166136261 >>> 0;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function directionFromTitle(title){
  const h = seededHash(title);
  const theta = (h % 360) * Math.PI/180;
  const phi = ((h>>9)%360) * Math.PI/180;
  return [Math.cos(theta)*Math.sin(phi), Math.sin(theta)*Math.sin(phi), Math.cos(phi)];
}

function disposeObject(obj){
  // Dispose per-object GPU resources. Geometries are always created fresh, so
  // they are always safe to dispose. Materials are cloned per-mesh, but a few
  // are shared singletons (SHARED_MATERIALS) and must be left intact. Textures
  // are shared (e.g. starTexture) and are intentionally never disposed here.
  if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
  const mat = obj.material;
  if (mat && !SHARED_MATERIALS.has(mat) && typeof mat.dispose === 'function') mat.dispose();
}

function disposeGroup(g){
  g.traverse(disposeObject);
}

function clearGroup(g){
  while (g.children.length) {
    const child = g.children.pop();
    disposeObject(child);
    g.remove(child);
  }
}

function ghostify(title){
  const grp = clusterGroups.get(title);
  if (!grp) return;
  const fadeStar = 0.25;
  const fadeEdge = 0.15;
  grp.star.traverse(obj=>{
    if(obj.material && 'opacity' in obj.material){
      obj.material.opacity = fadeStar;
      obj.material.transparent = true;
    }
  });
  grp.edge.traverse(obj=>{
    // The flowing "comet" dots are only animated for the current cluster, so on
    // a ghost they freeze mid-ray and bloom into bright static blobs. Hide them;
    // the faded ray lines remain to show the trail.
    if (obj.userData && obj.userData.kind === 'rayDot') {
      obj.visible = false;
      return;
    }
    if(obj.material && 'opacity' in obj.material){
      obj.material.opacity = fadeEdge;
      obj.material.transparent = true;
    }
  });
}

function updateTrail(){
  const pts = history.map(t => centerPositions.get(t)).filter(Boolean);
  if (pts.length < 2) {
    trailGeometry.setFromPoints([]);
  } else {
    trailGeometry.setFromPoints(pts);
  }
}

// ====== Star building ======
let currentTitle = null;
let history = [];
let historyIndex = -1;
const visited = new Set();
let wordToMesh = new Map();
let showBacklinks = false;
let trailMode = true;

const R_MIN = 8;
const R_MAX = 40;

// ====== Pending actions / queue (single-slot) ======
let pendingNav = null;   // 'left' | 'right' | { type:'breadcrumb', index:number } | null
let pendingMode = null;  // true/false for backlinks checkbox toggle queued while animating

function queueNav(action) {
  pendingNav = action; // keep only the latest
}

function flushQueuedActions() {
  if (pendingMode !== null) {
    showBacklinks = !!pendingMode;
    pendingMode = null;
    refreshCurrentNeighbors();
  }
  if (pendingNav) {
    const act = pendingNav; pendingNav = null;
    if (act === 'left') goBackOne();
    else if (act === 'right') goForwardOne();
    else if (act && act.type === 'breadcrumb') jumpToBreadcrumb(act.index);
  }
}

function getChainPrev(){
  return historyIndex > 0 ? history[historyIndex - 1] : null;
}

function goBackOne(){
  const prev = getChainPrev();
  if (prev && historyIndex > 0 && !isAnimating) {
    historyIndex--;
    travelToNeighbor(prev, false);
    return true;
  }
  return false;
}

function goForwardOne(){
  if (historyIndex < history.length - 1 && !isAnimating) {
    const next = history[historyIndex + 1];
    historyIndex++;
    travelToNeighbor(next, false);
    return true;
  }
  return false;
}

function positionForNeighbor(title, index, total){
  const dir = directionFromTitle(title);
  const r = R_MIN + (total <= 1 ? 0 : index/(total-1)) * (R_MAX - R_MIN);
  return [dir[0]*r, dir[1]*r, dir[2]*r];
}

function opacityFromRank(rank, total){
  const t = total <= 1 ? 0 : rank/(total-1);
  return 0.25 + (1 - t) * 0.75;
}

// ---- Bloom tween store for cluster expansion
const _blooms = []; // { mesh, start, delayMs, target }

function placeNeighbor(title, posArray, group = starGroup, map = wordToMesh){
  const baseMat = visited.has(title)
    ? materialVisited
    : (showBacklinks ? materialBackNeighbor : materialNeighbor);
  const mesh = new THREE.Sprite(baseMat.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  const th = seededHash(title);
  mesh.userData = {
    title, kind: 'neighbor', baseScale: 1.2,
    // Per-star twinkle so the cluster breathes organically instead of in lockstep.
    twFreq: 1.0 + (th % 100) / 100 * 1.8,   // 1.0 .. 2.8 Hz-ish
    twPhase: ((th >> 7) % 628) / 100,        // 0 .. ~2π
    twAmp: 0.07 + (th % 60) / 600            // 0.07 .. 0.17
  };
  // start tiny; animate to base scale
  mesh.scale.set(0.001, 0.001, 1);
  _blooms.push({
    mesh,
    start: performance.now(),
    delayMs: 60 + (seededHash(title) % 180),
    target: 1.2
  });
  group.add(mesh);
  map.set(title, mesh);
  return mesh;
}

function drawRay(centerTitle, targetTitle, startVec3, endVec3, rank, total, group = edgeGroup, colorOverride=null){
  const lineOpacity = colorOverride ? 1 : opacityFromRank(rank, total);
  const baseColor = colorOverride || (showBacklinks ? 0xffd36e : 0x7aa2f7);
  // Fat, screen-space-width line with a bright-at-hub -> dim-at-neighbor gradient.
  const geo = new LineGeometry();
  geo.setPositions([startVec3.x, startVec3.y, startVec3.z, endVec3.x, endVec3.y, endVec3.z]);
  const cStart = new THREE.Color(baseColor);
  const cEnd = new THREE.Color(baseColor).multiplyScalar(0.3);
  geo.setColors([cStart.r, cStart.g, cStart.b, cEnd.r, cEnd.g, cEnd.b]);
  const baseLinewidth = colorOverride ? 2.6 : 1.8;
  const baseLineOpacity = Math.min(1, lineOpacity + 0.15);
  const mat = new LineMaterial({
    linewidth: baseLinewidth,
    vertexColors: true,
    transparent: true,
    opacity: baseLineOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  mat.resolution.set(container.clientWidth, container.clientHeight);
  const line = new Line2(geo, mat);
  const mid = startVec3.clone().add(endVec3).multiplyScalar(0.5);
  line.userData = { center: centerTitle, title: targetTitle, kind: 'ray', normalMat: mat, mid, baseLinewidth, baseLineOpacity, baseColorHex: baseColor };
  group.add(line);

  // Flow "comet" dot along the ray (skipped entirely under reduced-motion).
  if (REDUCED) return;
  const dotMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: baseColor,
    transparent: true,
    blending: THREE.AdditiveBlending,
    opacity: 0.95,
    depthWrite: false
  });
  const dot = new THREE.Sprite(dotMat);
  dot.scale.set(0.7, 0.7, 1);
  dot.userData = {
    kind: 'rayDot',
    start: startVec3.clone(),
    end: endVec3.clone(),
    speed: 0.22 + (seededHash(centerTitle + '→' + targetTitle) % 120) / 500,
    phase: (seededHash(targetTitle) % 1000) / 1000
  };
  group.add(dot);
}

function buildStarInto(centerTitle, data, gStar, gEdge, map, prevTitle=null, prevVec=null){
  const centerMesh = new THREE.Sprite(materialCenter.clone());
  centerMesh.position.set(0,0,0);
  centerMesh.scale.setScalar(2);
  centerMesh.userData = { title: centerTitle, kind: 'center', baseScale: 2 };
  gStar.add(centerMesh);
  map.set(centerTitle, centerMesh);

  // Hero treatment: a soft warm halo + a slowly rotating corona behind the core,
  // so the page you're on reads as a sun among its satellites. Decorative only —
  // unpickable (raycast no-op) and untitled so hover/click ignore them.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: starTexture, color: 0xffeccf, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.22
  }));
  halo.scale.setScalar(7);
  halo.userData = { kind: 'centerHalo', baseScale: 7 };
  halo.raycast = () => {};
  gStar.add(halo);

  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: starTexture, color: 0xcfe0ff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.45
  }));
  corona.scale.setScalar(3.6);
  corona.userData = { kind: 'centerCorona', baseScale: 3.6 };
  corona.raycast = () => {};
  gStar.add(corona);

  const neighbors = data.neighbors.slice(0,20);
  const filtered = prevTitle ? neighbors.filter(nb => nb !== prevTitle) : neighbors;

  filtered.forEach((nb, i) => {
    const pos = positionForNeighbor(nb, i, filtered.length);
    placeNeighbor(nb, pos, gStar, map);
    drawRay(centerTitle, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), i, filtered.length, gEdge);
  });

  if (prevTitle && prevVec) {
    drawRay(centerTitle, prevTitle, new THREE.Vector3(0,0,0), prevVec, 0, 1, gEdge, RETURN_COLOR);
  }

  updateSidebar(data.center, filtered, prevTitle, data.metaByTitle);
}

function rebuildStar(title, addToHistory=true){
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${title}…`;
  overlay.classList.remove('hidden');
  return getPageStar(title, showBacklinks).then(star => {
    overlay.classList.add('hidden');
    const canonical = star.center.title;
    if (addToHistory) {
      if (historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
      history.push(canonical);
      historyIndex = history.length - 1;
    } else {
      history[historyIndex] = canonical;
    }
    clusterGroups.forEach(g=>{
      if (g.star !== starGroup) disposeGroup(g.star);
      if (g.edge !== edgeGroup) disposeGroup(g.edge);
      scene.remove(g.star); scene.remove(g.edge);
    });
    clearGroup(starGroup); clearGroup(edgeGroup);
    // Ensure the reusable groups are attached to the scene again, and reset their
    // position — after travelling they were left at the last travel target, which
    // otherwise renders a freshly searched/random page far off-screen.
    scene.add(starGroup); scene.add(edgeGroup);
    starGroup.position.set(0, 0, 0);
    edgeGroup.position.set(0, 0, 0);
    starGroup.visible = true; edgeGroup.visible = true;
    wordToMesh.clear();
    clusterGroups.clear(); centerPositions.clear(); ghostQueue.length = 0;
    trailGeometry.setFromPoints([]);
    buildStarInto(canonical, star, starGroup, edgeGroup, wordToMesh);
    clusterGroups.set(canonical, { star: starGroup, edge: edgeGroup });
    centerPositions.set(canonical, new THREE.Vector3(0,0,0));
    currentTitle = canonical;
    controls.target.copy(new THREE.Vector3(0,0,0));
    fadeInGroups();
    visited.add(canonical);
    updateBreadcrumbs();
    updateTrail();
    isAnimating = false;
  }).catch(err => {
    console.error(err);
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    isAnimating = false;
  });
}

async function refreshCurrentNeighbors(){
  if (!currentTitle) return;
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${currentTitle}…`;
  overlay.classList.remove('hidden');
  let star;
  try {
    star = await getPageStar(currentTitle, showBacklinks);
  } catch (e) {
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    return;
  }
  overlay.classList.add('hidden');

  const prevTitle = getChainPrev();
  const pos = centerPositions.get(currentTitle) || new THREE.Vector3(0,0,0);
  const prevVec = prevTitle && centerPositions.has(prevTitle)
    ? centerPositions.get(prevTitle).clone().sub(pos)
    : null;

  disposeGroup(starGroup);
  disposeGroup(edgeGroup);
  scene.remove(starGroup);
  scene.remove(edgeGroup);
  clusterGroups.delete(currentTitle);

  const newStar = new THREE.Group();
  const newEdge = new THREE.Group();
  const newMap = new Map();
  buildStarInto(currentTitle, star, newStar, newEdge, newMap, prevTitle, prevVec);
  newStar.position.copy(pos);
  newEdge.position.copy(pos);
  scene.add(newStar);
  scene.add(newEdge);

  starGroup = newStar;
  edgeGroup = newEdge;
  wordToMesh = newMap;
  clusterGroups.set(currentTitle, { star: starGroup, edge: edgeGroup });
  hovered = null;
  tooltip.classList.remove('show');
  renderOnce();
}

// ====== Travel ======
let isAnimating = false;
async function travelToNeighbor(targetTitle, addToHistory=true){
  if (isAnimating || !currentTitle) return;

  // Resolve a provisional vector toward the target BEFORE fetch, if possible.
  const from = centerPositions.get(currentTitle) || new THREE.Vector3(0,0,0);
  const hasAbsoluteTarget = centerPositions.has(targetTitle);
  let provisionalDir = null;

  if (wordToMesh.has(targetTitle)) {
    provisionalDir = wordToMesh.get(targetTitle).position.clone().normalize();
  } else if (hasAbsoluteTarget) {
    provisionalDir = centerPositions.get(targetTitle).clone().sub(from).normalize();
  } else {
    const prev = getChainPrev();
    if (prev && targetTitle === prev && centerPositions.has(prev)) {
      provisionalDir = centerPositions.get(prev).clone().sub(from).normalize();
    }
  }
  if (!provisionalDir) {
    const dirArr = directionFromTitle(targetTitle);
    provisionalDir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]).normalize();
  }

  isAnimating = true;

  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${targetTitle}…`;
  overlay.classList.remove('hidden');
  let star;
  try {
    star = await getPageStar(targetTitle, showBacklinks);
  } catch (e) {
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    isAnimating = false;
    return;
  }
  overlay.classList.add('hidden');

  const canonical = star.center.title;
  const fromAbs = from.clone();
  let to;
  if (trailMode && centerPositions.has(canonical)) {
    // Rule 1: stable position for previously seen centers
    to = centerPositions.get(canonical).clone();
    const old = clusterGroups.get(canonical);
    if (old) { disposeGroup(old.star); disposeGroup(old.edge); scene.remove(old.star); scene.remove(old.edge); clusterGroups.delete(canonical); }
    const idx = ghostQueue.indexOf(canonical); if (idx !== -1) ghostQueue.splice(idx,1);
  } else {
    // Rule 2: new center placement along the incoming vector at fixed segment distance
    to = fromAbs.clone().add(provisionalDir.clone().multiplyScalar(SEGMENT_DIST));
  }

  if (addToHistory) {
    if (historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
    history.push(canonical);
    historyIndex = history.length - 1;
  } else {
    history[historyIndex] = canonical;
  }

  const newStar = new THREE.Group();
  const newEdge = new THREE.Group();
  const newMap = new Map();
  // prevVec = prev - current (center-to-center red edge)
  buildStarInto(canonical, star, newStar, newEdge, newMap, currentTitle, fromAbs.clone().sub(to));
  newStar.position.copy(to);
  newEdge.position.copy(to);
  scene.add(newStar);
  scene.add(newEdge);

  // Crossfade
  newStar.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; obj.material.opacity = 0; obj.material.transparent = true; }});
  newEdge.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; obj.material.opacity = 0; obj.material.transparent = true; }});
  starGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; }});
  edgeGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; }});

  const startCam = camera.position.clone();
  const startTarget = controls.target.clone();
  const startOffset = startCam.clone().sub(startTarget);
  const duration = REDUCED ? 350 : 1400;
  const fadeStart = 0.3;
  const t0 = performance.now();
  function tick(now){
    const t = Math.min(1, (now - t0) / duration);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;

    const curTarget = fromAbs.clone().lerp(to, ease);
    controls.target.copy(curTarget);

    // Flight dolly: pull back at mid-travel and settle back in on arrival (no
    // change at the endpoints, so there's no jump). Skipped under reduced-motion.
    const dolly = REDUCED ? 1 : (1 + 0.12 * Math.sin(ease * Math.PI));
    const curCam = curTarget.clone().add(startOffset.clone().multiplyScalar(dolly));
    camera.position.copy(curCam);

    const fadeOut = t < fadeStart ? 1 : 1 - (t - fadeStart)/(1 - fadeStart);
    const fadeIn = t < fadeStart ? 0 : (t - fadeStart)/(1 - fadeStart);

    starGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.material.opacity = obj.userData.baseOpacity * fadeOut; }});
    edgeGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.material.opacity = obj.userData.baseOpacity * fadeOut; }});
    newStar.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.material.opacity = obj.userData.baseOpacity * fadeIn; }});
    newEdge.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.material.opacity = obj.userData.baseOpacity * fadeIn; }});

    renderOnce();

    if (t < 1) requestAnimationFrame(tick);
    else {
      // Always retain a bounded trail of ghost clusters; trailMode only controls
      // whether they are visible, so toggling Trail off/on hides/shows the
      // existing trail instead of destroying and rebuilding it.
      ghostify(currentTitle);
      const prevGrp = clusterGroups.get(currentTitle);
      if (prevGrp) { prevGrp.star.visible = trailMode; prevGrp.edge.visible = trailMode; }
      ghostQueue.push(currentTitle);
      if (ghostQueue.length > MAX_GHOSTS) {
        const old = ghostQueue.shift();
        const grp = clusterGroups.get(old);
        if (grp) { disposeGroup(grp.star); disposeGroup(grp.edge); scene.remove(grp.star); scene.remove(grp.edge); clusterGroups.delete(old); centerPositions.delete(old); }
      }
      starGroup = newStar;
      edgeGroup = newEdge;
      wordToMesh = newMap;
      currentTitle = star.center.title;
      clusterGroups.set(currentTitle, { star: starGroup, edge: edgeGroup });
      centerPositions.set(currentTitle, to.clone());
      updateTrail();
      trailLine.visible = trailMode;
      visited.add(currentTitle);
      updateBreadcrumbs();
      hovered = null;
      tooltip.classList.remove('show');
      isAnimating = false;
      flushQueuedActions(); // apply any queued toggle or nav
    }
  }
  requestAnimationFrame(tick);
}

// ====== Sidebar ======
// ===== Neighbor list sort/filter state =====
let neighborSort = 'relevance';
let neighborFilter = '';
let currentNeighbors = [];
let currentChainPrev = null;
let currentMeta = {};
let sidebarToken = 0; // bumped each render so async facts can detect a stale sidebar

function updateSidebar(center, neighbors, chainPrev, metaByTitle = {}){
  const token = ++sidebarToken;
  const info = document.getElementById('info');
  if (info) info.classList.remove('empty'); // leave the first-run welcome state
  const heading = document.getElementById('currentWord');
  heading.textContent = center.title;

  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerHTML = '';
  if (center.thumbnailUrl) {
    const img = document.createElement('img');
    img.src = center.thumbnailUrl;
    img.alt = '';
    summaryDiv.appendChild(img);
  }
  if (center.summary) {
    const p = document.createElement('p');
    p.textContent = center.summary;
    summaryDiv.appendChild(p);
  }
  const link = document.createElement('a');
  link.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(center.title)}`;
  link.target = '_blank';
  link.textContent = 'View on Wikipedia';
  summaryDiv.appendChild(link);
  if (center.wikidataId) {
    const factsBox = document.createElement('div');
    factsBox.className = 'facts';
    summaryDiv.appendChild(factsBox);
    renderFacts(center.wikidataId, factsBox, token);
  }
  if (Array.isArray(center.categories) && center.categories.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    center.categories.slice(0, 8).forEach(cat => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = cat;
      chip.title = cat;
      chips.appendChild(chip);
    });
    summaryDiv.appendChild(chips);
  }
  summaryCache.set(center.title, { title: center.title, extract: center.summary || '', thumbnail: center.thumbnailUrl || null });

  currentNeighbors = neighbors.slice();
  currentChainPrev = chainPrev || null;
  currentMeta = metaByTitle || {};
  neighborFilter = '';

  const controls = document.getElementById('neighborControls');
  if (controls) {
    controls.innerHTML = '';
    if (currentNeighbors.length) {
      const filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.className = 'nb-filter';
      filterInput.placeholder = 'Filter links…';
      filterInput.value = neighborFilter;
      filterInput.setAttribute('aria-label', 'Filter links');
      filterInput.addEventListener('input', ()=>{ neighborFilter = filterInput.value; renderNeighborList(); });

      const sortSel = document.createElement('select');
      sortSel.className = 'nb-sort';
      sortSel.setAttribute('aria-label', 'Sort links');
      [['relevance','Relevance'], ['alpha','A–Z'], ['length','Longest']].forEach(([v, label])=>{
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (v === neighborSort) o.selected = true;
        sortSel.appendChild(o);
      });
      sortSel.addEventListener('change', ()=>{ neighborSort = sortSel.value; renderNeighborList(); });

      controls.appendChild(filterInput);
      controls.appendChild(sortSel);
    }
  }

  renderNeighborList();
}

async function renderFacts(wikidataId, box, token){
  let facts = [];
  try {
    facts = await fetchWikidataFacts(wikidataId);
  } catch {}
  if (token !== sidebarToken) return;       // navigated away while fetching
  if (!box.isConnected || !facts.length) { box.remove(); return; }
  const dl = document.createElement('dl');
  dl.className = 'facts-dl';
  facts.forEach(f => {
    const dt = document.createElement('dt');
    dt.textContent = f.label;
    const dd = document.createElement('dd');
    dd.textContent = f.value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
  box.appendChild(dl);
}

function renderNeighborList(){
  const container = document.getElementById('neighbors');
  if (!container) return;
  container.innerHTML = '';

  if (currentChainPrev) {
    const backRow = document.createElement('div');
    backRow.className = 'neighbor return';
    backRow.tabIndex = 0;
    backRow.textContent = `Back to ${currentChainPrev}`;
    backRow.addEventListener('click', ()=> goBackOne());
    backRow.addEventListener('keydown', e=>{ if(e.key==='Enter') goBackOne(); });
    container.appendChild(backRow);
  }

  let list = currentNeighbors.slice();
  const f = neighborFilter.trim().toLowerCase();
  if (f) list = list.filter(t => t.toLowerCase().includes(f));
  if (neighborSort === 'alpha') {
    list.sort((a, b) => a.localeCompare(b));
  } else if (neighborSort === 'length') {
    list.sort((a, b) => ((currentMeta[b] && currentMeta[b].length) || 0) - ((currentMeta[a] && currentMeta[a].length) || 0));
  }

  list.forEach(nb => {
    const row = document.createElement('div');
    row.className = 'neighbor';
    row.tabIndex = 0;
    if (visited.has(nb)) row.classList.add('visited');
    row.addEventListener('click', e=> openPreview(nb, e.clientX, e.clientY));
    row.addEventListener('keydown', e=>{ if(e.key==='Enter') openPreview(nb); });

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    row.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'title';
    titleDiv.textContent = nb;
    titleDiv.title = nb;
    meta.appendChild(titleDiv);
    const extractDiv = document.createElement('div');
    extractDiv.className = 'extract';
    meta.appendChild(extractDiv);
    row.appendChild(meta);

    const ext = document.createElement('a');
    ext.className = 'ext';
    ext.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(nb)}`;
    ext.target = '_blank';
    ext.innerHTML = '<svg class="icon"><use href="#ic-external"/></svg>';
    ext.setAttribute('aria-label', 'Open on Wikipedia');
    ext.addEventListener('click', e=> e.stopPropagation());
    ext.addEventListener('keydown', e=> e.stopPropagation());
    row.appendChild(ext);

    container.appendChild(row);
    fetchNeighborInfo(nb, row);
  });

  if (currentNeighbors.length === 0) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = 'No links found';
    container.appendChild(row);
  } else if (list.length === 0) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = 'No links match your filter';
    container.appendChild(row);
  }
}

async function fetchNeighborInfo(title, row){
  const data = await fetchSummary(title);
  const img = row.querySelector('img.thumb');
  if (data.thumbnail) img.src = data.thumbnail;
  const ex = row.querySelector('.extract');
  if (data.extract) {
    const first = data.extract.split('. ')[0];
    ex.textContent = first.endsWith('.') ? first : first + '.';
  }
}

// ====== Preview modal ======
function positionPreview(x, y){
  previewModal.style.transform = '';
  if (x == null || y == null || window.innerWidth < 600) {
    previewModal.style.left = '50%';
    previewModal.style.top = '50%';
    previewModal.style.transform = 'translate(-50%, -50%)';
  } else {
    const rect = previewModal.getBoundingClientRect();
    let left = x + 12;
    let top = y + 12;
    if (left + rect.width > window.innerWidth) left = x - rect.width - 12;
    if (top + rect.height > window.innerHeight) top = y - rect.height - 12;
    previewModal.style.left = left + 'px';
    previewModal.style.top = top + 'px';
  }
}

async function openPreview(title, x, y){
  if (isAnimating) return; // don’t open while animating
  previewTarget = title;
  previewTitle.textContent = title;
  previewExtract.textContent = 'Loading…';
  previewThumb.src = '';
  previewLink.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  previewOverlay.classList.remove('hidden');
  positionPreview(x, y);
  previewBody.focus();
  document.addEventListener('keydown', previewKeyHandler);
  const data = await fetchSummary(title);
  if (previewTarget !== title) return;
  previewTitle.textContent = data.title || title;
  if (data.thumbnail) previewThumb.src = data.thumbnail; else previewThumb.removeAttribute('src');
  if (data.extract) {
    const first = data.extract.split('. ').slice(0,2).join('. ');
    previewExtract.textContent = first;
  } else {
    previewExtract.textContent = '';
  }
  positionPreview(x, y);
}

function closePreview(){
  previewOverlay.classList.add('hidden');
  previewTarget = null;
  document.removeEventListener('keydown', previewKeyHandler);
}

function confirmPreview(){
  if (!previewTarget) return;
  const target = previewTarget;
  const chainPrev = getChainPrev();
  closePreview();
  if (chainPrev && target === chainPrev) {
    if (historyIndex > 0) {
      historyIndex--;
      travelToNeighbor(target, false);
    }
  } else {
    travelToNeighbor(target);
  }
}

function previewKeyHandler(e){
  if (e.key === 'Escape') {
    e.preventDefault();
    closePreview();
  } else if (e.key === 'Enter') {
    if (document.activeElement !== previewLink) {
      e.preventDefault();
      confirmPreview();
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const focusables = [previewBody, previewLink];
    let idx = focusables.indexOf(document.activeElement);
    idx = (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[idx].focus();
  }
}

previewOverlay.addEventListener('click', e=>{ if (e.target === previewOverlay) closePreview(); });
previewBody.addEventListener('click', confirmPreview);
previewLink.addEventListener('click', e=> e.stopPropagation());

function updateBreadcrumbs(){
  const nav = document.getElementById('breadcrumbs');
  if (!nav) return;
  nav.innerHTML = '';
  history.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.textContent = t;
    btn.title = t;
    if (i === historyIndex) btn.classList.add('active');
    btn.addEventListener('click', ()=> jumpToBreadcrumb(i));
    btn.addEventListener('keydown', e=>{ if(e.key==='Enter') jumpToBreadcrumb(i); });
    nav.appendChild(btn);
    if (i < history.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      nav.appendChild(sep);
    }
  });
  syncHash();
}

// ====== Shareable URL (hash routing) ======
function syncHash(){
  if (!history.length) return;
  const target = '#/' + history.map(encodeURIComponent).join('/');
  if (location.hash !== target) {
    // replaceState avoids stacking a new browser-history entry per hop.
    history.length && window.history.replaceState(null, '', target);
  }
}

function parsePathFromHash(){
  const h = location.hash;
  if (!h || !h.startsWith('#/')) return null;
  const path = h.slice(2).split('/')
    .map(s => { try { return decodeURIComponent(s); } catch { return s; } })
    .filter(Boolean);
  return path.length ? path : null;
}

async function copyShareLink(){
  const url = location.href;
  // Preferred path: async Clipboard API (needs a secure context + user gesture).
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to clipboard');
      return;
    }
  } catch {}
  // Fallback: legacy execCommand via a temporary textarea.
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(ok ? 'Link copied to clipboard' : 'Copy blocked — link is in the address bar');
    return;
  } catch {}
  showToast('Copy blocked — link is in the address bar');
}

function saveSnapshot(){
  // Render synchronously, then capture the WebGL buffer in the same task (so we
  // don't need preserveDrawingBuffer, which would cost performance every frame).
  renderOnce();
  renderer.domElement.toBlob((blob)=>{
    if (!blob) { showToast('Snapshot failed'); return; }
    const name = (currentTitle || 'starwiki').replace(/[^\w.-]+/g, '_');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starwiki-${name}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Snapshot saved');
  }, 'image/png');
}

function jumpToBreadcrumb(index){
  if (index === historyIndex) return;
  if (isAnimating) { queueNav({ type:'breadcrumb', index }); return; }
  historyIndex = index;
  const title = history[index];
  travelToNeighbor(title, false); // straight segment between existing centers
}

// ====== Hover ======
function resetHovered(){
  if (!hovered) return;
  const obj = hovered.object;
  if (obj.userData.kind === 'neighbor') {
    // The current material is the per-hover clone we created; dispose it so it
    // doesn't accumulate on the GPU across many hover in/out cycles.
    const prevMat = obj.material;
    const baseMat = visited.has(obj.userData.title)
      ? materialVisited
      : (showBacklinks ? materialBackNeighbor : materialNeighbor);
    obj.material = baseMat.clone();
    if (prevMat && !SHARED_MATERIALS.has(prevMat) && typeof prevMat.dispose === 'function') prevMat.dispose();
    if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale, obj.userData.baseScale, 1);
  } else if (obj.userData.normalMat) {
    // Restore the fat line's base width/opacity after hover.
    const m = obj.userData.normalMat;
    if (obj.userData.baseLinewidth != null) m.linewidth = obj.userData.baseLinewidth;
    if (obj.userData.baseLineOpacity != null) m.opacity = obj.userData.baseLineOpacity;
  }
}

// Warm a hovered page's data after a short dwell so travelling there feels
// instant. Deduped per title+mode; getPageStar is cached so repeats are free.
const _prefetched = new Set();
let _prefetchTimer = null;
function schedulePrefetch(title){
  if (!title) return;
  const key = (showBacklinks ? 'b:' : 'o:') + title;
  if (_prefetched.has(key)) return;
  clearTimeout(_prefetchTimer);
  _prefetchTimer = setTimeout(()=>{
    _prefetched.add(key);
    getPageStar(title, showBacklinks).catch(()=>{});
  }, 180);
}

function updateHover(){
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects([...edgeGroup.children, ...starGroup.children], false);
  if (intersects.length > 0) {
    const first = intersects[0];
    // Only mutate materials/scale when the hovered object actually changes;
    // updateHover runs every frame, so swapping the material unconditionally
    // would allocate a new material per frame and leak GPU memory.
    const isNewHover = !hovered || hovered.object !== first.object;
    if (hovered && hovered.object !== first.object) {
      resetHovered();
    }
    hovered = first;
    const obj = first.object;
    tooltip.classList.add('show');
    if (isNewHover && obj.userData.title && obj.userData.kind !== 'center') {
      schedulePrefetch(obj.userData.title);
    }
    if (obj.userData.kind === 'neighbor') {
      if (isNewHover) {
        obj.material = (showBacklinks ? materialBackNeighborHover : materialNeighborHover).clone();
        if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale * 1.25, obj.userData.baseScale * 1.25, 1);
      }
      const worldPos = obj.getWorldPosition(new THREE.Vector3());
      const rect = renderer.domElement.getBoundingClientRect();
      const v = worldPos.project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width;
      const y = (-v.y * 0.5 + 0.5) * rect.height;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.title;
    } else if (obj.userData.title && obj.userData.kind !== 'center') {
      if (isNewHover && obj.userData.normalMat) {
        // Thicken + brighten the fat line on hover (mutate, don't swap material).
        obj.userData.normalMat.linewidth = (obj.userData.baseLinewidth || 2) * 2.4;
        obj.userData.normalMat.opacity = 1;
      }
      // Position the ray's tooltip at the cursor (it follows the mouse along the
      // spoke) rather than pinning it to the ray's midpoint.
      tooltip.style.left = mousePx.x + 'px';
      tooltip.style.top = mousePx.y + 'px';
      tooltip.textContent = obj.userData.title;
    }
  } else {
    if (hovered) resetHovered();
    hovered = null;
    tooltip.classList.remove('show');
    clearTimeout(_prefetchTimer);
  }
}


// Center the look-at point (the center star) in the canvas area that's actually
// visible — beside the sidebar on desktop, or in the band between the header and
// the bottom sheet on mobile. Computes a TARGET; applyViewOffset eases to it.
const _viewOffset = { x: 0, y: 0 };                 // currently applied (eased)
const _viewOffsetTarget = { x: 0, y: 0, on: false };// desired

function updateViewOffset(){
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  const info = document.getElementById('info');
  const r = info ? info.getBoundingClientRect() : null;
  const mobile = window.innerWidth <= 720;
  if (mobile && r && r.height > 0) {
    // Bottom sheet: center vertically in the visible band (below the header/
    // breadcrumbs, above the sheet) so the star isn't hidden behind either.
    const bc = document.getElementById('breadcrumbs');
    const topInset = bc ? bc.getBoundingClientRect().bottom : 0;
    const centerY = (topInset + r.top) / 2;
    _viewOffsetTarget.x = 0;
    _viewOffsetTarget.y = h / 2 - centerY;          // +up / -down
    _viewOffsetTarget.on = true;
  } else if (!mobile && r && r.width > 0 && (w - r.left) > 1) {
    // Side panel: center horizontally in the area left of the sidebar.
    _viewOffsetTarget.x = (w - r.left) / 2;
    _viewOffsetTarget.y = 0;
    _viewOffsetTarget.on = true;
  } else {
    _viewOffsetTarget.x = 0; _viewOffsetTarget.y = 0; _viewOffsetTarget.on = false;
  }
}

function viewOffsetSettling(){
  return Math.abs(_viewOffset.x - (_viewOffsetTarget.on ? _viewOffsetTarget.x : 0)) > 0.5
      || Math.abs(_viewOffset.y - (_viewOffsetTarget.on ? _viewOffsetTarget.y : 0)) > 0.5;
}

function applyViewOffset(){
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  const tx = _viewOffsetTarget.on ? _viewOffsetTarget.x : 0;
  const ty = _viewOffsetTarget.on ? _viewOffsetTarget.y : 0;
  const k = REDUCED ? 1 : 0.18;                      // ease (instant under reduced-motion)
  _viewOffset.x += (tx - _viewOffset.x) * k;
  _viewOffset.y += (ty - _viewOffset.y) * k;
  if (Math.abs(_viewOffset.x) > 0.5 || Math.abs(_viewOffset.y) > 0.5) {
    camera.setViewOffset(w, h, _viewOffset.x, _viewOffset.y, w, h);
  } else if (camera.view && camera.view.enabled) {
    camera.clearViewOffset();
    _viewOffset.x = 0; _viewOffset.y = 0;
  }
}

function centerCameraOnCurrent(){
  const pos = (centerPositions.get(currentTitle) || starGroup.position || new THREE.Vector3()).clone();
  controls.target.copy(pos);
  camera.position.copy(pos.clone().add(DEFAULT_CAM_POS.clone()));
  controls.update();
  renderOnce();
}

function onGo(val){
  const value = val.trim();
  if (!value) return;
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  showBacklinks = false;
  const backToggle = document.getElementById('backToggle');
  if (backToggle) backToggle.checked = false;
  starCache.clear();
  summaryCache.clear();
  visited.clear();
  history = [];
  historyIndex = -1;
  updateBreadcrumbs();
  controls.target.set(0,0,0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  hovered = null;
  tooltip.classList.remove('show');
  clusterGroups.forEach(g=>{
    if (g.star !== starGroup) disposeGroup(g.star);
    if (g.edge !== edgeGroup) disposeGroup(g.edge);
    scene.remove(g.star); scene.remove(g.edge);
  });
  rebuildStar(value);
}

function setShowBacklinks(val){
  if (isAnimating) { pendingMode = val; return; }
  showBacklinks = val;
  if (currentTitle) refreshCurrentNeighbors();
}

function setTrailMode(val){
  trailMode = val;
  trailLine.visible = val;
  // Hide/show the existing ghost clusters rather than destroying them.
  clusterGroups.forEach((g, t)=>{
    if (t === currentTitle) return;
    g.star.visible = val;
    g.edge.visible = val;
  });
  if (val) updateTrail();
}

function getHistory(){ return history.slice(); }

// Restore a multi-step journey (from a shared hash URL or a saved bookmark).
// Lands on the last title with the full breadcrumb chain intact.
function loadPath(path){
  if (!Array.isArray(path) || !path.length) return;
  if (isAnimating) return;
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  showBacklinks = false;
  const backToggle = document.getElementById('backToggle');
  if (backToggle) backToggle.checked = false;
  visited.clear();
  hovered = null;
  tooltip.classList.remove('show');
  clusterGroups.forEach(g=>{
    if (g.star !== starGroup) disposeGroup(g.star);
    if (g.edge !== edgeGroup) disposeGroup(g.edge);
    scene.remove(g.star); scene.remove(g.edge);
  });
  history = path.slice();
  historyIndex = history.length - 1;
  controls.target.set(0,0,0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  rebuildStar(history[historyIndex], false);
}

// ====== Animation ======
function fadeInGroups(){
  starGroup.traverse(obj => {
    if(obj.material && 'opacity' in obj.material){
      obj.material.transparent = true;
      obj.userData.baseOpacity = obj.material.opacity;
      obj.material.opacity = 0;
    }
  });
  edgeGroup.traverse(obj => {
    if(obj.material && 'opacity' in obj.material){
      obj.material.transparent = true;
      obj.userData.baseOpacity = obj.material.opacity;
      obj.material.opacity = 0;
    }
  });
  const duration = 500;
  const start = performance.now();
  function tick(now){
    const t = Math.min(1, (now - start) / duration);
    starGroup.traverse(obj => {
      if(obj.material && 'opacity' in obj.material){
        const base = (obj.userData && obj.userData.baseOpacity != null) ? obj.userData.baseOpacity : 1;
        obj.material.opacity = base * t;
      }
    });
    edgeGroup.traverse(obj => {
      if(obj.material && 'opacity' in obj.material){
        const base = (obj.userData && obj.userData.baseOpacity != null) ? obj.userData.baseOpacity : 1;
        obj.material.opacity = base * t;
      }
    });
    renderOnce();
    if(t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function animate(){
  requestAnimationFrame(animate);
  // Drift the camera slowly when idle (not mid-travel, no preview open, motion allowed).
  controls.autoRotate = !REDUCED && !isAnimating && !previewTarget && (performance.now() - lastInteraction > IDLE_MS);
  controls.update();
  applyViewOffset();
  updateHover();

  // scale-in blooms
  for (let i = _blooms.length - 1; i >= 0; i--) {
    const b = _blooms[i];
    const dt = performance.now() - b.start;
    if (dt < b.delayMs) continue;
    const p = Math.min(1, (dt - b.delayMs) / 300);
    // simple ease-out
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const s = 0.001 + (b.target - 0.001) * eased;
    b.mesh.scale.set(s, s, 1);
    if (p >= 1) _blooms.splice(i, 1);
  }

  // Ambient motion (comet dots, twinkle, hero breathing, parallax drift) — all
  // skipped under reduced-motion for a calm, static scene.
  if (!REDUCED) {
    const now = performance.now() / 1000;
    edgeGroup.children.forEach(obj => {
      if (obj.userData && obj.userData.kind === 'rayDot') {
        const d = obj.userData;
        const total = d.end.clone().sub(d.start);
        const len = total.length();
        if (len < 0.0001) return;
        const dir = total.clone().normalize();
        const t = (d.phase + now * d.speed) % 1;
        const pos = d.start.clone().add(dir.multiplyScalar(len * t));
        obj.position.copy(pos);
        const s = 0.6 + 0.25 * Math.sin((now + d.phase) * 6.0);
        obj.scale.set(s, s, 1);
      } else if (obj.userData && obj.userData.kind === 'ray' && obj.userData.baseColorHex === RETURN_COLOR && obj.userData.normalMat) {
        obj.userData.normalMat.opacity = 0.65 + 0.35 * Math.sin(now * 2.5);
      }
    });

    starGroup.children.forEach((obj) => {
      const ud = obj.userData;
      if (!ud) return;
      if (ud.kind === 'neighbor' && (!hovered || hovered.object !== obj)) {
        const base = ud.baseScale || 1;
        const f = ud.twFreq || 2;
        const p = ud.twPhase || 0;
        const a = ud.twAmp || 0.12;
        const s = base * (1 + a * Math.sin(now * f + p));
        obj.scale.set(s, s, 1);
      } else if (ud.kind === 'center') {
        const s = (ud.baseScale || 2) * (1 + 0.06 * Math.sin(now * 1.3));
        obj.scale.set(s, s, 1);
      } else if (ud.kind === 'centerHalo') {
        const s = (ud.baseScale || 7) * (1 + 0.10 * Math.sin(now * 0.9));
        obj.scale.set(s, s, 1);
      } else if (ud.kind === 'centerCorona') {
        obj.material.rotation += 0.0025;
        const s = (ud.baseScale || 3.6) * (1 + 0.08 * Math.sin(now * 1.1 + 1));
        obj.scale.set(s, s, 1);
      }
    });
    // Parallax: rotate each background layer at its own rate for a sense of depth.
    bgStars.children.forEach(layer => {
      if (layer.userData && layer.userData.rotSpeed) layer.rotation.y += layer.userData.rotSpeed;
    });
  }

  // On-demand rendering: full rate while something meaningful is happening,
  // otherwise cap to ~30fps to save battery/GPU on an idle open tab. (Ambient
  // positions are still updated every frame above; only the GPU draw is gated.)
  const tMs = performance.now();
  // "Active" = travel/blooms/hover or just-interacted; idle drift is slow enough
  // to run at the throttled idle rate, so it's intentionally not counted here.
  const active = isAnimating || _blooms.length > 0 || hovered || viewOffsetSettling() || (tMs - lastInteraction < 1000);
  if (active || tMs - lastRenderTime >= IDLE_FRAME_MS) {
    composer.render();
    lastRenderTime = tMs;
  }
}
let lastRenderTime = 0;
const IDLE_FRAME_MS = 1000 / 30;
function renderOnce(){ composer.render(); lastRenderTime = performance.now(); }

function showToast(msg){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2500);
}

function init(){
  document.getElementById('loading').classList.add('hidden');
  updateViewOffset();
  updateBreadcrumbs();
  animate();
  const path = parsePathFromHash();
  if (path) loadPath(path);
}

init();

// ====== Helpers ======
function createNebulaTexture(){
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#06070d';
  ctx.fillRect(0, 0, w, h);
  // Soft additive gas clouds keyed to the app's accent palette.
  const palette = [
    'rgba(80,100,220,0.20)',  // indigo
    'rgba(40,165,195,0.20)',  // teal
    'rgba(165,65,185,0.17)',  // magenta
    'rgba(95,115,240,0.15)',  // periwinkle
    'rgba(35,135,175,0.14)'   // cyan
  ];
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 18; i++) {
    const color = palette[i % palette.length];
    const x = Math.random() * w, y = Math.random() * h;
    const r = 90 + Math.random() * 260;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createStarLayer(count, rMin, rMax, size, opacity, rotSpeed){
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const r = rMin + Math.random() * (rMax - rMin);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i*3+2] = r * Math.cos(phi);
    const roll = Math.random();
    if (roll < 0.10) c.setHSL(0.08, 0.55, 0.80);      // warm amber
    else if (roll < 0.32) c.setHSL(0.60, 0.55, 0.85); // blue
    else c.setHSL(0.60, 0.10, 0.96);                  // near-white
    colors[i*3] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ size, sizeAttenuation: true, transparent: true, opacity, depthWrite: false, vertexColors: true });
  const pts = new THREE.Points(geo, mat);
  pts.userData.rotSpeed = rotSpeed;
  return pts;
}

function createBackgroundStars(){
  const group = new THREE.Group();
  // Nebula skybox: a soft colored backdrop so the void has depth and color.
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(1600, 48, 32),
    new THREE.MeshBasicMaterial({ map: createNebulaTexture(), side: THREE.BackSide, depthWrite: false, depthTest: false })
  );
  nebula.renderOrder = -1;
  nebula.userData.rotSpeed = 0.00004;
  group.add(nebula);
  // Parallax star layers (far/dim/small -> near/bright/large), each drifting slower than the next.
  group.add(createStarLayer(700, 1100, 1500, 1.0, 0.45, 0.00008));
  group.add(createStarLayer(500, 750, 1050, 1.7, 0.70, 0.00018));
  group.add(createStarLayer(300, 480, 740, 2.5, 0.95, 0.00032));
  return group;
}

function createStarTexture(){
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  // Hot tight core fading into a long, soft halo. Kept grayscale so the
  // per-material SpriteMaterial.color tint stays accurate across star types.
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0.00, 'rgba(255,255,255,1)');
  glow.addColorStop(0.07, 'rgba(255,255,255,0.92)');
  glow.addColorStop(0.22, 'rgba(255,255,255,0.42)');
  glow.addColorStop(0.50, 'rgba(255,255,255,0.12)');
  glow.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  // Faint additive diffraction spikes through the core for a "star" read.
  ctx.globalCompositeOperation = 'lighter';
  const spikeH = ctx.createLinearGradient(0, c, size, c);
  spikeH.addColorStop(0.0, 'rgba(255,255,255,0)');
  spikeH.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  spikeH.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = spikeH;
  ctx.fillRect(0, c - 1, size, 2);
  const spikeV = ctx.createLinearGradient(c, 0, c, size);
  spikeV.addColorStop(0.0, 'rgba(255,255,255,0)');
  spikeV.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  spikeV.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = spikeV;
  ctx.fillRect(c - 1, 0, 2, size);
  return new THREE.CanvasTexture(canvas);
}
export {
  onGo,
  setShowBacklinks,
  setTrailMode,
  centerCameraOnCurrent,
  goBackOne,
  goForwardOne,
  jumpToBreadcrumb,
  openPreview,
  closePreview,
  confirmPreview,
  queueNav,
  copyShareLink,
  saveSnapshot,
  getHistory,
  loadPath,
  isAnimating
};
