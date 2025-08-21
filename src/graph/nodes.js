// nodes.js
// Helpers for creating and updating star sprites.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { materialNeighbor, materialBackNeighbor, materialVisited } from '../core/scene.js';
import { state } from '../core/state.js';

export function placeNeighbor(title, posArray, group, map){
  const baseMat = state.visited.has(title)
    ? materialVisited
    : (state.showBacklinks ? materialBackNeighbor : materialNeighbor);
  const mesh = new THREE.Sprite(baseMat.clone());
  mesh.position.set(posArray[0], posArray[1], posArray[2]);
  mesh.userData = { title, kind: 'neighbor', baseScale: 1.2 };
  group.add(mesh);
  map.set(title, mesh);
  return mesh;
}
