import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { getPageStar, fetchSummary, fetchWikidataFacts, fetchCrossLinks, fetchWikidataIds, fetchInstanceTypes, summaryCache, starCache } from "./wikipedia.js";

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

// Trackball (not orbit) controls: no fixed "up" axis, so the camera can tumble all
// the way around in any direction — the weightless, no-up/down feel of space.
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 1.4;
controls.zoomSpeed = 1.1;
controls.noPan = true;             // rotate + zoom only; no accidental panning
controls.staticMoving = false;     // dynamic damping for a smooth, weighty glide
controls.dynamicDampingFactor = 0.12;
controls.minDistance = 2;
controls.keys = [];                // don't grab A/S/D — leave keys for app shortcuts
controls.target.set(0, 0, 0);

// Idle drift: after a few seconds of no interaction, slowly turn. Honor reduced-motion.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IDLE_AXIS = new THREE.Vector3(0, 1, 0); // gentle drift around the vertical
const IDLE_MS = 5000;
let lastInteraction = performance.now();
function markInteraction(){ lastInteraction = performance.now(); }
renderer.domElement.addEventListener('pointerdown', markInteraction);
renderer.domElement.addEventListener('wheel', markInteraction, { passive: true });
controls.addEventListener('start', markInteraction);

// Background starfield for depth
let nebulaMesh = null; // the skybox sphere; its position tracks the camera each frame
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
  0.6,  // radius — slightly wider for a smoother falloff at glow edges
  0.5   // threshold — only the bright stars/rays bloom; keeps the mid-bright nebula
        // out of the bloom (otherwise its low-res bloom shows a grid + a hard edge
        // where its brightness crosses the threshold)
);
composer.addPass(bloomPass);
const vignettePass = new ShaderPass(VignetteShader);
vignettePass.uniforms.offset.value = 1.05;
vignettePass.uniforms.darkness.value = 1.25;
composer.addPass(vignettePass);
composer.addPass(new OutputPass());
// Reallocate the render targets at the correct size now that MSAA is enabled.
composer.setSize(container.clientWidth, container.clientHeight);

// Cross-links live on their own render layer so the bloom composer (camera layer 0)
// never sees them — otherwise they self-bloom into bright beams near the core. After
// the normal bloomed frame is composited, they're drawn in a plain overlay pass on
// top: still correctly projected in 3D, but no bloom. Everything else glows as before.
const CROSSLINK_LAYER = 1;
function renderScene(){
  composer.render();
  if (crossLinkLines.length || overviewInterlinkLines.length){
    const prevAutoClear = renderer.autoClear;
    const prevBg = scene.background;
    renderer.autoClear = false;     // don't wipe the composited frame
    scene.background = null;         // and don't repaint the backdrop over it
    renderer.setRenderTarget(null);
    camera.layers.set(CROSSLINK_LAYER); // render only cross-links, on top, no bloom
    renderer.render(scene, camera);
    camera.layers.set(0);               // restore default for the next bloom pass
    scene.background = prevBg;
    renderer.autoClear = prevAutoClear;
  }
}

// Resize handling
window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h); // also resizes the bloom pass at the device pixel ratio
  // (Don't call bloomPass.setSize here — it would override the above back to CSS
  //  resolution, halving bloom fidelity on retina and making it look blocky.)
  // Fat lines need their resolution kept in sync or their pixel width is wrong.
  scene.traverse(o => { if (o.material && o.material.isLineMaterial) o.material.resolution.set(w, h); });
  controls.handleResize(); // TrackballControls caches the viewport size for its rotate math
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
// Hide the thumbnail if its source fails to load (avoids a broken-image box).
previewThumb.addEventListener('error', ()=>{ previewThumb.style.display = 'none'; });
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

const trailMaterial = new LineMaterial({
  color: 0x9fb8ff, linewidth: 1.6, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false
});
trailMaterial.resolution.set(container.clientWidth, container.clientHeight);
const trailGeometry = new LineGeometry();
const trailLine = new Line2(trailGeometry, trailMaterial);
trailLine.visible = false;
scene.add(trailLine);

// Template for the faint edges between neighbours that link to one another
// (cross-links). Cloned per line so each owns its opacity — a single shared
// material gets dimmed by the travel/ghost crossfade, which would otherwise make
// freshly drawn cross-links inherit that dimming (bright on load, dim after a
// hop). Deliberately NOT additive (additive stacked overlaps into a white glare)
// and a dim desaturated violet so they read as secondary structure behind the
// blue rays.
const crossLinkMaterial = new LineMaterial({
  color: 0x8a7cc8, linewidth: 0.9, transparent: true, opacity: 0.46,
  blending: THREE.NormalBlending, depthWrite: false, depthTest: false
});

