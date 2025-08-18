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
const DEFAULT_CAM_POS = new THREE.Vector3(0, 10, 28);
camera.position.copy(DEFAULT_CAM_POS);

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
let ghostRoot = new THREE.Group();
scene.add(starGroup);
scene.add(edgeGroup);
scene.add(ghostRoot);

const ghosts = [];
const MAX_GHOSTS = 5;
let trailMode = true;
const trailMaterial = new THREE.LineBasicMaterial({color:0x888888, transparent:true, opacity:0.3});
const trailGeometry = new THREE.BufferGeometry();
let trailLine = new THREE.Line(trailGeometry, trailMaterial);
ghostRoot.add(trailLine);
const trailPositions = [new THREE.Vector3(0,0,0)];
function updateTrailGeometry(){ trailGeometry.setFromPoints(trailPositions); }
updateTrailGeometry();

let breadcrumbs = [];
let historyIndex = -1;

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
const materialBackNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffd700,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialBackNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffe580,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialVisited = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x4b5563,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const RETURN_COLOR = 0xf7768e;
const materialReturnNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: RETURN_COLOR,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialReturnNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffa0b3,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const materialRayHover = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, linewidth: 2 });

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
  if (hovered && hovered.object && hovered.object.userData && hovered.object.userData.title && hovered.object.userData.kind !== 'center') {
    const toTitle = hovered.object.userData.title;
    openPreview(toTitle, e.clientX, e.clientY);
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

function clearGroup(g){
  while (g.children.length) g.remove(g.children.pop());
}

// ====== Wikipedia adapter ======
const starCache = new Map();
const MAX_CACHE = 64;
let lastFetch = 0;
const FETCH_DELAY = 250;
const summaryCache = new Map();

async function wikiFetch(url){
  const now = Date.now();
  const wait = Math.max(0, lastFetch + FETCH_DELAY - now);
  if (wait) await new Promise(r=>setTimeout(r, wait));
  lastFetch = Date.now();
  return fetch(url, { headers: { 'Api-User-Agent': 'StarWiki/1.0 (https://example.com)' } });
}

async function fetchSummary(title){
  if (summaryCache.has(title)) return summaryCache.get(title);
  const info = { title, extract: '', thumbnail: null };
  summaryCache.set(title, info);
  try {
    const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) info.title = data.title;
      if (data.extract) info.extract = data.extract;
      if (data.thumbnail?.source) info.thumbnail = data.thumbnail.source;
    }
  } catch {}
  return info;
}

async function normalizeTitle(title){
  let canonical = title;
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
    if (page?.title) canonical = page.title;
  } catch {}
  return canonical;
}

async function fetchRelevance(title){
  const relevance = new Map();
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`morelike:${title}`)}&srlimit=500&srprop=score&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    if (data.query?.search) {
      data.query.search.forEach((it, idx) => {
        relevance.set(it.title, { rank: idx, score: it.score });
      });
    }
  } catch {}
  return relevance;
}

