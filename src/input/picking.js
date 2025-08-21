// picking.js
// Raycasting and hover resolution.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { state } from '../core/state.js';
import { camera, renderer, starGroup, edgeGroup, tooltip, materialNeighbor, materialBackNeighbor, materialNeighborHover, materialBackNeighborHover, materialVisited, materialRayHover } from '../core/scene.js';

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.1;
const mouse = new THREE.Vector2();
export { mouse };

export function onMouseMove(e){
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function resetHovered(){
  if (!state.hovered) return;
  const obj = state.hovered.object;
  if (obj.userData.kind === 'neighbor') {
    const baseMat = state.visited.has(obj.userData.title)
      ? materialVisited
      : (state.showBacklinks ? materialBackNeighbor : materialNeighbor);
    obj.material = baseMat.clone();
    if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale, obj.userData.baseScale, 1);
  } else if (obj.userData.normalMat) {
    obj.material = obj.userData.normalMat;
  }
}

export function updateHover(){
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects([...edgeGroup.children, ...starGroup.children], false);
  if (intersects.length > 0) {
    const first = intersects[0];
    if (state.hovered && state.hovered.object !== first.object) resetHovered();
    state.hovered = first;
    const obj = first.object;
    tooltip.classList.add('show');
    if (obj.userData.kind === 'neighbor') {
      obj.material = (state.showBacklinks ? materialBackNeighborHover : materialNeighborHover).clone();
      if(obj.userData.baseScale) obj.scale.set(obj.userData.baseScale * 1.25, obj.userData.baseScale * 1.25, 1);
      const worldPos = obj.getWorldPosition(new THREE.Vector3());
      const rect = renderer.domElement.getBoundingClientRect();
      const v = worldPos.project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width;
      const y = (-v.y * 0.5 + 0.5) * rect.height;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.textContent = obj.userData.title;
    } else if (obj.userData.title && obj.userData.kind !== 'center') {
      obj.material = materialRayHover;
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
    if (state.hovered) resetHovered();
    state.hovered = null;
    tooltip.classList.remove('show');
  }
}
