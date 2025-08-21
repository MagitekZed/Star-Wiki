// state.js
// Central mutable state for the StarWiki application.
export const state = {
  currentTitle: null,
  history: [],
  historyIndex: -1,
  visited: new Set(),
  wordToMesh: new Map(),
  showBacklinks: false,
  trailMode: true,
  isAnimating: false,
  pendingNav: null,
  pendingMode: null,
  hovered: null,
  previewTarget: null,
  clusterGroups: new Map(), // title -> {star, edge}
  centerPositions: new Map(), // title -> THREE.Vector3
  ghostQueue: [],
};