async function getPageStar(title, backlinks=false){
  title = title.trim();
  const preKey = `${backlinks ? 'back' : 'out'}|${title}`;
  if (starCache.has(preKey)) {
    const v = starCache.get(preKey);
    starCache.delete(preKey); starCache.set(preKey, v);
    return v;
  }

  const canonical = await normalizeTitle(title);
  const key = `${backlinks ? 'back' : 'out'}|${canonical}`;
  if (starCache.has(key)) {
    const v = starCache.get(key);
    starCache.delete(key); starCache.set(key, v);
    return v;
  }

  let summaryData = null;
  try {
    const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(canonical)}`);
    if (res.ok) summaryData = await res.json();
  } catch {}
  if (!summaryData) throw new Error('summary fetch failed');

  const candidates = [];
  const seen = new Set();
  try {
    if (backlinks) {
      let cont = null;
      do {
        let url = `https://en.wikipedia.org/w/api.php?action=query&list=backlinks&bltitle=${encodeURIComponent(canonical)}&blnamespace=0&bllimit=max&format=json&origin=*`;
        if (cont) url += `&blcontinue=${encodeURIComponent(cont)}`;
        const res = await wikiFetch(url);
        const data = await res.json();
        if (data.query?.backlinks) {
          for (const l of data.query.backlinks) {
            const t = l.title;
            if (t === canonical || seen.has(t)) continue;
            seen.add(t); candidates.push({ title: t, index: candidates.length });
          }
        }
        cont = data.continue?.blcontinue;
      } while (cont);
    } else {
      let cont = null;
      do {
        let url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(canonical)}&prop=links&plnamespace=0&pllimit=max&format=json&origin=*`;
        if (cont) url += `&plcontinue=${encodeURIComponent(cont)}`;
        const res = await wikiFetch(url);
        const data = await res.json();
        const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
        if (page?.links) {
          for (const l of page.links) {
            const t = l.title;
            if (t === canonical || seen.has(t)) continue;
            seen.add(t); candidates.push({ title: t, index: candidates.length });
          }
        }
        cont = data.continue?.plcontinue;
      } while (cont);
    }
  } catch {}

  const relevance = await fetchRelevance(canonical);
  const scored = candidates.map(c => {
    const r = relevance.get(c.title);
    return {
      title: c.title,
      index: c.index,
      rank: r ? r.rank : Infinity,
      score: r ? r.score : 0
    };
  });
  scored.sort((a,b)=> {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.score !== b.score) return b.score - a.score;
    if (a.index !== b.index) return a.index - b.index;
    return a.title.localeCompare(b.title);
  });
  const neighbors = scored.slice(0,20).map(s=>s.title);

  const star = {
    center: {
      title: canonical,
      summary: summaryData.extract,
      thumbnailUrl: summaryData.thumbnail?.source
    },
    neighbors,
    fetchedAt: Date.now()
  };
  starCache.set(key, star);
  if (starCache.size > MAX_CACHE) {
    const first = starCache.keys().next().value;
    starCache.delete(first);
  }
  return star;
}

// ====== Star building ======
let currentTitle = null;
const visited = new Set();
let wordToMesh = new Map();
let showBacklinks = false;
let previousTitle = null;

const R_MIN = 8;
const R_MAX = 40;

function positionForNeighbor(title, index, total){
  const dir = directionFromTitle(title);
  const r = R_MIN + (total <= 1 ? 0 : index/(total-1)) * (R_MAX - R_MIN);
  return [dir[0]*r, dir[1]*r, dir[2]*r];
}

function opacityFromRank(rank, total){
  const t = total <= 1 ? 0 : rank/(total-1);
  return 0.25 + (1 - t) * 0.75;
}

function placeNeighbor(title, posArray, group = starGroup, map = wordToMesh){
  const baseMat = visited.has(title)
    ? materialVisited
    : (showBacklinks ? materialBackNeighbor : materialNeighbor);
  const mesh = new THREE.Sprite(baseMat.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  mesh.userData = { title, kind: 'neighbor', baseScale: 1.2 };
  mesh.scale.set(1.2, 1.2, 1);
  group.add(mesh);
  map.set(title, mesh);
  return mesh;
}

function placeReturnNeighbor(title, posArray, group = starGroup, map = wordToMesh){
  const mesh = new THREE.Sprite(materialReturnNeighbor.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  mesh.userData = { title, kind: 'neighbor', baseScale: 1.2, isReturn: true };
  mesh.scale.set(1.2, 1.2, 1);
  group.add(mesh);
  map.set(title, mesh);
  return mesh;
}

function drawRay(centerTitle, targetTitle, startVec3, endVec3, rank, total, group = edgeGroup, colorOverride=null){
  const geo = new THREE.BufferGeometry().setFromPoints([startVec3, endVec3]);
  const lineOpacity = colorOverride ? 1 : opacityFromRank(rank, total);
  const mat = new THREE.LineBasicMaterial({
    color: colorOverride || (showBacklinks ? 0xffd700 : 0x7aa2f7),
    transparent: true,
    opacity: lineOpacity,
    linewidth: 2
  });
  const line = new THREE.Line(geo, mat);
  const mid = startVec3.clone().add(endVec3).multiplyScalar(0.5);
  line.userData = { center: centerTitle, title: targetTitle, kind: 'ray', normalMat: mat, mid };
  group.add(line);
}

function buildStarInto(centerTitle, data, gStar, gEdge, map){
  const centerMesh = new THREE.Sprite(materialCenter.clone());
  centerMesh.position.set(0,0,0);
  centerMesh.scale.setScalar(2);
  centerMesh.userData = { title: centerTitle, kind: 'center', baseScale: 2 };
  gStar.add(centerMesh);
  map.set(centerTitle, centerMesh);

  const neighbors = data.neighbors.slice(0,20);

  neighbors.forEach((nb, i) => {
    const pos = positionForNeighbor(nb, i, neighbors.length);
    if (previousTitle && nb === previousTitle) {
      placeReturnNeighbor(nb, pos, gStar, map);
      drawRay(centerTitle, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), i, neighbors.length, gEdge, RETURN_COLOR);
    } else {
      placeNeighbor(nb, pos, gStar, map);
      drawRay(centerTitle, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), i, neighbors.length, gEdge);
    }
  });

  if (previousTitle && !neighbors.includes(previousTitle)) {
    const idx = neighbors.length;
    const total = neighbors.length + 1;
    const pos = positionForNeighbor(previousTitle, idx, total);
    placeReturnNeighbor(previousTitle, pos, gStar, map);
    drawRay(centerTitle, previousTitle, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), idx, total, gEdge, RETURN_COLOR);
  }

  const sidebarNeighbors = neighbors.filter(nb => nb !== previousTitle);
  updateSidebar(data.center, sidebarNeighbors);
}

function rebuildStar(title, addTrail=true){
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${title}…`;
  overlay.classList.remove('hidden');
  getPageStar(title, showBacklinks).then(star => {
    overlay.classList.add('hidden');
    const canonical = star.center.title;
    clearGroup(starGroup); clearGroup(edgeGroup); wordToMesh.clear();
    buildStarInto(canonical, star, starGroup, edgeGroup, wordToMesh);
    currentTitle = canonical;
    controls.target.set(0,0,0);
    fadeInGroups();
    visited.add(canonical);
    if (addTrail) {
      if (historyIndex < breadcrumbs.length -1) breadcrumbs = breadcrumbs.slice(0, historyIndex+1);
      breadcrumbs.push(canonical);
      historyIndex = breadcrumbs.length -1;
    } else {
      historyIndex = breadcrumbs.indexOf(canonical);
    }
    updateBreadcrumbs();
    updateURL();
  }).catch(err => {
    console.error(err);
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
  });
}

