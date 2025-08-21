// sidebar.js
// Sidebar rendering for current article and neighbor list.
import { summaryCache } from '../data/wikipedia.js';
import { state } from '../core/state.js';
import { fetchSummary } from '../data/wikipedia.js';
import { goBackOne } from '../app.js';
import { openPreview } from './preview.js';

export function updateSidebar(center, neighbors, chainPrev){
  const heading = document.getElementById('currentWord');
  heading.textContent = center.title;
  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerHTML = '';
  if (center.thumbnailUrl) {
    const img = document.createElement('img');
    img.src = center.thumbnailUrl; img.alt = '';
    summaryDiv.appendChild(img);
  }
  if (center.summary) {
    const p = document.createElement('p');
    p.textContent = center.summary;
    summaryDiv.appendChild(p);
  }
  const link = document.createElement('a');
  link.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(center.title)}`;
  link.target = '_blank';
  link.textContent = 'View on Wikipedia';
  summaryDiv.appendChild(link);
  summaryCache.set(center.title, { title: center.title, extract: center.summary || '', thumbnail: center.thumbnailUrl || null });

  const container = document.getElementById('neighbors');
  container.innerHTML = '';
  if (chainPrev) {
    const backRow = document.createElement('div');
    backRow.className = 'neighbor return';
    backRow.tabIndex = 0;
    backRow.textContent = `Back to ${chainPrev}`;
    backRow.addEventListener('click', ()=> goBackOne());
    backRow.addEventListener('keydown', e=>{ if(e.key==='Enter') goBackOne(); });
    container.appendChild(backRow);
  }
  neighbors.forEach(nb => {
    const row = document.createElement('div');
    row.className = 'neighbor';
    row.tabIndex = 0;
    if (state.visited.has(nb)) row.classList.add('visited');
    row.addEventListener('click', e=> openPreview(nb, e.clientX, e.clientY));
    row.addEventListener('keydown', e=>{ if(e.key==='Enter') openPreview(nb); });
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    row.appendChild(img);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'title';
    titleDiv.textContent = nb;
    titleDiv.title = nb;
    meta.appendChild(titleDiv);
    const extractDiv = document.createElement('div');
    extractDiv.className = 'extract';
    meta.appendChild(extractDiv);
    row.appendChild(meta);
    const ext = document.createElement('a');
    ext.className = 'ext';
    ext.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(nb)}`;
    ext.target = '_blank';
    ext.textContent = '↗';
    ext.setAttribute('aria-label', 'Open on Wikipedia');
    ext.addEventListener('click', e=> e.stopPropagation());
    ext.addEventListener('keydown', e=> e.stopPropagation());
    row.appendChild(ext);
    container.appendChild(row);
    fetchNeighborInfo(nb, row);
  });
  if (neighbors.length === 0) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = 'No links found';
    container.appendChild(row);
  }
}

export async function fetchNeighborInfo(title, row){
  const data = await fetchSummary(title);
  const img = row.querySelector('img.thumb');
  if (data.thumbnail) img.src = data.thumbnail;
  const ex = row.querySelector('.extract');
  if (data.extract) {
    const first = data.extract.split('. ')[0];
    ex.textContent = first.endsWith('.') ? first : first + '.';
  }
}
