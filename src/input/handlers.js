// handlers.js
// Wires mouse and keyboard events to application actions.
import { onGo, setShowBacklinks, setTrailMode, centerCameraOnCurrent, goBackOne, goForwardOne, queueNav, closePreview, isAnimating } from '../app.js';
import { onMouseMove, mouse, updateHover } from './picking.js';
import { state } from '../core/state.js';

const container = document.getElementById('canvas');
container.addEventListener('mousemove', onMouseMove);
container.addEventListener('click', (e)=>{
  if (state.isAnimating) return;
  if (state.hovered && state.hovered.object && state.hovered.object.userData && state.hovered.object.userData.title && state.hovered.object.userData.kind !== 'center') {
    const toTitle = state.hovered.object.userData.title;
    const prev = state.historyIndex > 0 ? state.history[state.historyIndex-1] : null;
    if (prev && toTitle === prev && state.hovered.object.userData.kind === 'ray') {
      goBackOne();
    } else {
      import('../ui/preview.js').then(m=>m.openPreview(toTitle, e.clientX, e.clientY));
    }
  } else if (state.previewTarget) {
    import('../ui/preview.js').then(m=>m.closePreview());
  }
});

const searchInput = document.getElementById('search');
let suggestTimer = null;
searchInput.addEventListener('input', (e)=>{
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  if (!q) { populateDatalist([]); return; }
  suggestTimer = setTimeout(async ()=>{
    try {
      const { wikiFetch } = await import('../data/wikipedia.js');
      const res = await wikiFetch(`https://en.wikipedia.org/w/api.php?action=opensearch&origin=*&limit=10&namespace=0&format=json&search=${encodeURIComponent(q)}`);
      const data = await res.json();
      populateDatalist(data[1] || []);
    } catch{}
  }, 300);
});

function populateDatalist(list){
  const dl = document.getElementById('wordlist');
  dl.innerHTML = '';
  list.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w;
    dl.appendChild(opt);
  });
}

document.getElementById('goBtn').addEventListener('click', ()=> onGo(searchInput.value));
searchInput.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onGo(searchInput.value); });
document.getElementById('backToggle').addEventListener('change', (e)=>{ setShowBacklinks(e.target.checked); });
document.getElementById('trailToggle').addEventListener('change', (e)=>{ setTrailMode(e.target.checked); });
document.getElementById('resetCam').addEventListener('click', centerCameraOnCurrent);

const helpModal = document.getElementById('helpModal');
document.getElementById('helpBtn').addEventListener('click', ()=>{ helpModal.classList.remove('hidden'); });
document.getElementById('helpClose').addEventListener('click', ()=>{ helpModal.classList.add('hidden'); });
helpModal.addEventListener('click', (e)=>{ if(e.target === helpModal) helpModal.addEventListener('hidden'); });

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const active = document.activeElement;
  if (active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) return;
  const previewOverlay = document.getElementById('previewOverlay');
  if (!previewOverlay.classList.contains('hidden')) closePreview();
  if (helpModal && !helpModal.classList.contains('hidden')) helpModal.classList.add('hidden');
  if (isAnimating()) {
    queueNav(e.key === 'ArrowLeft' ? 'left' : 'right');
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft') {
    if (goBackOne()) e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    if (goForwardOne()) e.preventDefault();
  }
});