// ====== Travel ======
let isAnimating = false;
async function travelToNeighbor(targetTitle){
  if (isAnimating || !currentTitle || !wordToMesh.has(targetTitle)) return;
  isAnimating = true;

  const from = new THREE.Vector3(0,0,0);
  const to = wordToMesh.get(targetTitle).position.clone();

  previousTitle = currentTitle;

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

  const newStar = new THREE.Group();
  const newEdge = new THREE.Group();
  const newMap = new Map();
  buildStarInto(star.center.title, star, newStar, newEdge, newMap);
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
      if (trailMode) {
        ghosts.forEach(g=> g.position.sub(to));
        trailPositions.forEach(p=> p.sub(to));
        trailPositions.push(new THREE.Vector3(0,0,0));
        if(trailPositions.length > MAX_GHOSTS+1) trailPositions.shift();
        updateTrailGeometry();
        starGroup.position.sub(to);
        edgeGroup.position.sub(to);
        const ghost = new THREE.Group();
        ghost.add(starGroup);
        ghost.add(edgeGroup);
        ghost.traverse(obj=>{ if(obj.material && 'opacity' in obj.material){ obj.material.opacity = (obj.userData.baseOpacity||1)*0.2; }});
        ghostRoot.add(ghost);
        ghosts.push(ghost);
        if(ghosts.length > MAX_GHOSTS){ const g = ghosts.shift(); ghostRoot.remove(g); }
      } else {
        scene.remove(starGroup); scene.remove(edgeGroup);
      }
      newStar.position.sub(to); newEdge.position.sub(to);
      starGroup = newStar;
      edgeGroup = newEdge;
      wordToMesh = newMap;
      currentTitle = star.center.title;
      controls.target.set(0,0,0);
      camera.position.copy(endOffset);
      visited.add(currentTitle);
      if (historyIndex < breadcrumbs.length -1) breadcrumbs = breadcrumbs.slice(0, historyIndex+1);
      breadcrumbs.push(currentTitle);
      historyIndex = breadcrumbs.length -1;
      updateBreadcrumbs();
      updateURL();
      hovered = null;
      tooltip.classList.remove('show');
      isAnimating = false;
    }
  }
  requestAnimationFrame(tick);
}

