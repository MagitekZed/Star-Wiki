import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';

// ====== Scene setup ======
const container = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0b10);

const camera = new THREE.PerspectiveCamera(60, container.clientWidth/container.clientHeight, 0.1, 3000);
camera.position.set(0, 10, 28);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(10, 30, 20);
scene.add(dir);

// Background starfield for depth
const bgStars = createBackgroundStars();
scene.add(bgStars);

// Resize handling
window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// Tooltip
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
container.appendChild(tooltip);

// ====== Data ======
const params = new URLSearchParams(location.search);
const DATA_BASE = params.get('data') || './data';

let words = [];
const coordsMap = new Map();
const nnMap = new Map();
const farMap = new Map();
const freqMap = new Map();
const wordSet = new Set();
const starCache = new Map();

// ====== Starfield groups (we only render the current star) ======
let starGroup = new THREE.Group();      // center + neighbor nodes
let edgeGroup = new THREE.Group();      // rays
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
  color: 0x96bdfc,
  blending: THREE.AdditiveBlending,
  transparent: true
});

const materialRayHover = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, linewidth: 2 });
const materialRayContrastHover = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 1, dashSize: 1, gapSize: 0.5 });

let showFar = true;
document.getElementById('showFar').addEventListener('change', (e)=>{
  showFar = e.target.checked;
  if (currentWord) rebuildStar(currentWord, lastPrevWord, true);
});

// ====== Interactions ======
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.1;
const mouse = new THREE.Vector2();
let hovered = null;

container.addEventListener('mousemove', (e)=>{
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});

container.addEventListener('click', ()=>{
  if (hovered && hovered.object && hovered.object.userData && hovered.object.userData.word && hovered.object.userData.kind !== 'center') {
    const toWord = hovered.object.userData.word;
    travelToNeighbor(toWord);
  }
});

// ====== Load data and init ======
async function init(){
  const overlay = document.getElementById('loading');
  try {
    const loaders = ['words.json','coords.json','nn.json','far.json','freq.json'].map(f=>
      fetch(`${DATA_BASE}/${f}`).then(r=>{ if(!r.ok) throw new Error(f); return r.json(); }).catch(()=>({__error:f}))
    );
    const metaPromise = fetch(`${DATA_BASE}/dataset_meta.json`).then(r=> r.ok ? r.json() : null).catch(()=>null);
    const [wRes,cRes,nRes,fRes,frqRes,meta] = await Promise.all([...loaders, metaPromise]);

    if (!wRes.__error) { words = wRes; words.forEach(w=>wordSet.add(w)); }
    else showToast(`Failed to load ${wRes.__error}`);
    if (!cRes.__error) { for(const [k,v] of Object.entries(cRes)) coordsMap.set(k,v); }
    else showToast(`Failed to load ${cRes.__error}`);
    if (!nRes.__error) { for(const [k,v] of Object.entries(nRes)) nnMap.set(k,v); }
    else showToast(`Failed to load ${nRes.__error}`);
    if (!fRes.__error) { for(const [k,v] of Object.entries(fRes)) farMap.set(k,v); }
    else showToast(`Failed to load ${fRes.__error}`);
    if (!frqRes.__error) { for(const [k,v] of Object.entries(frqRes)) freqMap.set(k, v); }
    else showToast(`Failed to load ${frqRes.__error}`);

    populateDatalist(words);
    if (meta) renderMeta(meta);
    document.getElementById('search').focus();
    animate();
  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Failed to load dataset.');
  } finally {
    overlay.classList.add('hidden');
  }
}

function renderMeta(meta){
  const footer = document.getElementById('datasetMeta');
  const parts = [];
  if (meta.model) parts.push(meta.model);
  if (meta.k) parts.push(`K=${meta.k}`);
  if (meta.c) parts.push(`C=${meta.c}`);
  if (meta.pca_seed) parts.push(`PCA seed=${meta.pca_seed}`);
  footer.textContent = parts.length ? `Dataset: ${parts.join(' • ')}` : '';
}

function populateDatalist(list) {
  const dl = document.getElementById('wordlist');
  dl.innerHTML = '';
  list.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w;
    dl.appendChild(opt);
  });
}

// ====== Star building ======

let currentWord = null;
let lastPrevWord = null; // for "return strand"
let wordToMesh = new Map(); // current star only

// Ray distance parameters
// Values tuned for a focused, readable star around the current word.
const R_MIN = 8;             // closest rays
const R_MAX = 40;            // farthest rays for similar
const R_CONTRAST_MIN = 45;   // base radius for contrast rays
const R_CONTRAST_MAX = 80;   // farthest contrast rays

