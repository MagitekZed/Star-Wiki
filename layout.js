import { wikiFetch, getRandomTitle } from './wikipedia.js';
import {
  onGo,
  setShowBacklinks,
  setTrailMode,
  centerCameraOnCurrent,
  goBackOne,
  goForwardOne,
  queueNav,
  closePreview,
  copyShareLink,
  saveSnapshot,
  getHistory,
  loadPath,
  isAnimating
} from './graphics.js';

const searchInput = document.getElementById('search');
let suggestTimer = null;
searchInput.addEventListener('input', (e)=>{
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  if (!q) { populateDatalist([]); return; }
  suggestTimer = setTimeout(async ()=>{
    try {
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
document.getElementById('backToggle').addEventListener('change', (e)=>{
  setShowBacklinks(e.target.checked);
});
document.getElementById('trailToggle').addEventListener('change', (e)=>{
  setTrailMode(e.target.checked);
});

const randomBtn = document.getElementById('randomBtn');
if (randomBtn) randomBtn.addEventListener('click', async ()=>{
  randomBtn.disabled = true;
  try {
    const title = await getRandomTitle();
    if (title) onGo(title);
  } finally {
    randomBtn.disabled = false;
  }
});

const copyLinkBtn = document.getElementById('copyLinkBtn');
if (copyLinkBtn) copyLinkBtn.addEventListener('click', ()=> copyShareLink());

const snapshotBtn = document.getElementById('snapshotBtn');
if (snapshotBtn) snapshotBtn.addEventListener('click', ()=> saveSnapshot());

// ===== Bookmarks (saved journeys) =====
const BM_KEY = 'starwiki.bookmarks';
const bookmarksPanel = document.getElementById('bookmarksPanel');
const bookmarksBtn = document.getElementById('bookmarksBtn');
const saveBtn = document.getElementById('saveBtn');

function getBookmarks(){ try { return JSON.parse(localStorage.getItem(BM_KEY) || '[]'); } catch { return []; } }
function setBookmarks(list){ try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch {} }

function renderBookmarks(){
  if (!bookmarksPanel) return;
  const list = getBookmarks();
  bookmarksPanel.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No saved journeys yet.';
    bookmarksPanel.appendChild(empty);
    return;
  }
  list.forEach((bm) => {
    const row = document.createElement('div');
    row.className = 'bookmark';

    const load = document.createElement('button');
    load.className = 'bm-load';
    const name = document.createElement('div');
    name.className = 'bm-name';
    name.textContent = bm.name;
    name.title = bm.name;
    const sub = document.createElement('div');
    sub.className = 'bm-sub';
    sub.textContent = `${bm.path.length} stop${bm.path.length > 1 ? 's' : ''}`;
    load.appendChild(name);
    load.appendChild(sub);
    load.addEventListener('click', ()=>{
      loadPath(bm.path);
      bookmarksPanel.classList.add('hidden');
    });

    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '✕';
    del.title = 'Delete journey';
    del.setAttribute('aria-label', 'Delete journey');
    del.addEventListener('click', (e)=>{
      e.stopPropagation();
      const cur = getBookmarks().filter(b => b.savedAt !== bm.savedAt);
      setBookmarks(cur);
      renderBookmarks();
    });

    row.appendChild(load);
    row.appendChild(del);
    bookmarksPanel.appendChild(row);
  });
}

if (saveBtn) saveBtn.addEventListener('click', ()=>{
  const path = getHistory();
  if (!path.length) return;
  const def = path.length > 1 ? `${path[0]} → ${path[path.length - 1]}` : path[0];
  const name = prompt('Name this journey:', def);
  if (name === null) return; // cancelled
  const list = getBookmarks();
  list.unshift({ name: name.trim() || def, path, savedAt: Date.now() });
  setBookmarks(list);
  renderBookmarks();
});

if (bookmarksBtn) bookmarksBtn.addEventListener('click', (e)=>{
  e.stopPropagation();
  renderBookmarks();
  bookmarksPanel.classList.toggle('hidden');
});

document.addEventListener('click', (e)=>{
  if (!bookmarksPanel || bookmarksPanel.classList.contains('hidden')) return;
  if (e.target.closest('.menu')) return;
  bookmarksPanel.classList.add('hidden');
});

document.getElementById('resetCam').addEventListener('click', centerCameraOnCurrent);

const helpModal = document.getElementById('helpModal');
document.getElementById('helpBtn').addEventListener('click', ()=>{
  helpModal.classList.remove('hidden');
});
document.getElementById('helpClose').addEventListener('click', ()=>{
  helpModal.classList.add('hidden');
});
helpModal.addEventListener('click', (e)=>{
  if(e.target === helpModal) helpModal.classList.add('hidden');
});

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const active = document.activeElement;
  if (active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) return;
  const previewOverlay = document.getElementById('previewOverlay');
  if (!previewOverlay.classList.contains('hidden')) closePreview();
  if (helpModal && !helpModal.classList.contains('hidden')) helpModal.classList.add('hidden');

  if (isAnimating) {
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