// ====== Sidebar ======
function updateSidebar(center, neighbors){
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
  summaryCache.set(center.title, { title: center.title, extract: center.summary || '', thumbnail: center.thumbnailUrl || null });

  const container = document.getElementById('neighbors');
  container.innerHTML = '';
  if (previousTitle) {
    const backRow = document.createElement('div');
    backRow.className = 'neighbor return';
    backRow.tabIndex = 0;
    backRow.textContent = `Back to ${previousTitle}`;
    backRow.addEventListener('click', e=> openPreview(previousTitle, e.clientX, e.clientY));
    backRow.addEventListener('keydown', e=>{ if(e.key==='Enter') openPreview(previousTitle); });
    container.appendChild(backRow);
  }
  neighbors.forEach(nb => {
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
  if (neighbors.length === 0) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = 'No links found';
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
  closePreview();
  if (previousTitle && target === previousTitle) {
    if (breadcrumbs.length >= 2) {
      jumpToBreadcrumb(breadcrumbs.length - 2);
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
  breadcrumbs.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.textContent = t;
    btn.title = t;
    btn.addEventListener('click', ()=> jumpToBreadcrumb(i));
    btn.addEventListener('keydown', e=>{ if(e.key==='Enter') jumpToBreadcrumb(i); });
    nav.appendChild(btn);
    if (i < breadcrumbs.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      nav.appendChild(sep);
    }
  });
}

function updateURL(){
  const params = new URLSearchParams();
  if(currentTitle) params.set('center', currentTitle);
  params.set('mode', showBacklinks ? 'backlinks' : 'outlinks');
  params.set('trail', trailMode ? '1' : '0');
  history.replaceState(null, '', '?' + params.toString());
}

function jumpToBreadcrumb(index){
  const title = breadcrumbs[index];
  breadcrumbs = breadcrumbs.slice(0, index+1);
  updateBreadcrumbs();
  previousTitle = currentTitle;
  rebuildStar(title, false);
  historyIndex = breadcrumbs.length -1;
}

function goHistory(delta){
  const target = historyIndex + delta;
  if (target < 0 || target >= breadcrumbs.length) return;
  historyIndex = target;
  previousTitle = breadcrumbs[target-1] || null;
  rebuildStar(breadcrumbs[target], false);
}

document.addEventListener('keydown', e=>{
  if (!previewOverlay.classList.contains('hidden')) return;
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goHistory(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    goHistory(1);
  }
});

// ====== Hover ======
function resetHovered(){
  if (!hovered) return;
  const obj = hovered.object;
  if (obj.userData.kind === 'neighbor') {
    if (obj.userData.isReturn) {
      obj.material = materialReturnNeighbor.clone();
    } else {
      const baseMat = visited.has(obj.userData.title)
        ? materialVisited
        : (showBacklinks ? materialBackNeighbor : materialNeighbor);
      obj.material = baseMat.clone();
    }
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
      if (obj.userData.isReturn) {
        obj.material = materialReturnNeighborHover.clone();
      } else {
        obj.material = (showBacklinks ? materialBackNeighborHover : materialNeighborHover).clone();
      }
      if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale * 1.25, obj.userData.baseScale * 1.25, 1);
      const v = obj.position.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      const y = (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.title;
    } else if (obj.userData.title && obj.userData.kind !== 'center') {
      obj.material = materialRayHover;
      const v = obj.userData.mid.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      const y = (-v.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
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

// ====== Search ======
const searchInput = document.getElementById('search');
let suggestTimer = null;
searchInput.addEventListener('input', (e)=>{
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  if (!q) { populateDatalist([]); return; }
  suggestTimer = setTimeout(async ()=>{
    try {
      const res = await wikiFetch(`https://en.wikipedia.org/w/api.php?action=opensearch&origin=*&limit=10&namespace=0&format=json&search=${encodeURIComponent(q)}`);
      const data = await res.json();
      populateDatalist(data[1] || []);
    } catch{}
  }, 300);
});

function populateDatalist(list){
  const dl = document.getElementById('wordlist');
  dl.innerHTML = '';
  list.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w;
    dl.appendChild(opt);
  });
}

document.getElementById('goBtn').addEventListener('click', onGo);
searchInput.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onGo(); });
document.getElementById('backToggle').addEventListener('change', (e)=>{
  showBacklinks = e.target.checked;
  if (currentTitle) rebuildStar(currentTitle, false);
  updateURL();
});
document.getElementById('trailToggle').addEventListener('change', (e)=>{
  trailMode = e.target.checked;
  ghostRoot.clear(); ghosts.length = 0;
  trailPositions.length = 0; trailPositions.push(new THREE.Vector3(0,0,0)); updateTrailGeometry();
  if(trailMode) ghostRoot.add(trailLine);
  updateURL();
  renderOnce();
});
document.getElementById('resetCam').addEventListener('click', ()=>{
  controls.target.set(0,0,0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  renderOnce();
});

const helpModal = document.getElementById('helpModal');
document.getElementById('helpBtn').addEventListener('click', ()=>{
  helpModal.classList.remove('hidden');
});
document.getElementById('helpClose').addEventListener('click', ()=>{
  helpModal.classList.add('hidden');
});
helpModal.addEventListener('click', (e)=>{
  if(e.target === helpModal) helpModal.classList.add('hidden');
});
function onGo(){
  const val = searchInput.value.trim();
  if (!val) return;
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  showBacklinks = false;
  document.getElementById('backToggle').checked = false;
  starCache.clear();
  summaryCache.clear();
  try { localStorage.clear(); } catch {}
  visited.clear();
  breadcrumbs = [];
  historyIndex = -1;
  ghostRoot.clear(); ghosts.length = 0;
  trailPositions.length = 0; trailPositions.push(new THREE.Vector3(0,0,0)); updateTrailGeometry();
  if(trailMode) ghostRoot.add(trailLine);
  previousTitle = null;
  updateBreadcrumbs();
  controls.target.set(0,0,0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  hovered = null;
  tooltip.classList.remove('show');
  rebuildStar(val);
  updateURL();
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

function init(){
  document.getElementById('loading').classList.add('hidden');
  updateBreadcrumbs();
  const params = new URLSearchParams(location.search);
  const center = params.get('center');
  const mode = params.get('mode');
  const trail = params.get('trail');
  if (mode === 'backlinks') {
    showBacklinks = true;
    document.getElementById('backToggle').checked = true;
  }
  trailMode = trail !== '0';
  document.getElementById('trailToggle').checked = trailMode;
  if (center) rebuildStar(center);
  animate();
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