function clearGroup(g) {
  while (g.children.length) g.remove(g.children.pop());
}

function cosineToRadius(cos) {
  const t = Math.max(-1, Math.min(1, cos));
  const u = (t + 1) / 2; // [-1,1] -> [0,1]
  return R_MIN + (1 - u) * (R_MAX - R_MIN);
}

function contrastCosToRadius(cos) {
  const t = Math.max(-1, Math.min(0, cos));
  const u = -t; // 0..1
  return R_CONTRAST_MIN + u * (R_CONTRAST_MAX - R_CONTRAST_MIN);
}

function seededHash(str){
  let h = 2166136261 >>> 0;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function directionBetween(ca, cb, aw, bw){
  if (cb) {
    const d = [cb[0]-ca[0], cb[1]-ca[1], cb[2]-ca[2]];
    const len = Math.hypot(d[0],d[1],d[2]) || 1;
    return [d[0]/len, d[1]/len, d[2]/len];
  }
  const h = seededHash(`${aw}:${bw}`);
  const theta = (h % 360) * Math.PI/180;
  const phi = ((h>>9)%360) * Math.PI/180;
  return [Math.cos(theta)*Math.sin(phi), Math.sin(theta)*Math.sin(phi), Math.cos(phi)];
}

function getStarData(word){
  if (starCache.has(word)) {
    const v = starCache.get(word);
    starCache.delete(word);
    starCache.set(word, v);
    return v;
  }
  const center = coordsMap.get(word) || [0,0,0];
  const simRaw = nnMap.get(word) || [];
  const simList = simRaw.map(([nb, cos]) => {
    const dir = directionBetween(center, coordsMap.get(nb), word, nb);
    const r = cosineToRadius(typeof cos === 'number' ? cos : 0.1);
    const pos = [dir[0]*r, dir[1]*r, dir[2]*r];
    return { word: nb, cos, pos };
  });
  const farRaw = farMap.get(word) || [];
  const farList = farRaw.map(([nb, cos]) => {
    const dir = directionBetween(center, coordsMap.get(nb), word, nb);
    const r = contrastCosToRadius(typeof cos === 'number' ? cos : -1);
    const pos = [dir[0]*r, dir[1]*r, dir[2]*r];
    return { word: nb, cos, pos };
  });
  const data = { simList, farList };
  starCache.set(word, data);
  if (starCache.size > 256) {
    const first = starCache.keys().next().value;
    starCache.delete(first);
  }
  return data;
}

function buildStarInto(centerWord, prevWord, gStar, gEdge, map){
  // Center node at origin
  const centerMesh = new THREE.Sprite(materialCenter.clone());
  centerMesh.position.set(0,0,0);
  centerMesh.scale.setScalar(2);
  centerMesh.userData = { word: centerWord, kind: 'center', baseScale: 2 };
  gStar.add(centerMesh);
  map.set(centerWord, centerMesh);

  const base = getStarData(centerWord);
  const simList = base.simList.map(s=>({ ...s }));
  if (prevWord && !simList.some(s => s.word === prevWord)) {
    const dir = directionBetween(coordsMap.get(centerWord) || [0,0,0], coordsMap.get(prevWord), centerWord, prevWord);
    const r = cosineToRadius(0.42);
    simList.unshift({ word: prevWord, cos: 0.42, pos: [dir[0]*r, dir[1]*r, dir[2]*r] });
  }

  simList.forEach(({word: nb, cos, pos}) => {
    placeNeighbor(nb, pos, cos, gStar, map);
    addPreviewStar(nb, pos, gStar);
    drawRay(centerWord, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), cos, 'similar', gEdge);
  });

  let farList = [];
  if (showFar) {
    farList = base.farList.slice(0,5);
    farList.forEach(({word: nb, cos, pos}) => {
      placeNeighbor(nb, pos, cos, gStar, map);
      addPreviewStar(nb, pos, gStar);
      drawRay(centerWord, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), cos, 'contrast', gEdge);
    });
  }

  return { simList, farList: base.farList };
}

function rebuildStar(centerWord, prevWord=null, redrawOnly=false){
  if (!redrawOnly) {
    starGroup.children.forEach(ch => ch.layers.enable(0));
    edgeGroup.children.forEach(ch => ch.layers.enable(0));
  }
  clearGroup(starGroup);
  clearGroup(edgeGroup);
  wordToMesh.clear();

  const {simList, farList} = buildStarInto(centerWord, prevWord, starGroup, edgeGroup, wordToMesh);

  updateSidebar(centerWord, simList.map(s=>[s.word,s.cos]), farList.map(s=>[s.word,s.cos]));

  currentWord = centerWord;
  lastPrevWord = prevWord || lastPrevWord || null;

  controls.target.set(0,0,0);
  fadeInGroups();

  simList.forEach(s => getStarData(s.word));
}