// A ">" chevron pointing +x, grayscale so the per-sprite colour tint stays accurate.
function makeChevronTexture(){
  const size = 64, ctx = Object.assign(document.createElement('canvas'), { width: size, height: size }).getContext('2d');
  ctx.strokeStyle = '#fff'; ctx.lineWidth = size * 0.095; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(size * 0.36, size * 0.28);
  ctx.lineTo(size * 0.68, size * 0.50);
  ctx.lineTo(size * 0.36, size * 0.72);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const chevronTexture = makeChevronTexture();
const CHEVRON_COLOR = new THREE.Color(0xb6a8ec);

// The journey path drawn in galaxy-overview mode (spans the whole session).
const overviewLineMaterial = new LineMaterial({
  // The route is an overlay: normal (not additive) blending + depthTest off so it
  // stays visible over the bright central nebula glow and isn't occluded by it.
  // Colour matches the "Your route" legend swatch. See visual-hierarchy notes.
  color: 0x9fb8ff, linewidth: 1.8, transparent: true, opacity: 0.95,
  blending: THREE.NormalBlending, depthWrite: false, depthTest: false
});
overviewLineMaterial.resolution.set(container.clientWidth, container.clientHeight);

SHARED_MATERIALS.add(overviewLineMaterial);

// ====== Interaction ======
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.1;
raycaster.params.Line2 = { threshold: 6 }; // px tolerance for hovering fat lines
const mouse = new THREE.Vector2();
const mousePx = { x: 0, y: 0 }; // cursor position relative to the canvas, in px
let hovered = null;
let previewTarget = null;
let peekedObject = null;       // touch: the spoke revealed by the previous tap (tap it again to confirm)
let lastPointerWasTouch = false;

container.addEventListener('mousemove', (e)=>{
  if (isTouchDragging()) return;            // ignore synthetic moves while orbiting on touch
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  mousePx.x = e.clientX - rect.left;
  mousePx.y = e.clientY - rect.top;
});

// --- Tap vs drag detection: pointer-based so a tap tolerates small wobble (we don't
// rely on the flaky synthetic 'click' on touch). Also lays the groundwork for the
// long-press action ring (a held pointer is excluded from tap handling). ---
let tapStart = null;       // { x, y, t, moved } for the active single-pointer gesture
let activePointers = 0;
const LONGPRESS_MS = 450;
const TAP_MOVE = 10;       // px: a move past this is a drag, not a tap
const LONGPRESS_MOVE = 16; // px: more generous — a jittery thumb shouldn't cancel a long-press
let longPressTimer = null;
let pressTarget = null;    // what was under the finger at press time (locked, so camera drift can't change it)
function cancelLongPress(){ if (longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; } }
function isTouchDragging(){ return lastPointerWasTouch && !!(tapStart && tapStart.moved); }
renderer.domElement.addEventListener('pointerdown', (e)=>{
  activePointers++;
  lastPointerWasTouch = (e.pointerType === 'touch' || e.pointerType === 'pen');
  if (activePointers === 1){
    tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    // Touch long-press opens the action ring (desktop uses right-click; see below).
    if (lastPointerWasTouch){
      cancelLongPress();
      const px = e.clientX, py = e.clientY;
      pressTarget = pickAnyAt(px, py); // lock the target now, before any camera drift
      longPressTimer = setTimeout(()=>{
        longPressTimer = null;
        if (tapStart){ const tgt = pressTarget; tapStart = null; openActionRing(px, py, tgt); }
      }, LONGPRESS_MS);
    }
  } else { if (tapStart) tapStart.moved = true; cancelLongPress(); } // 2nd finger (pinch) cancels tap + long-press
});
renderer.domElement.addEventListener('pointermove', (e)=>{
  if (!tapStart) return;
  const d = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  if (!tapStart.moved && d > TAP_MOVE) tapStart.moved = true; // tap → drag
  if (d > LONGPRESS_MOVE) cancelLongPress();                  // only a real drag cancels the long-press
});
renderer.domElement.addEventListener('pointerup', (e)=>{
  activePointers = Math.max(0, activePointers - 1);
  cancelLongPress();
  const ts = tapStart; tapStart = null;
  if (!ts || ts.moved || performance.now() - ts.t > 600) return; // moved → drag; held → long-press fired
  handleTap(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointercancel', ()=>{ activePointers = Math.max(0, activePointers - 1); cancelLongPress(); tapStart = null; });
renderer.domElement.addEventListener('contextmenu', (e)=>{ e.preventDefault(); openActionRing(e.clientX, e.clientY, pickAnyAt(e.clientX, e.clientY)); }); // desktop right-click (precise)

// The spokes all converge on the center node, so a raycast near the middle tends to
// grab a ray's inner stub instead of the center star. Claim a small screen radius
// around the center node for the center itself.
const CENTER_PICK_R = 34; // px
function centerStarAt(clientX, clientY){
  const cs = starGroup.children.find(o => o.userData && o.userData.kind === 'center' && o.visible);
  if (!cs) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const v = cs.getWorldPosition(new THREE.Vector3()).project(camera);
  if (v.z > 1) return null; // behind the camera
  const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
  const sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
  return (Math.hypot(clientX - sx, clientY - sy) <= CENTER_PICK_R) ? cs : null;
}

// Pick the spoke/star under a screen coord. Used by tap handling so selection
// never depends on the RAF-driven hover state (which is stale at click time on touch).
function pickObjectAt(clientX, clientY){
  if (centerStarAt(clientX, clientY)) return null; // near the center = the center node, not a spoke stub
  const rect = renderer.domElement.getBoundingClientRect();
  const m = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  const hits = raycaster.intersectObjects([...edgeGroup.children, ...starGroup.children], false);
  if (!hits.length) return null;
  const o = hits[0].object;
  return (o.userData && o.userData.title && o.userData.kind !== 'center') ? o : null;
}

function confirmTarget(obj, x, y){
  const toTitle = obj.userData.title;
  const prev = getChainPrev();
  if (prev && toTitle === prev && obj.userData.kind === 'ray') goBackOne();
  else openPreview(toTitle, x, y);
}

function handleTap(clientX, clientY){
  if (isAnimating) return; // ignore taps during animation
  if (overviewActive) { closeMapNodePopup(); exitPanelPreview(); return; } // tapping the void dismisses the popup + preview
  // Anchor hover to the tap point so the title tooltip shows where the finger landed.
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  mousePx.x = clientX - rect.left;
  mousePx.y = clientY - rect.top;

  const obj = pickObjectAt(clientX, clientY);
  if (lastPointerWasTouch) {
    // Two-step: first tap peeks the name; tapping the SAME spoke again confirms.
    // Tapping a different spoke peeks that one; tapping empty space dismisses.
    if (obj && obj === peekedObject) {
      peekedObject = null;
      confirmTarget(obj, clientX, clientY);
    } else if (obj) {
      peekedObject = obj;
    } else {
      peekedObject = null;
      if (previewTarget) closePreview();
    }
  } else {
    // Mouse: a single click travels (hover already revealed the title).
    if (obj) confirmTarget(obj, clientX, clientY);
    else if (previewTarget) closePreview();
  }
}

// Tell the sheet (on mobile) to collapse so a freshly-drawn cluster is visible.
function notifyNavigate(){
  if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
    window.dispatchEvent(new Event('starwiki:navigate'));
  }
}

// ====== Contextual action ring (long-press on touch / right-click on desktop) ======
let ringEl = null, ringBackdrop = null, ringOpen = false;

function pickAnyAt(clientX, clientY){
  const cs = centerStarAt(clientX, clientY);
  if (cs) return cs; // near the center = the center node, not a converging spoke
  const rect = renderer.domElement.getBoundingClientRect();
  const m = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  const hits = raycaster.intersectObjects([...edgeGroup.children, ...starGroup.children], false);
  return hits.length ? hits[0].object : null;
}

const wikiUrl = (t)=> `https://en.wikipedia.org/wiki/${encodeURIComponent(t)}`;
function setPath(field, title){ window.dispatchEvent(new CustomEvent('starwiki:setpath', { detail: { field, title } })); }

function actionsForContext(obj){
  // Empty-space / map "command wheel"
  const commandWheel = {
    label: '',
    actions: [
      { icon: 'ic-home',     label: 'Recenter',  run: ()=> centerCameraOnCurrent() },
      { icon: 'ic-surprise', label: 'Surprise',  run: ()=> document.getElementById('randomBtn')?.click() },
      { icon: 'ic-map',      label: overviewActive ? 'Exit map' : 'Galaxy', run: ()=> document.getElementById('mapBtn')?.click() },
      { icon: 'ic-link',     label: 'Copy link', run: ()=> copyShareLink() },
    ]
  };
  if (overviewActive) return commandWheel;
  if (obj && obj.userData && obj.userData.kind === 'center'){
    return {
      label: currentTitle,
      actions: [
        { icon: 'ic-home',     label: 'Recenter',  run: ()=> centerCameraOnCurrent() },
        { icon: 'ic-external', label: 'Wikipedia', run: ()=> window.open(wikiUrl(currentTitle), '_blank', 'noopener') },
        { icon: 'ic-link',     label: 'Copy link', run: ()=> copyShareLink() },
        { icon: 'ic-surprise', label: 'Surprise',  run: ()=> document.getElementById('randomBtn')?.click() },
      ]
    };
  }
  if (obj && obj.userData && obj.userData.title){
    const title = obj.userData.title;
    const isReturn = (title === getChainPrev() && obj.userData.kind === 'ray');
    return {
      label: title,
      actions: [
        { icon: 'ic-star',     label: isReturn ? 'Go back' : 'Travel', run: ()=> isReturn ? goBackOne() : travelToNeighbor(title) },
        { icon: 'ic-search',   label: 'Preview',   run: ()=> openPreview(title) },
        { icon: 'ic-external', label: 'Wikipedia', run: ()=> window.open(wikiUrl(title), '_blank', 'noopener') },
        { icon: 'ic-route',    label: 'Path from', run: ()=> setPath('from', title) },
        { icon: 'ic-route',    label: 'Path to',   run: ()=> setPath('to', title) },
      ]
    };
  }
  return commandWheel;
}

function ensureRingDom(){
  if (ringEl) return;
  ringBackdrop = document.createElement('div');
  ringBackdrop.className = 'ring-backdrop';
  ringBackdrop.addEventListener('pointerdown', (e)=>{ e.preventDefault(); e.stopPropagation(); closeActionRing(); });
  ringEl = document.createElement('div');
  ringEl.className = 'action-ring';
  document.body.appendChild(ringBackdrop);
  document.body.appendChild(ringEl);
}

function openActionRing(clientX, clientY, target){
  if (isAnimating || !currentTitle) return;
  const ctx = actionsForContext(target);
  if (!ctx || !ctx.actions.length) return;
  ensureRingDom();
  ringEl.innerHTML = '';
  if (ctx.label){
    const c = document.createElement('div');
    c.className = 'ring-center';
    c.textContent = ctx.label;
    ringEl.appendChild(c);
  }
  const n = ctx.actions.length;
  const R = 82;
  ctx.actions.forEach((a, i)=>{
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2; // first action at the top
    const bx = Math.cos(ang) * R, by = Math.sin(ang) * R;
    const btn = document.createElement('button');
    btn.className = 'ring-btn';
    btn.style.left = `calc(50% + ${bx.toFixed(1)}px)`;
    btn.style.top = `calc(50% + ${by.toFixed(1)}px)`;
    btn.setAttribute('aria-label', a.label);
    btn.innerHTML = `<svg class="icon"><use href="#${a.icon}"/></svg><span>${a.label}</span>`;
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); const run = a.run; closeActionRing(); run(); });
    ringEl.appendChild(btn);
  });
  // Anchor at the press point, clamped so the whole ring stays on-screen.
  const pad = R + 56;
  const cx = Math.min(window.innerWidth - pad, Math.max(pad, clientX));
  const cy = Math.min(window.innerHeight - pad, Math.max(pad, clientY));
  ringEl.style.left = cx + 'px';
  ringEl.style.top = cy + 'px';
  ringBackdrop.style.display = 'block';
  ringEl.style.display = 'block';
  ringOpen = true;
  // NOTE: don't toggle controls.enabled here — disabling TrackballControls mid-gesture
  // makes its onPointerUp early-return and leak a "stuck" pointer, which then reads as
  // phantom multi-touch (runaway pinch-zoom). The backdrop already blocks new gestures,
  // and the idle drift is gated on !ringOpen, so the view stays put while the ring is up.
  // restart the bloom-in animation
  ringEl.classList.remove('show'); void ringEl.offsetWidth; ringEl.classList.add('show');
}

function closeActionRing(){
  if (!ringOpen) return;
  ringOpen = false;
  if (ringEl){ ringEl.style.display = 'none'; ringEl.classList.remove('show'); }
  if (ringBackdrop) ringBackdrop.style.display = 'none';
}
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && ringOpen) closeActionRing(); });

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
    trailLine.visible = false;
    return;
  }
  const arr = [];
  pts.forEach(p => { arr.push(p.x, p.y, p.z); });
  trailGeometry.setPositions(arr);
  trailLine.computeLineDistances();
  trailLine.visible = trailMode;
}

// ====== Star building ======
let currentTitle = null;
let history = [];
let historyIndex = -1;
const visited = new Set();
let wordToMesh = new Map();
let showBacklinks = false;
let trailMode = true;
let starSizeMode = 'uniform';   // 'uniform' | 'length'
let showCrossLinks = false;

// Cross-link edges among the current neighbours (live in edgeGroup).
let crossLinkLines = [];
let crossToken = 0;

// Galaxy overview: every center's position for the whole session (never pruned
// down to the ghost cap, so the full journey can be charted at once).
const journeyPositions = new Map();
const journeyMeta = new Map();      // title -> { wikidataId, length, categories }
let overviewActive = false;
let overviewGroup = null;
let overviewLabelEls = [];
let overviewHidden = [];
let overviewTransitioning = false;
let overviewFadeId = 0;
// Galaxy-map enrichment (relations drive size + interlinks; Wikidata type drives colour).
let overviewNodeSprites = new Map(); // title -> sprite
let overviewInterlinkLines = [];     // faint links among journey nodes (layer 1, no bloom)
let overviewChevrons = [];           // [{ sprites, pa, pb }] directional chevrons over each interlink
let overviewChevronsBuiltAt = 0;
let overviewRelations = new Map();   // title -> connection degree within the journey
let overviewTypes = new Map();       // title -> type bucket key
let overviewDataToken = 0;
let overviewDataCache = { sig: null, pairs: null, degrees: null, types: null };
let overviewEncodeRAF = 0;

