// travel.js
// Handles animations and movement when traveling to a new neighbor.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { getPageStar } from '../data/wikipedia.js';
import { state } from '../core/state.js';
import { scene, starGroup, edgeGroup, camera, controls, tooltip, renderer } from '../core/scene.js';
import { directionFromTitle } from '../core/math.js';
import { SEGMENT_DIST, MAX_GHOSTS } from '../core/constants.js';
import { buildStarInto } from './build.js';
import { ghostify, updateTrail } from './trail.js';
import { showToast } from '../ui/toast.js';
import { updateBreadcrumbs } from '../ui/breadcrumbs.js';

function getChainPrev(){
  return state.historyIndex > 0 ? state.history[state.historyIndex - 1] : null;
}

export async function travelToNeighbor(targetTitle, addToHistory=true){
  if (state.isAnimating || !state.currentTitle) return;
  const from = state.centerPositions.get(state.currentTitle) || new THREE.Vector3(0,0,0);
  const hasAbsoluteTarget = state.centerPositions.has(targetTitle);
  let provisionalDir = null;
  if (state.wordToMesh.has(targetTitle)) {
    provisionalDir = state.wordToMesh.get(targetTitle).position.clone().normalize();
  } else if (hasAbsoluteTarget) {
    provisionalDir = state.centerPositions.get(targetTitle).clone().sub(from).normalize();
  } else {
    const prev = getChainPrev();
    if (prev && targetTitle === prev && state.centerPositions.has(prev)) {
      provisionalDir = state.centerPositions.get(prev).clone().sub(from).normalize();
    }
  }
  if (!provisionalDir) {
    const dirArr = directionFromTitle(targetTitle);
    provisionalDir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]).normalize();
  }

  state.isAnimating = true;
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${targetTitle}…`;
  overlay.classList.remove('hidden');
  let star;
  try {
    star = await getPageStar(targetTitle, state.showBacklinks);
  } catch (e) {
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    state.isAnimating = false;
    return;
  }
  overlay.classList.add('hidden');

  const canonical = star.center.title;
  const fromAbs = from.clone();
  let to;
  if (state.trailMode && state.centerPositions.has(canonical)) {
    to = state.centerPositions.get(canonical).clone();
    const old = state.clusterGroups.get(canonical);
    if (old) { scene.remove(old.star); scene.remove(old.edge); state.clusterGroups.delete(canonical); }
    const idx = state.ghostQueue.indexOf(canonical); if (idx !== -1) state.ghostQueue.splice(idx,1);
  } else {
    to = fromAbs.clone().add(provisionalDir.clone().multiplyScalar(SEGMENT_DIST));
  }

  if (addToHistory) {
    if (state.historyIndex < state.history.length - 1) state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(canonical);
    state.historyIndex = state.history.length - 1;
  } else {
    state.history[state.historyIndex] = canonical;
  }

  const newStar = new THREE.Group();
  const newEdge = new THREE.Group();
  const newMap = new Map();
  buildStarInto(canonical, star, newStar, newEdge, newMap, state.currentTitle, fromAbs.clone().sub(to));
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
    renderer.render(scene, camera);
    if (t < 1) requestAnimationFrame(tick);
    else {
      if (state.trailMode) {
        ghostify(state.currentTitle);
        state.ghostQueue.push(state.currentTitle);
        if (state.ghostQueue.length > MAX_GHOSTS) {
          const old = state.ghostQueue.shift();
          const grp = state.clusterGroups.get(old);
          if (grp) { scene.remove(grp.star); scene.remove(grp.edge); state.clusterGroups.delete(old); state.centerPositions.delete(old); }
        }
      } else {
        const grp = state.clusterGroups.get(state.currentTitle);
        if (grp) { scene.remove(grp.star); scene.remove(grp.edge); state.clusterGroups.delete(state.currentTitle); state.centerPositions.delete(state.currentTitle); }
      }
      state.clusterGroups.set(canonical, { star: newStar, edge: newEdge });
      state.centerPositions.set(canonical, to.clone());
      state.wordToMesh = newMap;
      state.currentTitle = canonical;
      starGroup.children.length = 0; edgeGroup.children.length = 0; // replaced by new groups? (simplified)
      updateTrail();
      state.visited.add(canonical);
      updateBreadcrumbs();
      state.hovered = null;
      tooltip.classList.remove('show');
      state.isAnimating = false;
    }
  }
  requestAnimationFrame(tick);
}