function placeNeighbor(word, posArray, cos, group = starGroup, map = wordToMesh){
  const mesh = new THREE.Sprite(materialNeighbor.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  const sz = sizeFromFreq(freqMap.get(word));
  mesh.userData = { word, cos, kind: 'neighbor', baseScale: sz };
  mesh.scale.set(sz, sz, 1);
  group.add(mesh);
  map.set(word, mesh);
  return mesh;
}

function addPreviewStar(word, posArray, targetGroup = starGroup){
  const data = getStarData(word);
  const preview = new THREE.Group();
  const scale = 0.25;
  data.simList.slice(0,3).forEach(({word: nb, pos}) => {
    const sp = new THREE.Sprite(materialNeighbor.clone());
    sp.position.set(pos[0]*scale, pos[1]*scale, pos[2]*scale);
    const sz = sizeFromFreq(freqMap.get(nb)) * 0.5;
    sp.scale.set(sz, sz, 1);
    if (sp.material && 'opacity' in sp.material) sp.material.opacity = 0.7;
    preview.add(sp);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0,0,0),
      new THREE.Vector3(pos[0]*scale, pos[1]*scale, pos[2]*scale)
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x7aa2f7, transparent: true, opacity: 0.2, linewidth: 1 });
    const line = new THREE.Line(lineGeo, lineMat);
    preview.add(line);
  });
  preview.position.set(posArray[0], posArray[1], posArray[2]);
  preview.userData = { kind: 'preview' };
  targetGroup.add(preview);
}

function drawRay(centerWord, targetWord, startVec3, endVec3, cos, type, group = edgeGroup){
  const geo = new THREE.BufferGeometry().setFromPoints([startVec3, endVec3]);
  const mat = (type === 'contrast')
    ? new THREE.LineDashedMaterial({ color: 0xf7768e, transparent: true, opacity: 0.95, dashSize: 1, gapSize: 0.5 })
    : new THREE.LineBasicMaterial({ color: 0x7aa2f7, transparent: true, opacity: opacityFromCosine(cos), linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  if (type === 'contrast') line.computeLineDistances();
  const mid = startVec3.clone().add(endVec3).multiplyScalar(0.5);
  line.userData = { center: centerWord, word: targetWord, type, cos, normalMat: mat, mid };
  group.add(line);
}

function sizeFromFreq(rank) {
  if (!rank) return 1.0;
  const t = Math.min(1, Math.max(0, (rank-1)/4999));
  return 1.35 - 0.75*t;
}

function opacityFromCosine(cos) {
  const t = Math.max(-1, Math.min(1, cos));
  const u = (t + 1) / 2;
  return 0.25 + 0.75 * u;
}

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

// Sidebar
function updateSidebar(center, simList, farList){
  const container = document.getElementById('neighbors');
  container.innerHTML = '';

  const simCard = document.createElement('div');
  simCard.className = 'card';
  simCard.innerHTML = '<h3>Similar</h3>';
  simList.forEach(([nb, cos]) => {
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('span'); left.textContent = nb;
    const right = document.createElement('span'); right.className = 'badge';
    right.textContent = (typeof cos === 'number' ? cos.toFixed(2) : '—');
    row.appendChild(left); row.appendChild(right);
    row.addEventListener('click', ()=> travelToNeighbor(nb));
    simCard.appendChild(row);
  });
  container.appendChild(simCard);

  if (showFar && farList.length) {
    const farCard = document.createElement('div');
    farCard.className = 'card';
    farCard.innerHTML = '<h3>Contrast</h3>';
    farList.forEach(([nb, cos]) => {
      const row = document.createElement('div');
      row.className = 'item';
      const left = document.createElement('span'); left.textContent = nb;
      const right = document.createElement('span'); right.className = 'badge';
      right.textContent = (typeof cos === 'number' ? cos.toFixed(2) : '—');
      row.appendChild(left); row.appendChild(right);
      row.addEventListener('click', ()=> travelToNeighbor(nb));
      farCard.appendChild(row);
    });
    container.appendChild(farCard);
  }

  document.getElementById('currentWord').textContent = center;
}

// Travel: animate along the chosen ray, then re-root
let isAnimating = false;
function travelToNeighbor(targetWord){
  if (isAnimating || !currentWord || !wordToMesh.has(targetWord)) return;
  isAnimating = true;

  const from = new THREE.Vector3(0,0,0);
  const to = wordToMesh.get(targetWord).position.clone();

  const newStar = new THREE.Group();
  const newEdge = new THREE.Group();
  const newMap = new Map();
  const {simList, farList} = buildStarInto(targetWord, currentWord, newStar, newEdge, newMap);
  newStar.position.copy(to);
  newEdge.position.copy(to);
  scene.add(newStar);
  scene.add(newEdge);

  newStar.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; obj.material.opacity = 0; obj.material.transparent = true; }});
  newEdge.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; obj.material.opacity = 0; obj.material.transparent = true; }});
  starGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; }});
  edgeGroup.traverse(obj => { if(obj.material && 'opacity' in obj.material){ obj.userData.baseOpacity = obj.material.opacity; }});

  const startCam = camera.position.clone();
  const startTarget = controls.target.clone();
  const startOffset = startCam.clone().sub(startTarget);
  const endOffset = startOffset.clone().setLength(12);

  const duration = 1400;
  const fadeStart = 0.3;

  const t0 = performance.now();
  function tick(now){
    const t = Math.min(1, (now - t0) / duration);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;

    const curTarget = from.clone().lerp(to, ease);
    controls.target.copy(curTarget);

    const curOffset = startOffset.clone().lerp(endOffset, ease);
    const curCam = curTarget.clone().add(curOffset);
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
      scene.remove(starGroup); scene.remove(edgeGroup);
      newStar.position.sub(to); newEdge.position.sub(to);
      starGroup = newStar;
      edgeGroup = newEdge;
      wordToMesh = newMap;
      updateSidebar(targetWord, simList.map(s=>[s.word,s.cos]), farList.map(s=>[s.word,s.cos]));
      lastPrevWord = currentWord;
      currentWord = targetWord;
      controls.target.set(0,0,0);
      camera.position.copy(endOffset);
      simList.forEach(s => getStarData(s.word));
      hovered = null;
      tooltip.classList.remove('show');
      isAnimating = false;
    }
  }
  requestAnimationFrame(tick);
}