// Wikidata "instance of" (P31) QID -> type bucket. Curated; unknown -> 'concept'.
const TYPE_BUCKETS = {
  person:  { label: 'Person',       hue: 0xffd36e },
  place:   { label: 'Place',        hue: 0x5ee0ff },
  org:     { label: 'Organization', hue: 0xff9e57 },
  event:   { label: 'Event',        hue: 0xf7768e },
  work:    { label: 'Work',         hue: 0xc792ea },
  species: { label: 'Species',      hue: 0x9ece6a },
  concept: { label: 'Concept',      hue: 0x7aa2f7 }
};
const QID_BUCKET = {
  Q5: 'person',
  // places
  Q515: 'place', Q6256: 'place', Q3624078: 'place', Q486972: 'place', Q82794: 'place',
  Q23442: 'place', Q8502: 'place', Q4022: 'place', Q23397: 'place', Q165: 'place',
  Q1549591: 'place', Q5119: 'place', Q35657: 'place', Q15284: 'place', Q34442: 'place',
  Q12280: 'place', Q33837: 'place', Q75848: 'place',
  // organizations
  Q43229: 'org', Q4830453: 'org', Q891723: 'org', Q3918: 'org', Q327333: 'org',
  Q7278: 'org', Q215380: 'org', Q476028: 'org', Q936518: 'org', Q163740: 'org',
  Q31855: 'org', Q484652: 'org', Q748720: 'org',
  // events
  Q1190554: 'event', Q1656682: 'event', Q198: 'event', Q178561: 'event', Q132241: 'event',
  Q13418847: 'event', Q18608583: 'event', Q1799072: 'event', Q40231: 'event',
  // creative works
  Q11424: 'work', Q7889: 'work', Q571: 'work', Q7366: 'work', Q482994: 'work',
  Q2188189: 'work', Q47461344: 'work', Q838948: 'work', Q5398426: 'work', Q1107: 'work',
  Q134556: 'work', Q105543609: 'work', Q386724: 'work', Q7725634: 'work',
  // species / taxa
  Q16521: 'species', Q7432: 'species', Q55983715: 'species', Q713623: 'species'
};
function bucketForQids(list){
  for (const q of (list || [])) { if (QID_BUCKET[q]) return QID_BUCKET[q]; }
  return 'concept';
}

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

// Scale factor for a neighbour star from the active "Star size" metric. Length is
// the page's byte size (already fetched in metaByTitle); mapped on a log scale so
// stubs and mega-articles both stay in a sane visual range. 1 = no scaling.
function metricMult(meta){
  if (starSizeMode !== 'length' || !meta) return 1;
  const len = meta.length;
  if (!len || len <= 0) return 1;
  const t = Math.min(1, Math.max(0, (Math.log10(len) - 3) / 2)); // 1KB→0, 100KB→1
  return 0.7 + t * 1.1; // 0.7 .. 1.8
}

// ---- Bloom tween store for cluster expansion
const _blooms = []; // { mesh, start, delayMs, target }

function placeNeighbor(title, posArray, group = starGroup, map = wordToMesh, meta = null, instant = false){
  const isVisited = visited.has(title);
  const baseMat = isVisited
    ? materialVisited
    : (showBacklinks ? materialBackNeighbor : materialNeighbor);
  const mesh = new THREE.Sprite(baseMat.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  const th = seededHash(title);
  // Visited stars read as smaller + dimmer ("been there"); the size metric (if
  // any) then scales that base.
  const baseScale = (isVisited ? 0.8 : 1.2) * metricMult(meta);
  mesh.userData = {
    title, kind: 'neighbor', baseScale,
    // Per-star twinkle so the cluster breathes organically instead of in lockstep.
    twFreq: 1.0 + (th % 100) / 100 * 1.8,   // 1.0 .. 2.8 Hz-ish
    twPhase: ((th >> 7) % 628) / 100,        // 0 .. ~2π
    twAmp: 0.07 + (th % 60) / 600            // 0.07 .. 0.17
  };
  if (instant) {
    // Used when replaying a loaded journey's trail — appear at full size, no scale-in.
    mesh.scale.set(baseScale, baseScale, 1);
  } else {
    // start tiny; animate to base scale
    mesh.scale.set(0.001, 0.001, 1);
    _blooms.push({
      mesh,
      start: performance.now(),
      delayMs: 60 + (seededHash(title) % 180),
      target: baseScale
    });
  }
  group.add(mesh);
  map.set(title, mesh);
  return mesh;
}

function drawRay(centerTitle, targetTitle, startVec3, endVec3, rank, total, group = edgeGroup, colorOverride=null){
  const lineOpacity = colorOverride ? 1 : opacityFromRank(rank, total);
  const baseColor = colorOverride || (showBacklinks ? 0xffd36e : 0x7aa2f7);
  // Fat, screen-space-width line. A midpoint vertex at 60% lets the hub colour hold
  // for the first 60% of the shaft, then fade to the tip over the last 40% (so a
  // type-coloured ray stays blue further toward the node).
  const midVec = startVec3.clone().lerp(endVec3, 0.6);
  const geo = new LineGeometry();
  geo.setPositions([startVec3.x, startVec3.y, startVec3.z, midVec.x, midVec.y, midVec.z, endVec3.x, endVec3.y, endVec3.z]);
  const cStart = new THREE.Color(baseColor);
  const cEnd = new THREE.Color(baseColor).multiplyScalar(0.3);
  geo.setColors([cStart.r, cStart.g, cStart.b, cStart.r, cStart.g, cStart.b, cEnd.r, cEnd.g, cEnd.b]);
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
    target: targetTitle,
    start: startVec3.clone(),
    end: endVec3.clone(),
    speed: 0.22 + (seededHash(centerTitle + '→' + targetTitle) % 120) / 500,
    phase: (seededHash(targetTitle) % 1000) / 1000
  };
  group.add(dot);
}

function buildStarInto(centerTitle, data, gStar, gEdge, map, prevTitle=null, prevVec=null, instant=false, updateUI=true){
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

  const meta = data.metaByTitle || {};
  filtered.forEach((nb, i) => {
    const pos = positionForNeighbor(nb, i, filtered.length);
    placeNeighbor(nb, pos, gStar, map, meta[nb], instant);
    drawRay(centerTitle, nb, new THREE.Vector3(0,0,0), new THREE.Vector3(pos[0], pos[1], pos[2]), i, filtered.length, gEdge);
  });

  if (prevTitle && prevVec) {
    drawRay(centerTitle, prevTitle, new THREE.Vector3(0,0,0), prevVec, 0, 1, gEdge, RETURN_COLOR);
  }

  // Trail clusters of a loaded journey skip the sidebar (it shows the destination).
  if (updateUI) updateSidebar(data.center, filtered, prevTitle, data.metaByTitle);
}

function rebuildStar(title, addToHistory=true){
  setLoading(true);
  return getPageStar(title, showBacklinks).then(star => {
    setLoading(false);
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
    journeyPositions.clear();
    journeyMeta.clear();
    trailLine.visible = false;
    buildStarInto(canonical, star, starGroup, edgeGroup, wordToMesh);
    clusterGroups.set(canonical, { star: starGroup, edge: edgeGroup });
    centerPositions.set(canonical, new THREE.Vector3(0,0,0));
    recordJourneyPos(canonical, new THREE.Vector3(0,0,0));
    journeyMeta.set(canonical, { wikidataId: star.center.wikidataId, length: star.center.length, categories: star.center.categories });
    // Restored a multi-stop history (shared link / saved journey)? Lay the earlier
    // stops out as a chain behind the current node, using the same incoming-vector
    // rule as live travel, so the galaxy map is usable before any new navigation.
    if (history.length > 1 && historyIndex === history.length - 1){
      let p = new THREE.Vector3(0, 0, 0);
      for (let i = history.length - 1; i > 0; i--){
        const d = directionFromTitle(history[i]);
        p = p.clone().sub(new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(SEGMENT_DIST));
        recordJourneyPos(history[i - 1], p);
      }
    }
    currentTitle = canonical;
    controls.target.copy(new THREE.Vector3(0,0,0));
    fadeInGroups();
    visited.add(canonical);
    updateBreadcrumbs();
    updateTrail();
    ensureCrossLinks(canonical);
    applyNeighborTypes(canonical);
    isAnimating = false;
  }).catch(err => {
    console.error(err);
    setLoading(false);
    showToast('Failed to load page.');
    isAnimating = false;
  });
}

async function refreshCurrentNeighbors(){
  if (!currentTitle) return;
  setLoading(true);
  let star;
  try {
    star = await getPageStar(currentTitle, showBacklinks);
  } catch (e) {
    setLoading(false);
    showToast('Failed to load page.');
    return;
  }
  setLoading(false);

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
  ensureCrossLinks(currentTitle);
  applyNeighborTypes(currentTitle);
  renderOnce();
}

// ====== Cross-links among neighbours ======
function clearCrossLinks(){
  crossLinkLines.forEach(line => {
    if (line.parent) line.parent.remove(line);
    if (line.geometry && line.geometry.dispose) line.geometry.dispose();
    if (line.material && line.material.dispose && !SHARED_MATERIALS.has(line.material)) line.material.dispose();
  });
  crossLinkLines = [];
}

function drawCrossLinks(pairs){
  const seen = new Set();
  for (const [a, b] of pairs){
    if (crossLinkLines.length >= 80) break;
    const ma = wordToMesh.get(a), mb = wordToMesh.get(b);
    if (!ma || !mb) continue;
    const key = a < b ? a + ' ' + b : b + ' ' + a; // undirected dedupe
    if (seen.has(key)) continue;
    seen.add(key);
    const pa = ma.position, pb = mb.position;
    const geo = new LineGeometry();
    geo.setPositions([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z]);
    // Own material clone so the cluster crossfade can't permanently dim it.
    const mat = crossLinkMaterial.clone();
    mat.resolution.set(container.clientWidth, container.clientHeight);
    const line = new Line2(geo, mat);
    line.userData = { kind: 'crosslink' };
    line.raycast = () => {}; // decorative — never intercept hover/click
    line.layers.set(CROSSLINK_LAYER); // excluded from the bloom pass; drawn as an overlay
    edgeGroup.add(line);
    crossLinkLines.push(line);
  }
  renderOnce();
}

