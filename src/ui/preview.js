// preview.js
// Logic for preview modal displayed on star click.
import { fetchSummary } from '../data/wikipedia.js';
import { state } from '../core/state.js';
import { travelToNeighbor } from '../graph/travel.js';

const overlay = document.getElementById('previewOverlay');
const modal = document.getElementById('previewModal');
const body = document.getElementById('previewBody');
const titleEl = document.getElementById('previewTitle');
const extractEl = document.getElementById('previewExtract');
const thumbEl = document.getElementById('previewThumb');
const linkEl = document.getElementById('previewLink');

export function positionPreview(x, y){
  modal.style.transform = '';
  if (x == null || y == null || window.innerWidth < 600) {
    modal.style.left = '50%';
    modal.style.top = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
  } else {
    const rect = modal.getBoundingClientRect();
    let left = x + 12;
    let top = y + 12;
    if (left + rect.width > window.innerWidth) left = x - rect.width - 12;
    if (top + rect.height > window.innerHeight) top = y - rect.height - 12;
    modal.style.left = left + 'px';
    modal.style.top = top + 'px';
  }
}

export async function openPreview(title, x, y){
  if (state.isAnimating) return;
  state.previewTarget = title;
  titleEl.textContent = title;
  extractEl.textContent = 'Loading…';
  thumbEl.src = '';
  linkEl.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  overlay.classList.remove('hidden');
  positionPreview(x, y);
  body.focus();
  document.addEventListener('keydown', previewKeyHandler);
  const data = await fetchSummary(title);
  if (state.previewTarget !== title) return;
  titleEl.textContent = data.title || title;
  if (data.thumbnail) thumbEl.src = data.thumbnail; else thumbEl.removeAttribute('src');
  if (data.extract) {
    const first = data.extract.split('. ').slice(0,2).join('. ');
    extractEl.textContent = first;
  } else {
    extractEl.textContent = '';
  }
  positionPreview(x, y);
}

export function closePreview(){
  overlay.classList.add('hidden');
  state.previewTarget = null;
  document.removeEventListener('keydown', previewKeyHandler);
}

export function confirmPreview(){
  if (!state.previewTarget) return;
  const target = state.previewTarget;
  const chainPrev = state.historyIndex > 0 ? state.history[state.historyIndex-1] : null;
  closePreview();
  if (chainPrev && target === chainPrev) {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      travelToNeighbor(target, false);
    }
  } else {
    travelToNeighbor(target);
  }
}

function previewKeyHandler(e){
  if (e.key === 'Escape') {
    e.preventDefault();
    closePreview();
  } else if (e.key === 'Enter') {
    if (document.activeElement !== linkEl) {
      e.preventDefault();
      confirmPreview();
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const focusables = [body, linkEl];
    let idx = focusables.indexOf(document.activeElement);
    idx = (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[idx].focus();
  }
}

overlay.addEventListener('click', e=>{ if (e.target === overlay) closePreview(); });
body.addEventListener('click', confirmPreview);
linkEl.addEventListener('click', e=> e.stopPropagation());
