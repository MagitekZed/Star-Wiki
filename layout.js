import { wikiFetch, getRandomTitle, findPathBest, fetchDailyFeed } from './wikipedia.js';
import {
  onGo,
  setShowBacklinks,
  setTrailMode,
  setStarSizeMode,
  setShowCrossLinks,
  toggleOverview,
  isOverviewActive,
  centerCameraOnCurrent,
  resetToWelcome,
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
let currentSuggestions = [];
searchInput.addEventListener('input', (e)=>{
  const val = e.target.value;
  // Picking a suggestion fires 'input' with no/replacement inputType — search at once
  if (currentSuggestions.includes(val) && (!e.inputType || e.inputType === 'insertReplacementText')) {
    clearTimeout(suggestTimer);
    onGo(val);
    searchInput.blur();
    return;
  }
  clearTimeout(suggestTimer);
  const q = val.trim();
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
  currentSuggestions = list;
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
document.getElementById('crossToggle')?.addEventListener('change', (e)=>{
  setShowCrossLinks(e.target.checked);
});
document.getElementById('sizeSelect')?.addEventListener('change', (e)=>{
  setStarSizeMode(e.target.value);
});
document.getElementById('mapBtn')?.addEventListener('click', ()=> toggleOverview());

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
if (copyLinkBtn) copyLinkBtn.addEventListener('click', ()=>{ copyShareLink(); document.getElementById('morePanel')?.classList.add('hidden'); });

const snapshotBtn = document.getElementById('snapshotBtn');
if (snapshotBtn) snapshotBtn.addEventListener('click', ()=>{ saveSnapshot(); document.getElementById('morePanel')?.classList.add('hidden'); });

// Mobile bottom-sheet: drag the handle to resize (snap to peek / half / full),
// or tap it to toggle. Recompute the camera view offset once the sheet settles.
const sheetHandle = document.getElementById('sheetHandle');
const infoEl = document.getElementById('info');
if (sheetHandle && infoEl) {
  const COLLAPSED = 88; // keep in sync with --sheet-collapsed-h
  const FOOTER = 26;    // keep in sync with --footer-h
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
  // Full snap reaches the very top (covering the toolbar); footer stays pinned below
  const snaps = () => { const h = window.innerHeight; return [COLLAPSED, Math.round(h*0.5), h - FOOTER]; };
  const curHeight = () => infoEl.getBoundingClientRect().height;
  const nearest = (h) => snaps().reduce((a,b)=> Math.abs(b-h) < Math.abs(a-h) ? b : a);
  const applyHeight = (h)=>{
    infoEl.style.setProperty('--sheet-h', h + 'px');
    const collapsed = h <= COLLAPSED + 4;
    document.body.classList.toggle('sheet-collapsed', collapsed);
    if (collapsed) infoEl.scrollTop = 0; // show the handle/title, not mid-scroll content
  };

  let dragging = false, startY = 0, startH = 0, moved = 0;
  sheetHandle.addEventListener('pointerdown', (e)=>{
    if (!isMobile()) return;
    dragging = true; moved = 0; startY = e.clientY; startH = curHeight();
    infoEl.classList.add('dragging');
    document.body.classList.add('sheet-dragging');
    try { sheetHandle.setPointerCapture(e.pointerId); } catch {}
  });
  sheetHandle.addEventListener('pointermove', (e)=>{
    if (!dragging) return;
    const dy = startY - e.clientY;            // drag up = grow
    moved = Math.max(moved, Math.abs(dy));
    const [lo,, hi] = snaps();
    infoEl.style.setProperty('--sheet-h', Math.min(hi, Math.max(lo, startH + dy)) + 'px');
  });
  const endDrag = (e)=>{
    if (!dragging) return;
    dragging = false;
    infoEl.classList.remove('dragging');
    document.body.classList.remove('sheet-dragging');
    try { sheetHandle.releasePointerCapture(e.pointerId); } catch {}
    const [lo, mid] = snaps();
    applyHeight(moved < 6 ? (curHeight() <= lo + 4 ? mid : lo) : nearest(curHeight()));
  };
  sheetHandle.addEventListener('pointerup', endDrag);
  sheetHandle.addEventListener('pointercancel', endDrag);

  infoEl.addEventListener('transitionend', (e)=>{ if (e.propertyName === 'height') window.dispatchEvent(new Event('resize')); });

  // Navigating (selecting a link/search) while the sheet is open: collapse it
  // first so the freshly-drawn cluster — and the toolbar — are visible again.
  window.addEventListener('starwiki:navigate', ()=>{ if (isMobile() && curHeight() > COLLAPSED + 4) applyHeight(COLLAPSED); });
}

// Mobile "More" menu shortcuts that mirror the demoted toolbar buttons
document.getElementById('startOverItem')?.addEventListener('click', ()=>{ document.getElementById('morePanel')?.classList.add('hidden'); document.getElementById('resetBtn')?.click(); });
document.getElementById('helpItem')?.addEventListener('click', ()=>{ document.getElementById('morePanel')?.classList.add('hidden'); document.getElementById('helpBtn')?.click(); });

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
    result = await findPathBest(from, to, (msg)=>{ if (myId === pathSearchId) pathStatus.textContent = msg; });
  } catch {
    result = { status: 'error' };
  }
  if (myId !== pathSearchId) return; // closed or superseded
  pathFind.disabled = false;
  if (result.status === 'found') {
    const route = result.path.join('  →  ');
    const via = result.source === 'sdow' ? 'Shortest path' : 'Found';
    pathStatus.innerHTML = `${via}: <span class="path-route"></span>`;
    pathStatus.querySelector('.path-route').textContent = route;
    setTimeout(()=>{ if (myId === pathSearchId) { closePathModal(); loadPath(result.path); } }, 700);
  } else if (result.status === 'invalid') {
    pathStatus.innerHTML = `<span class="path-miss">Couldn't find one of those articles. Check the spelling.</span>`;
  } else {
    pathStatus.innerHTML = `<span class="path-miss">No path found. They may be far apart — try a broader endpoint.</span>`;
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

// ===== Header menus (View + More) and saved journeys =====
const BM_KEY = 'starwiki.bookmarks';
const bookmarksList = document.getElementById('bookmarksList');
const saveBtn = document.getElementById('saveBtn');
const viewBtn = document.getElementById('viewBtn');
const viewPanel = document.getElementById('viewPanel');
const moreBtn = document.getElementById('moreBtn');
const morePanel = document.getElementById('morePanel');

function getBookmarks(){ try { return JSON.parse(localStorage.getItem(BM_KEY) || '[]'); } catch { return []; } }
function setBookmarks(list){ try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch {} }

function renderBookmarks(){
  if (!bookmarksList) return;
  const list = getBookmarks();
  bookmarksList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No saved journeys yet.';
    bookmarksList.appendChild(empty);
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
      if (morePanel) morePanel.classList.add('hidden');
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
    bookmarksList.appendChild(row);
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

function closeMenus(except){
  [viewPanel, morePanel].forEach(p => { if (p && p !== except) p.classList.add('hidden'); });
}
function toggleMenu(panel){
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  closeMenus(panel);
  panel.classList.toggle('hidden', !willOpen);
}
if (viewBtn) viewBtn.addEventListener('click', (e)=>{ e.stopPropagation(); toggleMenu(viewPanel); });
if (moreBtn) moreBtn.addEventListener('click', (e)=>{ e.stopPropagation(); renderBookmarks(); toggleMenu(morePanel); });

document.addEventListener('click', (e)=>{
  if (e.target.closest('.menu')) return; // clicks inside a menu keep it open
  closeMenus();
});

document.getElementById('resetCam').addEventListener('click', centerCameraOnCurrent);
document.getElementById('resetBtn')?.addEventListener('click', resetToWelcome);

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
  if (e.key === 'Escape' && isOverviewActive()) { toggleOverview(false); }
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