// (Re)compute cross-links for the active cluster. Best-effort + token-guarded so
// a result that arrives after the user has moved on is discarded.
function ensureCrossLinks(centerTitle){
  clearCrossLinks();
  const myToken = ++crossToken;
  if (!showCrossLinks || !centerTitle || overviewActive) return;
  const titles = [];
  wordToMesh.forEach((mesh, t) => { if (mesh.userData && mesh.userData.kind === 'neighbor') titles.push(t); });
  if (titles.length < 2) return;
  fetchCrossLinks(titles).then(pairs => {
    if (myToken !== crossToken || currentTitle !== centerTitle || isAnimating || overviewActive || !showCrossLinks) return;
    drawCrossLinks(pairs);
  }).catch(()=>{});
}

// ====== Neighbour colour-by-type (mirrors the galaxy map's node colouring) ======
const neighborTypeCache = new Map(); // title -> bucket key (session-wide; types don't change)
let neighborTypeToken = 0;

function applyTypeColorsToMeshes(titles){
  titles.forEach(t => {
    const bucket = neighborTypeCache.get(t);
    if (!bucket) return;
    const mesh = wordToMesh.get(t);
    if (!mesh || !mesh.userData || mesh.userData.kind !== 'neighbor') return;
    const hue = TYPE_BUCKETS[bucket].hue;
    mesh.userData.typeHue = hue;
    // Visited stays grey ("been there"); a hovered star keeps its hover tint.
    if (!visited.has(t) && (!hovered || hovered.object !== mesh)){
      mesh.material.color.setHex(hue);
      mesh.userData.baseColorHex = hue;
    }
  });
  recolorRaysByType();
}

// Cluster-view legend: a collapsed chip (bottom-left) listing the link-type colours
// present on the current page; expands on hover. Hidden in map mode (the map's own
// legend takes over) and on the blank welcome screen.
function renderTypeLegend(){
  const box = document.getElementById('typeLegend');
  if (!box) return;
  if (overviewActive || !currentTitle){ box.classList.add('hidden'); box.style.opacity = ''; box.innerHTML = ''; return; }
  const present = new Set();
  wordToMesh.forEach((m, t) => { if (m.userData && m.userData.kind === 'neighbor'){ const b = neighborTypeCache.get(t); if (b) present.add(b); } });
  if (!present.size){ box.classList.add('hidden'); box.style.opacity = ''; box.innerHTML = ''; return; }
  const order = ['person','place','org','event','work','species','concept'];
  const buckets = order.filter(b => present.has(b));
  const hex = b => new THREE.Color(TYPE_BUCKETS[b].hue).getHexString();
  const dots = buckets.map(b => `<i style="background:#${hex(b)}"></i>`).join('');
  const rows = buckets.map(b => `<span class="tl-type"><i style="background:#${hex(b)}"></i>${TYPE_BUCKETS[b].label}</span>`).join('');
  box.innerHTML =
    `<div class="tl-head">${dots}<span class="tl-label">Node types</span></div>` +
    `<div class="tl-body">${rows}</div>`;
  box.classList.remove('hidden');
  requestAnimationFrame(() => { box.style.opacity = '1'; });
}
function hideTypeLegend(){
  const box = document.getElementById('typeLegend');
  if (box){ box.classList.add('hidden'); box.style.opacity = ''; box.innerHTML = ''; }
}

// Repaint each ray's gradient: its hub colour (blue / gold) at the centre fading
// to the target node's type colour at the tip. Comet dots take the type colour too.
function recolorRaysByType(){
  edgeGroup.children.forEach(obj => {
    const ud = obj.userData;
    if (!ud) return;
    if (ud.kind === 'ray' && ud.title && ud.baseColorHex !== RETURN_COLOR){
      const bucket = neighborTypeCache.get(ud.title);
      if (!bucket || !obj.geometry || !obj.geometry.setColors) return;
      const start = new THREE.Color(ud.baseColorHex);
      const end = new THREE.Color(TYPE_BUCKETS[bucket].hue).multiplyScalar(0.85);
      // 3 vertices: hub colour holds through the 60% midpoint, then fades to the tip.
      obj.geometry.setColors([start.r, start.g, start.b, start.r, start.g, start.b, end.r, end.g, end.b]);
    } else if (ud.kind === 'rayDot' && ud.target){
      const bucket = neighborTypeCache.get(ud.target);
      if (bucket) obj.material.color.setHex(TYPE_BUCKETS[bucket].hue);
    }
  });
  renderTypeLegend();
}

// Colour the current cluster's neighbour stars by Wikidata type. Cached per title;
// only the unknown ones cost a request (one id batch + one P31 batch). Token-guarded.
async function applyNeighborTypes(centerTitle){
  const myToken = ++neighborTypeToken;
  const titles = [];
  wordToMesh.forEach((m, t) => { if (m.userData && m.userData.kind === 'neighbor') titles.push(t); });
  if (!titles.length) return;
  applyTypeColorsToMeshes(titles); // paint anything already cached right away
  const missing = titles.filter(t => !neighborTypeCache.has(t));
  if (!missing.length) return;
  try {
    const idMap = await fetchWikidataIds(missing);
    const ids = [...new Set([...idMap.values()])];
    const p31 = await fetchInstanceTypes(ids);
    if (myToken !== neighborTypeToken || currentTitle !== centerTitle) return; // moved on
    missing.forEach(t => { const qid = idMap.get(t); neighborTypeCache.set(t, bucketForQids(qid ? p31.get(qid) : [])); });
    applyTypeColorsToMeshes(missing);
    renderOnce();
  } catch {}
}

// ====== Star sizing ======
function applyStarSizes(){
  wordToMesh.forEach((mesh, title) => {
    if (!mesh.userData || mesh.userData.kind !== 'neighbor') return;
    const isVisited = visited.has(title);
    const base = (isVisited ? 0.8 : 1.2) * metricMult(currentMeta[title]);
    mesh.userData.baseScale = base;
    mesh.scale.set(base, base, 1);
  });
  renderOnce();
}

// ====== Galaxy overview map ======
function recordJourneyPos(title, vec){
  if (!title || !vec) return;
  journeyPositions.set(title, vec.clone());
  if (journeyPositions.size > 250){
    const first = journeyPositions.keys().next().value;
    journeyPositions.delete(first);
  }
}

