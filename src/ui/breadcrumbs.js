// breadcrumbs.js
// Builds breadcrumb navigation and provides jumping logic.
import { state } from '../core/state.js';
import { travelToNeighbor } from '../graph/travel.js';

export function updateBreadcrumbs(){
  const nav = document.getElementById('breadcrumbs');
  if (!nav) return;
  nav.innerHTML = '';
  state.history.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.textContent = t;
    btn.title = t;
    if (i === state.historyIndex) btn.classList.add('active');
    btn.addEventListener('click', ()=> jumpToBreadcrumb(i));
    btn.addEventListener('keydown', e=>{ if(e.key==='Enter') jumpToBreadcrumb(i); });
    nav.appendChild(btn);
    if (i < state.history.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      nav.appendChild(sep);
    }
  });
}

export function jumpToBreadcrumb(index){
  if (index === state.historyIndex) return;
  if (state.isAnimating) { state.pendingNav = { type:'breadcrumb', index }; return; }
  state.historyIndex = index;
  const title = state.history[index];
  travelToNeighbor(title, false);
}
