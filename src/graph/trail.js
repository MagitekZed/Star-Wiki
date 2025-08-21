// trail.js
// Manages the breadcrumb trail line and ghosting of past stars.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { trailGeometry } from '../core/scene.js';
import { state } from '../core/state.js';
import { MAX_GHOSTS } from '../core/constants.js';

export function ghostify(title){
  const grp = state.clusterGroups.get(title);
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

export function updateTrail(){
  const pts = state.history.map(t => state.centerPositions.get(t)).filter(Boolean);
  if (pts.length < 2) {
    trailGeometry.setFromPoints([]);
  } else {
    trailGeometry.setFromPoints(pts);
  }
}