function buildOverview(){
  overviewGroup = new THREE.Group();
  overviewNodeSprites = new Map();
  overviewInterlinkLines = [];
  journeyPositions.forEach((pos, title) => {
    const isCur = title === currentTitle;
    const mat = new THREE.SpriteMaterial({
      map: starTexture, color: isCur ? 0xffffff : 0x8ea6e0,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      opacity: isCur ? 1 : 0.85
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(isCur ? 2.4 : 1.3);
    s.userData = { kind: 'overviewNode', title, isCur, baseScale: isCur ? 2.4 : 1.3 };
    overviewGroup.add(s);
    overviewNodeSprites.set(title, s);
  });
  // Journey path through history order (skip consecutive repeats).
  const pts = [];
  let last = null;
  history.forEach(t => { const p = journeyPositions.get(t); if (p && t !== last){ pts.push(p); last = t; } });
  if (pts.length >= 2){
    const arr = [];
    pts.forEach(p => arr.push(p.x, p.y, p.z));
    const geo = new LineGeometry();
    geo.setPositions(arr);
    overviewLineMaterial.resolution.set(container.clientWidth, container.clientHeight);
    const line = new Line2(geo, overviewLineMaterial);
    line.computeLineDistances();
    line.raycast = () => {};
    overviewGroup.add(line);
  }
  scene.add(overviewGroup);
}

function buildOverviewLabels(){
  const box = document.getElementById('overviewLabels');
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('hidden');
  overviewLabelEls = [];
  journeyPositions.forEach((pos, title) => {
    const b = document.createElement('button');
    b.className = 'overview-label' + (title === currentTitle ? ' current' : '');
    b.textContent = title;
    b.title = title;
    b.dataset.title = title;
    b.addEventListener('click', () => onOverviewLabelClick(title));
    box.appendChild(b);
    overviewLabelEls.push({ el: b, pos });
  });
}

function updateOverviewLabels(){
  if (!overviewActive || !overviewLabelEls.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3();
  for (const { el, pos } of overviewLabelEls){
    v.copy(pos).project(camera);
    if (v.z > 1){ el.style.display = 'none'; continue; } // behind the camera
    el.style.display = '';
    el.classList.toggle('selected', !!panelPreviewTitle && el.dataset.title === panelPreviewTitle);
    el.style.left = (rect.left + (v.x * 0.5 + 0.5) * rect.width) + 'px';
    el.style.top  = (rect.top  + (-v.y * 0.5 + 0.5) * rect.height) + 'px';
  }
}

// Per-frame: orient each chevron to its link's on-screen angle (robust to free
// rotation) and run a bright band along it (source → target, or both halves → middle).
const _chevA = new THREE.Vector3(), _chevB = new THREE.Vector3();
const TWO_PI = Math.PI * 2;
function updateOverviewChevrons(tMs){
  if (!overviewChevrons.length) return;
  const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
  const reveal = REDUCED ? 1 : Math.min(1, (tMs - overviewChevronsBuiltAt) / 700);
  for (const link of overviewChevrons){
    _chevA.copy(link.pa).project(camera);
    _chevB.copy(link.pb).project(camera);
    const angle = Math.atan2(_chevB.y - _chevA.y, (_chevB.x - _chevA.x) * aspect);
    const cyc = link.cyc;
    for (const s of link.sprites){
      const u = s.userData;
      s.material.rotation = u.pointSign > 0 ? angle : angle + Math.PI;
      // A brightness wave flows across ALL chevrons toward the target / the middle
      // (crests travel source→target in ~2.5s; the chevrons stay visible as the line).
      const wave = REDUCED ? 0.7 : (0.5 + 0.5 * Math.cos(cyc * (u.flow - tMs / 3800) * TWO_PI));
      s.material.opacity = reveal * (0.4 + 0.6 * wave);
      const sc = u.baseScale * (1 + 0.2 * wave);
      s.scale.set(sc, sc, 1);
    }
  }
}

// ===== Galaxy-map enrichment: relations (size + interlinks) and type (colour) =====
async function loadOverviewData(){
  const myToken = ++overviewDataToken;
  const titles = [...journeyPositions.keys()];
  if (titles.length < 2) return;
  const sig = titles.join('|');
  let pairs, degrees, types;
  if (overviewDataCache.sig === sig && overviewDataCache.degrees){
    ({ pairs, degrees, types } = overviewDataCache);
  } else {
    pairs = [];
    try { pairs = await fetchCrossLinks(titles); } catch {}
    const titleSet = new Set(titles);
    const adj = new Map();
    for (const [a, b] of pairs){
      if (a === b || !titleSet.has(a) || !titleSet.has(b)) continue;
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    }
    degrees = new Map();
    titles.forEach(t => degrees.set(t, adj.has(t) ? adj.get(t).size : 0));
    // Resolve Wikidata ids fresh (don't rely on ids captured during page load,
    // which a rate-limited request can drop), then map their P31 to type buckets.
    const idByTitle = new Map();
    titles.forEach(t => { const m = journeyMeta.get(t); if (m && m.wikidataId) idByTitle.set(t, m.wikidataId); });
    const missing = titles.filter(t => !idByTitle.has(t));
    if (missing.length){
      try {
        const fetched = await fetchWikidataIds(missing);
        fetched.forEach((qid, t) => idByTitle.set(t, qid));
      } catch {}
    }
    const ids = [...new Set([...idByTitle.values()])];
    let p31 = new Map();
    try { p31 = await fetchInstanceTypes(ids); } catch {}
    types = new Map();
    titles.forEach(t => { const qid = idByTitle.get(t); types.set(t, bucketForQids(qid ? p31.get(qid) : [])); });
    overviewDataCache = { sig, pairs, degrees, types };
  }
  if (myToken !== overviewDataToken || !overviewActive || !overviewGroup) return; // stale / closed
  overviewRelations = degrees;
  overviewTypes = types;
  applyOverviewEncoding(degrees, types, pairs);
}

function buildOverviewInterlinks(pairs){
  const titleSet = new Set(overviewNodeSprites.keys());
  // Aggregate directed [from,to] pairs into one entry per unordered pair, keeping
  // which directions exist (a→b and/or b→a). a,b are lexicographic so the key is stable.
  // Route edges (consecutive stops) are drawn as the solid route line, so exclude
  // them here — chevrons only mark the OTHER links between your stops.
  const routeEdges = new Set();
  for (let i = 0; i + 1 < history.length; i++){
    const x = history[i], y = history[i + 1];
    if (x && y && x !== y) routeEdges.add(x < y ? x + '' + y : y + '' + x);
  }
  const links = new Map();
  for (const [from, to] of (pairs || [])){
    if (from === to || !titleSet.has(from) || !titleSet.has(to)) continue;
    const fwd = from < to;
    const a = fwd ? from : to, b = fwd ? to : from;
    const key = a + '' + b;
    if (routeEdges.has(key)) continue; // route edge — already drawn as the solid route line
    let e = links.get(key);
    if (!e){ e = { a, b, ab: false, ba: false }; links.set(key, e); }
    if (fwd) e.ab = true; else e.ba = true;
  }

  let count = 0, chevronBudget = 700;
  for (const e of links.values()){
    if (count >= 120) break;
    const pa = journeyPositions.get(e.a), pb = journeyPositions.get(e.b);
    if (!pa || !pb) continue;
    // The chevrons ARE the (dashed) line; this base line stays invisible but anchors
    // the no-bloom overlay pass (which is gated on overviewInterlinkLines.length).
    const geo = new LineGeometry();
    geo.setPositions([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z]);
    const mat = crossLinkMaterial.clone();
    mat.opacity = 0;
    mat.resolution.set(container.clientWidth, container.clientHeight);
    const line = new Line2(geo, mat);
    line.userData = { kind: 'overviewInterlink', _ovTarget: 0 };
    line.visible = false;
    line.raycast = () => {};
    line.layers.set(CROSSLINK_LAYER);
    overviewGroup.add(line);
    overviewInterlinkLines.push(line);
    count++;

    // Direction chevrons, dense enough to read as a dashed line. One-way: all point
    // at the target. Two-way: each half points away from its node toward the middle.
    const twoWay = e.ab && e.ba;
    const len = pa.distanceTo(pb);
    const n = Math.max(12, Math.min(48, Math.round(len)));
    if (chevronBudget <= 0) continue;
    const sprites = [];
    for (let i = 0; i < n && chevronBudget > 0; i++){
      const along = (i + 0.5) / n;            // 0 at a … 1 at b
      let pointSign, flow;                     // pointSign: +1 toward b, -1 toward a; flow: 0=source→1=target/middle
      if (twoWay){
        if (along < 0.5){ pointSign = 1;  flow = along * 2; }        // a half → middle
        else            { pointSign = -1; flow = (1 - along) * 2; }  // b half → middle
      } else if (e.ab){ pointSign = 1;  flow = along; }              // one-way a→b
      else            { pointSign = -1; flow = 1 - along; }          // one-way b→a
      const m = new THREE.SpriteMaterial({ map: chevronTexture, color: CHEVRON_COLOR.clone(),
        transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.NormalBlending });
      const s = new THREE.Sprite(m);
      s.position.copy(pa).lerp(pb, along);
      s.userData = { pointSign, flow, baseScale: 0.95 };
      s.scale.setScalar(0.95);
      s.layers.set(CROSSLINK_LAYER);
      overviewGroup.add(s);
      sprites.push(s);
      chevronBudget--;
    }
    overviewChevrons.push({ sprites, pa, pb, cyc: Math.max(1, Math.min(2, Math.round(n / 18))) });
  }
  overviewChevronsBuiltAt = performance.now();
}

function applyOverviewEncoding(degrees, types, pairs){
  if (!overviewGroup) return;
  buildOverviewInterlinks(pairs);

  let maxDeg = 0;
  degrees.forEach(d => { if (d > maxDeg) maxDeg = d; });
  let hubTitle = null, hubDeg = -1;

  const nodeSpecs = [];
  overviewNodeSprites.forEach((sprite, title) => {
    const deg = degrees.get(title) || 0;
    if (deg > hubDeg){ hubDeg = deg; hubTitle = title; }
    const isCur = sprite.userData.isCur;
    // size by relation: 0 connections -> 1.0, the most-connected -> 3.0
    const toScale = isCur ? 2.4 : (1.0 + (maxDeg > 0 ? deg / maxDeg : 0) * 2.0);
    sprite.userData.baseScale = toScale;
    const bucket = types.get(title) || 'concept';
    const toColor = new THREE.Color(isCur ? 0xffffff : TYPE_BUCKETS[bucket].hue);
    nodeSpecs.push({ sprite, fromScale: sprite.scale.x, toScale, fromColor: sprite.material.color.clone(), toColor });
  });

  // Tint each label's pill border by type (current node keeps its gradient pill).
  overviewLabelEls.forEach(({ el }) => {
    const title = el.dataset.title;
    if (!title || title === currentTitle) return;
    const bucket = types.get(title) || 'concept';
    el.style.borderColor = '#' + new THREE.Color(TYPE_BUCKETS[bucket].hue).getHexString();
  });

  // A soft corona behind the hub (the most-connected node) so it reads as the centre of gravity.
  let corona = null;
  if (hubTitle && hubDeg > 0){
    const hubSprite = overviewNodeSprites.get(hubTitle);
    if (hubSprite){
      const c = new THREE.Sprite(new THREE.SpriteMaterial({
        map: starTexture, color: 0xffeccf, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
      }));
      c.position.copy(hubSprite.position);
      c.scale.setScalar(hubSprite.userData.baseScale * 2.6);
      c.raycast = () => {};
      c.userData = { kind: 'overviewCorona' };
      overviewGroup.add(c);
      corona = { sprite: c, toOpacity: 0.3 };
    }
  }

  tweenOverviewEncode(nodeSpecs, corona, overviewInterlinkLines.slice());
  renderMapLegend(types);
}

function tweenOverviewEncode(nodeSpecs, corona, interlinks){
  cancelAnimationFrame(overviewEncodeRAF);
  const dur = REDUCED ? 0 : 480;
  const t0 = performance.now();
  const tmp = new THREE.Color();
  function step(now){
    const t = dur <= 0 ? 1 : Math.min(1, (now - t0) / dur);
    const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
    for (const s of nodeSpecs){
      const sc = s.fromScale + (s.toScale - s.fromScale) * e;
      s.sprite.scale.set(sc, sc, 1);
      tmp.copy(s.fromColor).lerp(s.toColor, e);
      s.sprite.material.color.copy(tmp);
    }
    if (corona) corona.sprite.material.opacity = corona.toOpacity * e;
    for (const l of interlinks){ if (l.material) l.material.opacity = (l.userData._ovTarget || 0.42) * e; }
    renderOnce();
    if (t < 1) overviewEncodeRAF = requestAnimationFrame(step);
  }
  overviewEncodeRAF = requestAnimationFrame(step);
}

// ===== Map legend =====
function renderMapLegend(types){
  const box = document.getElementById('mapLegend');
  if (!box) return;
  const present = new Set();
  types.forEach(b => present.add(b));
  const order = ['person','place','org','event','work','species','concept'];
  const swatches = order.filter(b => present.has(b)).map(b =>
    `<span class="legend-type"><i style="background:#${new THREE.Color(TYPE_BUCKETS[b].hue).getHexString()}"></i>${TYPE_BUCKETS[b].label}</span>`
  ).join('');
  box.innerHTML =
    `<div class="legend-row legend-size"><span class="legend-dot dot-sm"></span><span class="legend-dot dot-lg"></span> Bigger star = links to more of your stops</div>` +
    (swatches ? `<div class="legend-row legend-types">${swatches}</div>` : '') +
    `<div class="legend-row legend-lines"><span class="legend-line route"></span> Your route &nbsp; <span class="legend-line inter"></span> Links between articles</div>`;
  box.classList.remove('hidden');
  requestAnimationFrame(() => { box.style.opacity = '1'; });
}
function hideMapLegend(){
  const box = document.getElementById('mapLegend');
  if (!box) return;
  box.style.opacity = '0';
  box.classList.add('hidden');
  box.innerHTML = '';
}

// ===== Map node popup (click a node to inspect, then travel) =====
function closeMapNodePopup(){
  const p = document.getElementById('mapNodePopup');
  if (p){ p.classList.add('hidden'); p.innerHTML = ''; p.removeAttribute('data-title'); }
}
// Fly from the galaxy map to a node (used by the panel's "Travel here" action).
function travelToMapNode(title){
  const idx = history.lastIndexOf(title);
  transitionOutOfOverview(() => { if (idx >= 0 && idx !== historyIndex) jumpToBreadcrumb(idx); });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function resetOverviewEnrichment(){
  overviewDataToken++;            // invalidate any in-flight data load
  cancelAnimationFrame(overviewEncodeRAF);
  overviewNodeSprites = new Map();
  overviewInterlinkLines = [];
  overviewChevrons = [];
  overviewRelations = new Map();
  overviewTypes = new Map();
  closeMapNodePopup();
  hideMapLegend();
  renderTypeLegend(); // restore the cluster legend when leaving the map
}

// Camera framing that fits every journey node in view.
function overviewCameraFit(){
  const box = new THREE.Box3();
  journeyPositions.forEach(p => box.expandByPoint(p));
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 25);
  const fov = camera.fov * Math.PI / 180;
  let dist = (r / Math.sin(fov / 2)) * 1.1;
  // On mobile the toolbar/breadcrumbs (top) and the peek sheet + footer (bottom) cover
  // part of the canvas — pull back so the constellation fits the visible band, not the
  // whole screen (the view offset then centres it within that band).
  if (window.innerWidth <= 720){
    const h = container.clientHeight || window.innerHeight;
    const bc = document.getElementById('breadcrumbs');
    const topInset = bc ? bc.getBoundingClientRect().bottom : 0;
    const bottomInset = 88 + 26; // peek sheet + footer (sync with --sheet-collapsed-h/--footer-h)
    const band = Math.max(140, h - topInset - bottomInset);
    dist *= h / band;
  }
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1);
  dir.normalize();
  return { target: center, pos: center.clone().add(dir.multiplyScalar(dist)) };
}

// Standard close-up view centered on the current page's star.
function currentNodeCameraView(){
  const curPos = (centerPositions.get(currentTitle) || (starGroup && starGroup.position) || new THREE.Vector3()).clone();
  return { target: curPos, pos: curPos.clone().add(DEFAULT_CAM_POS) };
}

// Every fadeable cluster object (stars, rays, cross-links, ghosts) + the trail.
function clusterFadeables(){
  const list = [];
  clusterGroups.forEach(g => {
    g.star.traverse(o => { if (o.material && 'opacity' in o.material) list.push(o); });
    g.edge.traverse(o => { if (o.material && 'opacity' in o.material) list.push(o); });
  });
  if (trailLine.visible) list.push(trailLine);
  return list;
}

// Instant teardown — used when another action (search/travel/load) takes over so
// no half-finished transition is left behind.
function teardownOverview(){
  if (!overviewActive && !overviewGroup) return;
  overviewFadeId++;            // cancel any running transition
  overviewTransitioning = false;
  overviewActive = false;
  document.getElementById('mapBtn')?.classList.remove('active');
  const box = document.getElementById('overviewLabels');
  if (box){ box.innerHTML = ''; box.classList.add('hidden'); box.style.opacity = ''; }
  overviewLabelEls = [];
  if (overviewGroup){ disposeGroup(overviewGroup); scene.remove(overviewGroup); overviewGroup = null; }
  resetOverviewEnrichment();
  clusterGroups.forEach(g => {
    [g.star, g.edge].forEach(grp => grp.traverse(o => {
      if (o.userData && o.userData._ovBase != null){ o.material.opacity = o.userData._ovBase; delete o.userData._ovBase; }
    }));
  });
  if (overviewHidden.length) overviewHidden.forEach(({ obj, vis }) => { obj.visible = vis; });
  else clusterGroups.forEach(g => { g.star.visible = true; g.edge.visible = true; });
  overviewHidden = [];
  updateTrail();
}

// Zoom out to the whole galaxy while the spokes fade away.
function transitionIntoOverview(){
  if (journeyPositions.size < 2){
    showToast('Travel between a few pages first to chart your galaxy.');
    return;
  }
  if (overviewTransitioning || overviewActive || isAnimating) return;
  overviewActive = true;
  overviewTransitioning = true;
  notifyNavigate(); // collapse the mobile sheet so the map isn't hidden behind it
  closePreview();
  hideTypeLegend(); // the map's own legend takes over while in overview
  document.getElementById('mapBtn')?.classList.add('active');
  hovered = null;
  tooltip.classList.remove('show');

  // Build the constellation, starting fully transparent so it can fade in.
  buildOverview();
  const ovObjs = [];
  overviewGroup.traverse(o => {
    if (o.material && 'opacity' in o.material){ ovObjs.push(o); o.userData._ovTarget = o.material.opacity; o.material.opacity = 0; o.material.transparent = true; }
  });
  buildOverviewLabels();
  const labelBox = document.getElementById('overviewLabels');
  if (labelBox){ labelBox.style.opacity = '0'; requestAnimationFrame(() => { labelBox.style.opacity = '1'; }); }
  // Fetch relations + types in the background; they "focus in" (resize/recolour +
  // interlinks fade) once they land, roughly as the zoom-out settles.
  loadOverviewData();

  // Remember which clusters were visible so they return to their trail state.
  overviewHidden = [];
  clusterGroups.forEach(g => { overviewHidden.push({ obj: g.star, vis: g.star.visible }, { obj: g.edge, vis: g.edge.visible }); });
  const live = clusterFadeables();
  live.forEach(o => { o.userData._ovBase = o.material.opacity; o.material.transparent = true; });

  const fit = overviewCameraFit();
  const sT = controls.target.clone();
  const sC = camera.position.clone();
  const dur = REDUCED ? 0 : 1000;
  const myId = ++overviewFadeId;

  const finish = () => {
    live.forEach(o => { if (o.userData._ovBase != null){ o.material.opacity = o.userData._ovBase; delete o.userData._ovBase; } });
    clusterGroups.forEach(g => { g.star.visible = false; g.edge.visible = false; });
    trailLine.visible = false;
    ovObjs.forEach(o => { if (o.userData._ovTarget != null){ o.material.opacity = o.userData._ovTarget; delete o.userData._ovTarget; } });
    overviewTransitioning = false;
    renderOnce();
  };

  if (dur <= 0){ controls.target.copy(fit.target); camera.position.copy(fit.pos); controls.update(); finish(); return; }

  const t0 = performance.now();
  (function step(now){
    if (myId !== overviewFadeId) return; // superseded / torn down
    const t = Math.min(1, (now - t0) / dur);
    const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; // easeInOut quad
    controls.target.copy(sT.clone().lerp(fit.target, e));
    camera.position.copy(sC.clone().lerp(fit.pos, e));
    controls.update();
    live.forEach(o => { o.material.opacity = o.userData._ovBase * (1 - e); });
    ovObjs.forEach(o => { o.material.opacity = o.userData._ovTarget * e; });
    renderOnce();
    if (t < 1) requestAnimationFrame(step); else finish();
  })(performance.now());
}

// Zoom back in to the current node, fading the spokes back in. onDone fires once
// settled on the current node (used to then travel to a clicked node).
function transitionOutOfOverview(onDone){
  if (!overviewActive){ if (onDone) onDone(); return; }
  if (overviewTransitioning) return;
  overviewTransitioning = true;
  document.getElementById('mapBtn')?.classList.remove('active');

  // Bring clusters back to their proper visibility, then fade them in from 0.
  if (overviewHidden.length) overviewHidden.forEach(({ obj, vis }) => { obj.visible = vis; });
  else clusterGroups.forEach(g => { g.star.visible = true; g.edge.visible = true; });
  if (trailMode) trailLine.visible = true;
  const live = clusterFadeables();
  live.forEach(o => { o.userData._ovBase = (o.userData._ovBase != null ? o.userData._ovBase : o.material.opacity); o.material.opacity = 0; o.material.transparent = true; });

  const ovObjs = [];
  if (overviewGroup) overviewGroup.traverse(o => { if (o.material && 'opacity' in o.material){ ovObjs.push(o); o.userData._ovTarget = o.material.opacity; } });

  const labelBox = document.getElementById('overviewLabels');
  if (labelBox) labelBox.style.opacity = '0';

  const view = currentNodeCameraView();
  const sT = controls.target.clone();
  const sC = camera.position.clone();
  const dur = REDUCED ? 0 : 700;
  const myId = ++overviewFadeId;

  const finish = () => {
    live.forEach(o => { if (o.userData._ovBase != null){ o.material.opacity = o.userData._ovBase; delete o.userData._ovBase; } });
    if (overviewGroup){ disposeGroup(overviewGroup); scene.remove(overviewGroup); overviewGroup = null; }
    if (labelBox){ labelBox.innerHTML = ''; labelBox.classList.add('hidden'); labelBox.style.opacity = ''; }
    overviewLabelEls = [];
    overviewHidden = [];
    overviewActive = false;
    overviewTransitioning = false;
    resetOverviewEnrichment();
    updateTrail();
    renderOnce();
    if (onDone) onDone();
  };

  if (dur <= 0){ controls.target.copy(view.target); camera.position.copy(view.pos); controls.update(); finish(); return; }

  const t0 = performance.now();
  (function step(now){
    if (myId !== overviewFadeId) return;
    const t = Math.min(1, (now - t0) / dur);
    const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
    controls.target.copy(sT.clone().lerp(view.target, e));
    camera.position.copy(sC.clone().lerp(view.pos, e));
    controls.update();
    live.forEach(o => { o.material.opacity = o.userData._ovBase * e; });
    ovObjs.forEach(o => { o.material.opacity = o.userData._ovTarget * (1 - e); });
    renderOnce();
    if (t < 1) requestAnimationFrame(step); else finish();
  })(performance.now());
}

function toggleOverview(force){
  const want = (typeof force === 'boolean') ? force : !overviewActive;
  if (overviewTransitioning) return;
  if (want === overviewActive) return;
  if (want){ if (!isAnimating) transitionIntoOverview(); }
  else { exitPanelPreview(); transitionOutOfOverview(); } // restore the current page's panel on leaving the map
}

function onOverviewLabelClick(title){
  if (overviewTransitioning) return;
  // Selecting a node shows its full info + actions in the panel (no separate popup,
  // which would overlap the bottom sheet on mobile). The label highlights as selected.
  if (title === currentTitle) exitPanelPreview(); // back on the current node → restore its panel
  else previewNodeInPanel(title);
}

function isOverviewActive(){ return overviewActive; }

// ====== Travel ======
let isAnimating = false;
let journeyBuilding = false; // true while loadPath builds a multi-stop trail
async function travelToNeighbor(targetTitle, addToHistory=true){
  if (isAnimating || overviewTransitioning || journeyBuilding || !currentTitle) return;
  peekedObject = null;
  clearPanelPreview();
  notifyNavigate();
  if (overviewActive) teardownOverview(); // any navigation leaves the overview

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

  setLoading(true);
  let star;
  try {
    star = await getPageStar(targetTitle, showBacklinks);
  } catch (e) {
    setLoading(false);
    showToast('Failed to load page.');
    isAnimating = false;
    return;
  }
  setLoading(false);

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
      recordJourneyPos(currentTitle, to);
      journeyMeta.set(currentTitle, { wikidataId: star.center.wikidataId, length: star.center.length, categories: star.center.categories });
      updateTrail();
      trailLine.visible = trailMode;
      visited.add(currentTitle);
      updateBreadcrumbs();
      hovered = null;
      tooltip.classList.remove('show');
      isAnimating = false;
      ensureCrossLinks(currentTitle);
      applyNeighborTypes(currentTitle);
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
// Panel-preview: when set, the info panel shows a previewed (non-current) map node
// without changing the journey. savedSidebar/lastSidebar let us restore the real page.
let panelPreviewTitle = null;
let savedSidebar = null;
let lastSidebar = null;

function updateSidebar(center, neighbors, chainPrev, metaByTitle = {}, previewOf = null){
  const token = ++sidebarToken;
  const info = document.getElementById('info');
  if (info){ info.classList.remove('empty'); info.classList.toggle('previewing', !!previewOf); info.scrollTop = 0; }
  const heading = document.getElementById('currentWord');
  heading.textContent = center.title;

  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerHTML = '';
  if (previewOf){
    const previewedTitle = center.title;
    const banner = document.createElement('div');
    banner.className = 'preview-banner';
    banner.appendChild(Object.assign(document.createElement('span'), { className: 'pb-caption', textContent: 'Previewing — not your current stop' }));
    const travel = document.createElement('button');
    travel.className = 'pa-travel';
    travel.innerHTML = 'Travel here <svg class="icon"><use href="#ic-star"/></svg>';
    travel.addEventListener('click', ()=> travelToMapNode(previewedTitle));
    banner.appendChild(travel);
    const row = document.createElement('div');
    row.className = 'preview-actions-row';
    const mk = (label, title, fn)=>{ const b = document.createElement('button'); b.className = 'pa-btn'; b.textContent = label; if (title) b.title = title; b.addEventListener('click', fn); return b; };
    row.appendChild(mk('Path from', 'Find a path from here', ()=> setPath('from', previewedTitle)));
    row.appendChild(mk('Path to', 'Find a path to here', ()=> setPath('to', previewedTitle)));
    row.appendChild(mk('← Back', 'Back to ' + previewOf, exitPanelPreview));
    banner.appendChild(row);
    summaryDiv.appendChild(banner);
  }
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

  renderNeighborList(true);
  if (!previewOf) lastSidebar = { center, neighbors: currentNeighbors.slice(), chainPrev: currentChainPrev, meta: currentMeta };
}

// Show a non-current map node's full info in the panel without leaving the journey.
async function previewNodeInPanel(title){
  if (!title || title === currentTitle) return;
  if (!panelPreviewTitle) savedSidebar = lastSidebar; // snapshot the real current page once
  panelPreviewTitle = title;
  if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) window.dispatchEvent(new Event('starwiki:expandsheet'));
  setLoading(true);
  let star;
  try { star = await getPageStar(title, showBacklinks); }
  catch { setLoading(false); return; }
  setLoading(false);
  if (panelPreviewTitle !== title) return; // superseded by another selection
  updateSidebar(star.center, star.neighbors.slice(0, 20), null, star.metaByTitle, currentTitle);
}

// Leave preview WITHOUT restoring — used when navigating away (a new page will render).
function clearPanelPreview(){
  panelPreviewTitle = null;
  savedSidebar = null;
  document.getElementById('info')?.classList.remove('previewing');
}
// Leave preview and restore the real current page's panel — used on void-tap / closing the map.
function exitPanelPreview(){
  if (!panelPreviewTitle) return;
  const saved = savedSidebar;
  panelPreviewTitle = null;
  savedSidebar = null;
  if (saved) updateSidebar(saved.center, saved.neighbors, saved.chainPrev, saved.meta);
  else document.getElementById('info')?.classList.remove('previewing');
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

function renderNeighborList(animateIn = false){
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

  list.forEach((nb, i) => {
    const row = document.createElement('div');
    row.className = 'neighbor';
    if (animateIn) {
      row.classList.add('enter');
      row.style.animationDelay = (i * 28) + 'ms';
    }
    if (visited.has(nb)) row.classList.add('visited');
    if (panelPreviewTitle) {
      // Preview mode: neighbours are informational only (this isn't your current page).
      row.classList.add('noclick');
    } else {
      row.tabIndex = 0;
      row.addEventListener('click', e=> openPreview(nb, e.clientX, e.clientY));
      row.addEventListener('keydown', e=>{ if(e.key==='Enter') openPreview(nb); });
    }

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
  if (x == null || y == null || window.innerWidth <= 720) {
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
  previewThumb.removeAttribute('src');
  previewThumb.style.display = 'none';
  previewLink.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  previewOverlay.classList.remove('hidden');
  positionPreview(x, y);
  previewBody.focus();
  document.addEventListener('keydown', previewKeyHandler);
  const data = await fetchSummary(title);
  if (previewTarget !== title) return;
  previewTitle.textContent = data.title || title;
  if (data.thumbnail) {
    previewThumb.src = data.thumbnail;
    previewThumb.style.display = '';
  } else {
    previewThumb.removeAttribute('src');
    previewThumb.style.display = 'none';
  }
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
document.getElementById('previewClose')?.addEventListener('click', e=>{ e.stopPropagation(); closePreview(); });

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
    // Re-apply the Wikidata-type colour (unvisited only; visited stays grey).
    const hue = obj.userData.typeHue;
    if (hue != null && !visited.has(obj.userData.title)) obj.material.color.setHex(hue);
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
  // While orbiting on touch, don't flash tooltips for spokes passing under the finger.
  if (isTouchDragging()){ if (hovered) resetHovered(); hovered = null; tooltip.classList.remove('show'); return; }
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
        // Hover = a brightened version of the star's type colour.
        const hue = obj.userData.typeHue;
        if (hue != null && !visited.has(obj.userData.title)) obj.material.color.copy(new THREE.Color(hue).lerp(new THREE.Color(0xffffff), 0.45));
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

// Tear down every cluster, the trail, and the cross-links, leaving an empty scene.
// Used both when starting a fresh page (so the screen blanks during the load
// instead of leaving the old graph and its dangling return ray hanging) and when
// resetting all the way back to the welcome screen.
function clearAllScene(){
  clearCrossLinks();
  clusterGroups.forEach(g=>{
    if (g.star !== starGroup) disposeGroup(g.star);
    if (g.edge !== edgeGroup) disposeGroup(g.edge);
    scene.remove(g.star); scene.remove(g.edge);
  });
  clearGroup(starGroup);
  clearGroup(edgeGroup);
  scene.add(starGroup); scene.add(edgeGroup);
  starGroup.position.set(0, 0, 0);
  edgeGroup.position.set(0, 0, 0);
  wordToMesh.clear();
  clusterGroups.clear();
  centerPositions.clear();
  journeyPositions.clear();
  journeyMeta.clear();
  ghostQueue.length = 0;
  trailLine.visible = false;
  hovered = null;
  tooltip.classList.remove('show');
  hideTypeLegend();
}

function onGo(val){
  const value = val.trim();
  if (!value) return;
  peekedObject = null;
  clearPanelPreview();
  notifyNavigate();
  teardownOverview();
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
  // Blank the screen right away so nothing from the previous page lingers during
  // the fetch (the new cluster is built into the now-empty groups by rebuildStar).
  clearAllScene();
  renderOnce();
  rebuildStar(value);
}

// Full reset back to the first-run welcome / blank state (not just the camera).
function resetToWelcome(){
  clearPanelPreview();
  teardownOverview();
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  clearAllScene();
  currentTitle = null;
  history = [];
  historyIndex = -1;
  visited.clear();
  showBacklinks = false;
  const backToggle = document.getElementById('backToggle');
  if (backToggle) backToggle.checked = false;
  controls.target.set(0, 0, 0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  updateBreadcrumbs();
  // Restore the welcome panel and clear the page content.
  const info = document.getElementById('info');
  if (info) info.classList.add('empty');
  const heading = document.getElementById('currentWord');
  if (heading) heading.textContent = 'Select a page';
  const summary = document.getElementById('summary');
  if (summary) summary.innerHTML = '';
  const nbControls = document.getElementById('neighborControls');
  if (nbControls) nbControls.innerHTML = '';
  const neighbors = document.getElementById('neighbors');
  if (neighbors) neighbors.innerHTML = '';
  setLoading(false);
  // Drop the shareable hash so a reload also starts blank.
  if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
  renderOnce();
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

function setStarSizeMode(val){
  starSizeMode = val;
  applyStarSizes();
}

function setShowCrossLinks(val){
  showCrossLinks = val;
  if (!isAnimating && !overviewActive) ensureCrossLinks(currentTitle);
}

function getHistory(){ return history.slice(); }

// Restore a multi-step journey (shared hash / saved bookmark / found path). Lands
// on the destination immediately, then builds the rest of the trail behind it in
// the background — as if it had been travelled organically, minus the fly-throughs.
function loadPath(path){
  if (!Array.isArray(path) || !path.length) return;
  if (isAnimating || journeyBuilding) return;
  clearPanelPreview();
  teardownOverview();
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  showBacklinks = false;
  const backToggle = document.getElementById('backToggle');
  if (backToggle) backToggle.checked = false;
  visited.clear();
  hovered = null;
  tooltip.classList.remove('show');
  clearCrossLinks();
  clusterGroups.forEach(g=>{ disposeGroup(g.star); disposeGroup(g.edge); scene.remove(g.star); scene.remove(g.edge); });
  clusterGroups.clear();
  centerPositions.clear();
  journeyPositions.clear();
  journeyMeta.clear();
  ghostQueue.length = 0;
  trailLine.visible = false;
  // Fresh empty active groups so hover/animate stay valid until the build lands.
  starGroup = new THREE.Group(); edgeGroup = new THREE.Group();
  scene.add(starGroup); scene.add(edgeGroup);
  wordToMesh = new Map();
  history = path.slice();
  historyIndex = history.length - 1;
  controls.target.set(0, 0, 0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  buildJourneyClusters(path.slice());
}

async function buildJourneyClusters(titles){
  const n = titles.length;
  journeyBuilding = true;
  setLoading(true);
  // Forward chain of positions from the origin (same rule as live travel).
  const pos = [new THREE.Vector3(0, 0, 0)];
  for (let i = 1; i < n; i++){
    const d = directionFromTitle(titles[i]);
    pos[i] = pos[i-1].clone().add(new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(SEGMENT_DIST));
  }
  const metaOf = s => ({ wikidataId: s.center.wikidataId, length: s.center.length, categories: s.center.categories });
  const li = n - 1;

  // 1) Destination first, so the user lands there right away.
  let dest;
  try { dest = await getPageStar(titles[li], false); }
  catch { journeyBuilding = false; setLoading(false); showToast('Failed to load path.'); return; }
  const dCanon = dest.center.title;
  const dPrev = n > 1 ? titles[li-1] : null;
  const dPrevVec = n > 1 ? pos[li-1].clone().sub(pos[li]) : null;
  const dS = new THREE.Group(), dE = new THREE.Group(), dM = new Map();
  buildStarInto(dCanon, dest, dS, dE, dM, dPrev, dPrevVec, false, true);
  dS.position.copy(pos[li]); dE.position.copy(pos[li]);
  scene.add(dS); scene.add(dE);
  starGroup = dS; edgeGroup = dE; wordToMesh = dM;
  clusterGroups.set(dCanon, { star: dS, edge: dE });
  centerPositions.set(dCanon, pos[li].clone());
  recordJourneyPos(dCanon, pos[li]);
  journeyMeta.set(dCanon, metaOf(dest));
  visited.add(dCanon);
  currentTitle = dCanon;
  history[li] = dCanon;
  controls.target.copy(pos[li]);
  camera.position.copy(pos[li].clone().add(DEFAULT_CAM_POS));
  controls.update();
  fadeInGroups();
  updateBreadcrumbs();
  applyNeighborTypes(dCanon);
  renderOnce();

  // 2) Build the rest of the trail behind, nearest-first so the line stays contiguous.
  for (let i = li - 1; i >= 0; i--){
    let s;
    try { s = await getPageStar(titles[i], false); } catch { continue; }
    const c = s.center.title;
    const pv = i > 0 ? pos[i-1].clone().sub(pos[i]) : null;
    const pt = i > 0 ? titles[i-1] : null;
    const gS = new THREE.Group(), gE = new THREE.Group(), gm = new Map();
    buildStarInto(c, s, gS, gE, gm, pt, pv, true, false); // instant, no sidebar
    gS.position.copy(pos[i]); gE.position.copy(pos[i]);
    scene.add(gS); scene.add(gE);
    clusterGroups.set(c, { star: gS, edge: gE });
    centerPositions.set(c, pos[i].clone());
    recordJourneyPos(c, pos[i]);
    journeyMeta.set(c, metaOf(s));
    visited.add(c);
    history[i] = c;
    ghostify(c);
    gS.visible = trailMode; gE.visible = trailMode;
    ghostQueue.unshift(c); // keep the queue chronological (oldest first)
    updateTrail();
    trailLine.visible = trailMode;
    renderOnce();
  }

  // Keep only the most recent ghosts (drop the oldest, farthest from the destination).
  while (ghostQueue.length > MAX_GHOSTS){
    const old = ghostQueue.shift();
    const g = clusterGroups.get(old);
    if (g){ disposeGroup(g.star); disposeGroup(g.edge); scene.remove(g.star); scene.remove(g.edge); clusterGroups.delete(old); centerPositions.delete(old); }
  }

  journeyBuilding = false;
  setLoading(false);
  updateBreadcrumbs();
  updateTrail();
  trailLine.visible = trailMode && centerPositions.size > 1;
  ensureCrossLinks(currentTitle);
  applyNeighborTypes(currentTitle);
  renderOnce();
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
    // Only animate objects whose base opacity we captured at the start. Cross-links
    // are fetched asynchronously and can be added mid-fade; they must keep their own
    // drawn opacity (0.46) rather than being forced to full opacity by a fallback.
    starGroup.traverse(obj => {
      if(obj.material && 'opacity' in obj.material && obj.userData && obj.userData.baseOpacity != null){
        obj.material.opacity = obj.userData.baseOpacity * t;
      }
    });
    edgeGroup.traverse(obj => {
      if(obj.material && 'opacity' in obj.material && obj.userData && obj.userData.baseOpacity != null){
        obj.material.opacity = obj.userData.baseOpacity * t;
      }
    });
    renderOnce();
    if(t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function animate(){
  requestAnimationFrame(animate);
  // Drift the camera slowly when idle (not mid-travel, no preview/overview/ring open, motion allowed).
  if (!REDUCED && !isAnimating && !previewTarget && !overviewActive && !ringOpen && (performance.now() - lastInteraction > IDLE_MS)){
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(IDLE_AXIS, 0.0006);
    camera.position.copy(controls.target).add(off);
  }
  controls.update();
  // Keep the nebula skybox centered on the camera so it never magnifies into a grid
  // / hard edge when you've travelled far from the origin.
  if (nebulaMesh) nebulaMesh.position.copy(camera.position);
  applyViewOffset();
  if (overviewActive){ updateOverviewLabels(); updateOverviewChevrons(performance.now()); }
  else updateHover();

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
      } else if (obj.userData && obj.userData.kind === 'ray' && obj.userData.baseColorHex === RETURN_COLOR && obj.userData.normalMat && !overviewActive && !overviewTransitioning) {
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
    renderScene();
    lastRenderTime = tMs;
  }
}
let lastRenderTime = 0;
const IDLE_FRAME_MS = 1000 / 30;
function renderOnce(){ renderScene(); lastRenderTime = performance.now(); }

function showToast(msg){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2500);
}

function setLoading(on){
  const p = document.getElementById('progress');
  if (p) p.classList.toggle('active', on);
}

function init(){
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
  // Nebula: a true camera-locked skybox (its position tracks the camera each frame
  // in animate). Centered on the origin it would, once you've travelled far enough
  // off-centre, bring its near surface close enough to magnify the texture into a
  // grid with a hard silhouette edge — keeping the camera at its centre avoids that.
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(1600, 48, 32),
    new THREE.MeshBasicMaterial({ map: createNebulaTexture(), side: THREE.BackSide, depthWrite: false, depthTest: false })
  );
  nebula.renderOrder = -1;
  nebula.userData.rotSpeed = 0.00004;
  nebulaMesh = nebula;
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
  setStarSizeMode,
  setShowCrossLinks,
  toggleOverview,
  isOverviewActive,
  centerCameraOnCurrent,
  resetToWelcome,
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
