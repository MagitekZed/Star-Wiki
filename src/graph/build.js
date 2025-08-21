// build.js
// Functions for building star clusters and refreshing neighbors.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { getPageStar, fetchSummary, summaryCache, starCache } from '../data/wikipedia.js';
import { state } from '../core/state.js';
import { scene, starGroup, edgeGroup, materialCenter } from '../core/scene.js';
import { placeNeighbor } from './nodes.js';
import { drawRay } from './edges.js';
import { positionForNeighbor } from './layout.js';
import { updateSidebar } from '../ui/sidebar.js';
import { ghostify, updateTrail } from './trail.js';
import { R_MIN, R_MAX } from '../core/constants.js';
import { directionFromTitle } from '../core/math.js';
import { travelToNeighbor } from './travel.js';
import { showToast } from '../ui/toast.js';

export function clearGroup(g){ while (g.children.length) g.remove(g.children.pop()); }

export function buildStarInto(centerTitle, data, gStar, gEdge, map, prevTitle=null, prevVec=null){
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
    drawRay(centerTitle, prevTitle, new THREE.Vector3(0,0,0), prevVec, 0, 1, gEdge, 0xf7768e);
  }

  updateSidebar(data.center, filtered, prevTitle);
}

export function rebuildStar(title, addToHistory=true){
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${title}…`;
  overlay.classList.remove('hidden');
  return getPageStar(title, state.showBacklinks).then(star => {
    overlay.classList.add('hidden');
    const canonical = star.center.title;
    if (addToHistory) {
      if (state.historyIndex < state.history.length - 1) state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(canonical);
      state.historyIndex = state.history.length - 1;
    } else {
      state.history[state.historyIndex] = canonical;
    }
    state.clusterGroups.forEach(g=>{ scene.remove(g.star); scene.remove(g.edge); });
    clearGroup(starGroup); clearGroup(edgeGroup);
    scene.add(starGroup); scene.add(edgeGroup);
    state.wordToMesh.clear();
    state.clusterGroups.clear(); state.centerPositions.clear(); state.ghostQueue.length = 0;
    updateTrail();
    buildStarInto(canonical, star, starGroup, edgeGroup, state.wordToMesh);
    state.clusterGroups.set(canonical, { star: starGroup, edge: edgeGroup });
    state.centerPositions.set(canonical, new THREE.Vector3(0,0,0));
    state.currentTitle = canonical;
    state.visited.add(canonical);
    updateTrail();
    state.isAnimating = false;
  }).catch(err => {
    console.error(err);
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    state.isAnimating = false;
  });
}

export async function refreshCurrentNeighbors(){
  if (!state.currentTitle) return;
  const overlay = document.getElementById('loading');
  const text = document.getElementById('loadingText');
  text.textContent = `Loading ${state.currentTitle}…`;
  overlay.classList.remove('hidden');
  let star;
  try {
    star = await getPageStar(state.currentTitle, state.showBacklinks);
  } catch (e) {
    overlay.classList.add('hidden');
    showToast('Failed to load page.');
    return;
  }
  overlay.classList.add('hidden');

  const prevTitle = state.historyIndex > 0 ? state.history[state.historyIndex - 1] : null;
  const pos = state.centerPositions.get(state.currentTitle) || new THREE.Vector3(0,0,0);
  const prevVec = prevTitle && state.centerPositions.has(prevTitle)
    ? state.centerPositions.get(prevTitle).clone().sub(pos)
    : null;
  state.clusterGroups.get(state.currentTitle).star.clear();
  state.clusterGroups.get(state.currentTitle).edge.clear();
  state.wordToMesh.clear();
  buildStarInto(state.currentTitle, star, state.clusterGroups.get(state.currentTitle).star, state.clusterGroups.get(state.currentTitle).edge, state.wordToMesh, prevTitle, prevVec);
}