// Hover + tooltip
function resetHovered(){
  if (!hovered || !hovered.object) return;
  const obj = hovered.object;
  if (obj.userData.kind === 'neighbor') {
    obj.material = materialNeighbor.clone();
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
    if (hovered && hovered.object !== first.object) {
      resetHovered();
    }
    hovered = first;
    const obj = first.object;
    tooltip.classList.add('show');
    if (obj.userData.kind === 'neighbor') {
      obj.material = materialNeighborHover.clone();
      if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale * 1.25, obj.userData.baseScale * 1.25, 1);
      const v = obj.position.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      const y = (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.word;
    } else if (obj.userData.word && obj.userData.kind !== 'center') {
      obj.material = obj.userData.type === 'contrast' ? materialRayContrastHover : materialRayHover;
      const v = obj.userData.mid.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      const y = (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.word;
    }
  } else {
    if (hovered) resetHovered();
    hovered = null;
    tooltip.classList.remove('show');
  }
}

// Search handlers
document.getElementById('goBtn').addEventListener('click', onGo);
document.getElementById('search').addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onGo(); });
function onGo(){
  const val = document.getElementById('search').value.trim().toLowerCase();
  if (!val) return;
  if (!wordSet.has(val)) {
    showToast('Word not in dataset.');
    return;
  }
  if (!currentWord) {
    rebuildStar(val);
  } else {
    if (wordToMesh.has(val)) travelToNeighbor(val);
    else rebuildStar(val, currentWord);
  }
}

// Render loop
function animate(){
  requestAnimationFrame(animate);
  controls.update();
  updateHover();
  const t = performance.now() * 0.003;
  starGroup.children.forEach((obj, i) => {
    if (obj.userData && obj.userData.kind === 'neighbor' && (!hovered || hovered.object !== obj)) {
      const base = obj.userData.baseScale || 1;
      const s = base * (1 + 0.2 * Math.sin(t + i));
      obj.scale.set(s, s, 1);
    }
  });
  bgStars.rotation.y += 0.0003;
  renderer.render(scene, camera);
}
function renderOnce(){ renderer.render(scene, camera); }

function showToast(msg){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2500);
}

init();

// helper to generate distant static stars
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
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0,0,size,size);
  return new THREE.CanvasTexture(canvas);
}
