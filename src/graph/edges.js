// edges.js
// Utilities for creating ray edges between stars.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { starTexture, materialNeighbor, materialBackNeighbor, materialRayHover } from '../core/scene.js';
import { state } from '../core/state.js';
import { opacityFromRank } from './layout.js';

export function drawRay(centerTitle, targetTitle, startVec3, endVec3, rank, total, group, colorOverride=null){
  const geo = new THREE.BufferGeometry().setFromPoints([startVec3, endVec3]);
  const lineOpacity = colorOverride ? 1 : opacityFromRank(rank, total);
  const baseColor = colorOverride || (state.showBacklinks ? 0xffd700 : 0x7aa2f7);
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
    speed: 0.22,
    phase: 0
  };
  group.add(dot);
}
