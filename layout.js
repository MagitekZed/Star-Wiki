import { wikiFetch, getRandomTitle, findPath, fetchDailyFeed } from './wikipedia.js';
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

// Mobile bottom-sheet collapse toggle (recompute camera view offset once settled)
const sheetHandle = document.getElementById('sheetHandle');
const infoEl = document.getElementById('info');
if (sheetHandle && infoEl) {
  sheetHandle.addEventListener('click', ()=> infoEl.classList.toggle('collapsed'));
  infoEl.addEventListener('transitionend', (e)=>{ if (e.propertyName === 'max-height') window.dispatchEvent(new Event('resize')); });
}

// ===== Path finder ("six degrees") =====
const pathOverlay = document.getElementById('pathOverlay');
const pathBtn = document.getElementById('pathBtn');
const pathClose = document.getElementById('pathClose');
const pathFrom = document.getElementById('pathFrom');
const pathTo = document.getElementById('pathTo');
const pathFind = document.getElementById('pathFind');
const pathStatus = document.getElementById('pathStatus');
let pathSearchId = 0; // ignore results from a superseded/closed search

function openPathModal(){
  if (!pathOverlay) return;
  const hist = getHistory();
  if (hist.length && pathFrom && !pathFrom.value.trim()) pathFrom.value = hist[hist.length - 1];
  pathStatus.textContent = '';
  pathOverlay.classList.remove('hidden');
  (pathFrom.value.trim() ? pathTo : pathFrom).focus();
}
function closePathModal(){
  if (!pathOverlay) return;
  pathSearchId++; // invalidate any in-flight search
  pathOverlay.classList.add('hidden');
}

async function runPathFind(){
  const from = pathFrom.value.trim();
  const to = pathTo.value.trim();
  if (!from || !to) { pathStatus.textContent = 'Enter both a start and an end article.'; return; }
  const myId = ++pathSearchId;
  pathFind.disabled = true;
  pathStatus.textContent = 'Searching…';
  let result;
  try {
    result = await findPath(from, to, (msg)=>{ if (myId === pathSearchId) pathStatus.textContent = msg; });
  } catch {
    result = { status: 'error' };
  }
  if (myId !== pathSearchId) return; // closed or superseded
  pathFind.disabled = false;
  if (result.status === 'found') {
    const route = result.path.join('  →  ');
    pathStatus.innerHTML = `Found: <span class="path-route"></span>`;
    pathStatus.querySelector('.path-route').textContent = route;
    setTimeout(()=>{ if (myId === pathSearchId) { closePathModal(); loadPath(result.path); } }, 700);
  } else if (result.status === 'invalid') {
    pathStatus.innerHTML = `<span class="path-miss">Couldn't find one of those articles. Check the spelling.</span>`;
  } else {
    pathStatus.innerHTML = `<span class="path-miss">No path found within 2 links. They may be far apart — try a broader endpoint.</span>`;
  }
}

if (pathBtn) pathBtn.addEventListener('click', openPathModal);
if (pathClose) pathClose.addEventListener('click', closePathModal);
if (pathOverlay) pathOverlay.addEventListener('click', e=>{ if (e.target === pathOverlay) closePathModal(); });
if (pathFind) pathFind.addEventListener('click', runPathFind);
if (pathTo) pathTo.addEventListener('keydown', e=>{ if (e.key === 'Enter') runPathFind(); });
if (pathFrom) pathFrom.addEventListener('keydown', e=>{ if (e.key === 'Enter') pathTo.focus(); });

// Daily launchpad (featured + on this day) in the first-run welcome
(async function loadDailyFeed(){
  const box = document.getElementById('welcome-daily');
  if (!box) return;
  let feed;
  try { feed = await fetchDailyFeed(); } catch { return; }
  const addSection = (label, titles)=>{
    if (!titles || !titles.length) return;
    const sec = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'welcome-daily-label';
    lbl.textContent = label;
    sec.appendChild(lbl);
    const chips = document.createElement('div');
    chips.className = 'welcome-chips';
    titles.forEach(t => {
      const b = document.createElement('button');
      b.className = 'starter-chip';
      b.textContent = t;
      b.title = t;
      b.addEventListener('click', ()=> onGo(t));
      chips.appendChild(b);
    });
    sec.appendChild(chips);
    box.appendChild(sec);
  };
  addSection('Featured today', feed.featured ? [feed.featured] : []);
  addSection('On this day', feed.onThisDay);
})();

// First-run starter chips
document.querySelectorAll('#welcome .starter-chip').forEach(chip => {
  chip.addEventListener('click', ()=> onGo(chip.textContent));
});

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
    del.innerHTML = '<svg class="icon"><use href="#ic-close"/></svg>';
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
