// scene.js
// Initializes Three.js renderer, scene, camera, controls and global groups.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';
import { state } from './state.js';
import { createBackgroundStars, createStarTexture } from './textures.js';
import { RETURN_COLOR } from './constants.js';

const container = document.getElementById('canvas');
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0b10);

export const camera = new THREE.PerspectiveCamera(60, container.clientWidth/container.clientHeight, 0.1, 3000);
export const DEFAULT_CAM_POS = new THREE.Vector3(0, 10, 28);
camera.position.copy(DEFAULT_CAM_POS);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(10, 30, 20);
scene.add(dir);

export const bgStars = createBackgroundStars();
scene.add(bgStars);

export const starGroup = new THREE.Group();
export const edgeGroup = new THREE.Group();
scene.add(starGroup);
scene.add(edgeGroup);

export const starTexture = createStarTexture();

export const materialCenter = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffffff,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x7aa2f7,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x96bdfc,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialBackNeighbor = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffd700,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialBackNeighborHover = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0xffe580,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialVisited = new THREE.SpriteMaterial({
  map: starTexture,
  color: 0x4b5563,
  blending: THREE.AdditiveBlending,
  transparent: true
});
export const materialRayHover = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, linewidth: 2 });

export const trailMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
export const trailGeometry = new THREE.BufferGeometry();
export const trailLine = new THREE.Line(trailGeometry, trailMaterial);
scene.add(trailLine);

export const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
container.appendChild(tooltip);

window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

export function renderOnce(){ renderer.render(scene, camera); }

