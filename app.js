// app.js
// Orchestrates StarWiki modules and exposes public API.
import { state } from './src/core/state.js';
import { renderer, scene, camera, controls, starGroup, bgStars, renderOnce, DEFAULT_CAM_POS } from './src/core/scene.js';
import { updateHover } from './src/input/picking.js';
import { rebuildStar, refreshCurrentNeighbors } from './src/graph/build.js';
import { travelToNeighbor } from './src/graph/travel.js';
import { updateTrail } from './src/graph/trail.js';
import { updateBreadcrumbs, jumpToBreadcrumb } from './src/ui/breadcrumbs.js';
import { openPreview, closePreview, confirmPreview } from './src/ui/preview.js';

function getChainPrev(){
  return state.historyIndex > 0 ? state.history[state.historyIndex - 1] : null;
}

export function queueNav(action){ state.pendingNav = action; }
function flushQueuedActions(){
  if (state.pendingNav) {
    const act = state.pendingNav; state.pendingNav = null;
    if (act === 'left') goBackOne();
    else if (act === 'right') goForwardOne();
    else if (act && act.type === 'breadcrumb') jumpToBreadcrumb(act.index);
  }
}

export function goBackOne(){
  const prev = getChainPrev();
  if (prev && state.historyIndex > 0 && !state.isAnimating) {
    state.historyIndex--;
    travelToNeighbor(prev, false);
    return true;
  }
  return false;
}

export function goForwardOne(){
  if (state.historyIndex < state.history.length - 1 && !state.isAnimating) {
    const next = state.history[state.historyIndex + 1];
    state.historyIndex++;
    travelToNeighbor(next, false);
    return true;
  }
  return false;
}

export function onGo(val){
  const value = val.trim();
  if (!value) return;
  closePreview();
  const help = document.getElementById('helpModal');
  if (help) help.classList.add('hidden');
  state.showBacklinks = false;
  try { localStorage.clear(); } catch {}
  state.visited.clear();
  state.history = [];
  state.historyIndex = -1;
  updateBreadcrumbs();
  controls.target.set(0,0,0);
  camera.position.copy(DEFAULT_CAM_POS);
  controls.update();
  state.hovered = null;
  state.clusterGroups.forEach(g=>{ scene.remove(g.star); scene.remove(g.edge); });
  rebuildStar(value);
}

export function setShowBacklinks(val){
  state.showBacklinks = val;
  if (state.currentTitle) refreshCurrentNeighbors();
}

export function setTrailMode(val){
  state.trailMode = val;
  if (!val) {
    state.clusterGroups.forEach((g,t)=>{ if (t !== state.currentTitle) { scene.remove(g.star); scene.remove(g.edge); state.clusterGroups.delete(t); state.centerPositions.delete(t); } });
    state.ghostQueue.length = 0;
    updateTrail();
  }
}

export function centerCameraOnCurrent(){
  const pos = (state.centerPositions.get(state.currentTitle) || starGroup.position || new THREE.Vector3()).clone();
  controls.target.copy(pos);
  camera.position.copy(pos.clone().add(DEFAULT_CAM_POS.clone()));
  controls.update();
  renderOnce();
}

export function isAnimating(){ return state.isAnimating; }

function animate(){
  requestAnimationFrame(animate);
  controls.update();
  updateHover();
  bgStars.rotation.y += 0.0003;
  renderer.render(scene, camera);
}

export function init(){
  document.getElementById('loading').classList.add('hidden');
  updateBreadcrumbs();
  animate();
}

init();

export { openPreview, closePreview, confirmPreview, jumpToBreadcrumb };
