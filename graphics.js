import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getPageStar, fetchSummary, summaryCache, starCache } from "./wikipedia.js";

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

// Background starfield for depth
const bgStars = createBackgroundStars();
scene.add(bgStars);

// ====== Post-processing (bloom) ======
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

// Resize handling
window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
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
  transparent: true
});
const materialNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x7aa2f7,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xa9c6ff,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialBackNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffd36e,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialBackNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffe9b0,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialVisited = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x4b5570,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const RETURN_COLOR = 0xf7768e;
const materialRayHover = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, linewidth: 2 });

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

const trailMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
const trailGeometry = new THREE.BufferGeometry();
const trailLine = new THREE.Line(trailGeometry, trailMaterial);
scene.add(trailLine);

// ====== Interaction ======
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.1;
const mouse = new THREE.Vector2();
let hovered = null;
let previewTarget = null;

container.addEventListener('mousemove', (e)=>{
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
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
  mesh.userData = { title, kind: 'neighbor', baseScale: 1.2 };
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
  const geo = new THREE.BufferGeometry().setFromPoints([startVec3, endVec3]);
  const lineOpacity = colorOverride ? 1 : opacityFromRank(rank, total);
  const baseColor = colorOverride || (showBacklinks ? 0xffd36e : 0x7aa2f7);
  const mat = new THREE.LineBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: Math.min(1, lineOpacity + 0.15),
    blending: THREE.AdditiveBlending
  });
  const line = new THREE.Line(geo, mat);
  const mid = startVec3.clone().add(endVec3).multiplyScalar(0.5);
  line.userData = { center: centerTitle, title: targetTitle, kind: 'ray', normalMat: mat, mid };
  group.add(line);

  // Flow "comet" dot along the ray
  const dotMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: baseColor,
    transparent: true,
    blending: THREE.AdditiveBlending,
    opacity: 0.95
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
    // Ensure the reusable groups are attached to the scene again
    scene.add(starGroup); scene.add(edgeGroup);
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
  const duration = 1400;
  const fadeStart = 0.3;
  const t0 = performance.now();
  function tick(now){
    const t = Math.min(1, (now - t0) / duration);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;

    const curTarget = fromAbs.clone().lerp(to, ease);
    controls.target.copy(curTarget);

    const curCam = curTarget.clone().add(startOffset);
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
      if (trailMode) {
        ghostify(currentTitle);
        ghostQueue.push(currentTitle);
        if (ghostQueue.length > MAX_GHOSTS) {
          const old = ghostQueue.shift();
          const grp = clusterGroups.get(old);
          if (grp) { disposeGroup(grp.star); disposeGroup(grp.edge); scene.remove(grp.star); scene.remove(grp.edge); clusterGroups.delete(old); centerPositions.delete(old); }
        }
      } else {
        const grp = clusterGroups.get(currentTitle);
        if (grp) { disposeGroup(grp.star); disposeGroup(grp.edge); scene.remove(grp.star); scene.remove(grp.edge); clusterGroups.delete(currentTitle); centerPositions.delete(currentTitle); }
      }
      starGroup = newStar;
      edgeGroup = newEdge;
      wordToMesh = newMap;
      currentTitle = star.center.title;
      clusterGroups.set(currentTitle, { star: starGroup, edge: edgeGroup });
      centerPositions.set(currentTitle, to.clone());
      if (trailMode) updateTrail(); else trailGeometry.setFromPoints([]);
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

function updateSidebar(center, neighbors, chainPrev, metaByTitle = {}){
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
    ext.textContent = '↗';
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
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Link copied to clipboard');
  } catch {
    showToast('Could not copy link');
  }
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
    obj.material = obj.userData.normalMat;
  }
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
      if (isNewHover) obj.material = materialRayHover;
      const worldMid = obj.parent.localToWorld(obj.userData.mid.clone());
      const rect = renderer.domElement.getBoundingClientRect();
      const v = worldMid.project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width;
      const y = (-v.y * 0.5 + 0.5) * rect.height;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.title;
    }
  } else {
    if (hovered) resetHovered();
    hovered = null;
    tooltip.classList.remove('show');
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
  if (!trailMode) {
    clusterGroups.forEach((g,t)=>{ if (t !== currentTitle) { disposeGroup(g.star); disposeGroup(g.edge); scene.remove(g.star); scene.remove(g.edge); clusterGroups.delete(t); centerPositions.delete(t); } });
    ghostQueue.length = 0;
    updateTrail();
  }
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
  controls.update();
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

  // move “comet” dots along rays, pulse return edges
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
    } else if (obj.isLine && obj.userData && obj.userData.normalMat) {
      if (obj.userData.normalMat.color?.getHex() === RETURN_COLOR) {
        obj.userData.normalMat.opacity = 0.65 + 0.35 * Math.sin(now * 2.5);
      }
    }
  });

  const t = performance.now() * 0.003;
  starGroup.children.forEach((obj, i) => {
    if (obj.userData && obj.userData.kind === 'neighbor' && (!hovered || hovered.object !== obj)) {
      const base = obj.userData.baseScale || 1;
      const s = base * (1 + 0.2 * Math.sin(t + i));
      obj.scale.set(s, s, 1);
    }
  });
  bgStars.rotation.y += 0.0003;
  composer.render();
}
function renderOnce(){ composer.render(); }

function showToast(msg){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2500);
}

function init(){
  document.getElementById('loading').classList.add('hidden');
  updateBreadcrumbs();
  animate();
  const path = parsePathFromHash();
  if (path) loadPath(path);
}

init();

// ====== Helpers ======
function createBackgroundStars(){
  const count = 1000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 600 + Math.random() * 400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i*3+2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false });
  return new THREE.Points(geo, mat);
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
  getHistory,
  loadPath,
  isAnimating
};
