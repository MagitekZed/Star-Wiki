const starCache = new Map();
const MAX_CACHE = 64;
let lastFetch = 0;
const FETCH_DELAY = 250;
const summaryCache = new Map();

// ===== Optional page metadata cache & helpers (categories, wikidata id, length) =====
const metaCache = new Map();

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetch categories, Wikidata id, and (if available) length for a batch of titles.
 * Returns a mapping: title -> { categories?: string[], wikidataId?: string|null, length?: number|null }
 * All fields are optional; callers must treat them as hints.
 */
async function fetchPageMetaBatch(titles){
  const result = {};
  const missing = [];
  for (const t of titles) {
    if (metaCache.has(t)) {
      result[t] = metaCache.get(t);
    } else {
      missing.push(t);
    }
  }
  if (missing.length === 0) return result;

  // MediaWiki API supports up to ~50 titles per request.
  const chunks = chunkArray(missing, 50);
  for (const ch of chunks) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=categories|pageprops|info&clshow=!hidden&cllimit=max&titles=${encodeURIComponent(ch.join('|'))}`;
      const res = await wikiFetch(url);
      const data = await res.json();
      const pages = data.query?.pages ? Object.values(data.query.pages) : [];
      for (const p of pages) {
        if (!p || p.missing === '' || p.invalid === '') continue;
        const title = p.title;
        const meta = {
          categories: Array.isArray(p.categories) ? p.categories.map(c => c.title.replace(/^Category:/, '')) : undefined,
          wikidataId: p.pageprops?.wikibase_item || null,
          length: (typeof p.length === 'number' ? p.length : undefined)
        };
        result[title] = meta;
        metaCache.set(title, meta);
      }
    } catch {}
  }
  return result;
}

async function wikiFetch(url){
  const now = Date.now();
  const wait = Math.max(0, lastFetch + FETCH_DELAY - now);
  if (wait) await new Promise(r=>setTimeout(r, wait));
  lastFetch = Date.now();
  return fetch(url, { headers: { 'Api-User-Agent': 'StarWiki/1.0 (https://github.com/MagitekZed/Star-Wiki)' } });
}

async function fetchSummary(title){
  if (summaryCache.has(title)) return summaryCache.get(title);
  const info = { title, extract: '', thumbnail: null };
  let ok = false;
  try {
    const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) info.title = data.title;
      if (data.extract) info.extract = data.extract;
      if (data.thumbnail?.source) info.thumbnail = data.thumbnail.source;
      ok = true;
    }
  } catch {}
  // Only cache successful responses so a transient failure isn't cached permanently.
  if (ok) summaryCache.set(title, info);
  return info;
}

async function normalizeTitle(title){
  let canonical = title;
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
    if (page?.title) canonical = page.title;
  } catch {}
  return canonical;
}

async function fetchRelevance(title){
  const relevance = new Map();
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`morelike:${title}`)}&srlimit=500&srprop=score&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    if (data.query?.search) {
      data.query.search.forEach((it, idx) => {
        relevance.set(it.title, { rank: idx, score: it.score });
      });
    }
  } catch {}
  return relevance;
}

async function getPageStar(title, backlinks=false){
  title = title.trim();
  const preKey = `${backlinks ? 'back' : 'out'}|${title}`;
  if (starCache.has(preKey)) {
    const v = starCache.get(preKey);
    starCache.delete(preKey); starCache.set(preKey, v);
    return v;
  }

  const canonical = await normalizeTitle(title);
  const key = `${backlinks ? 'back' : 'out'}|${canonical}`;
  if (starCache.has(key)) {
    const v = starCache.get(key);
    starCache.delete(key); starCache.set(key, v);
    return v;
  }

  let summaryData = null;
  try {
    const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(canonical)}`);
    if (res.ok) summaryData = await res.json();
  } catch {}
  if (!summaryData) throw new Error('summary fetch failed');

  const candidates = [];
  const seen = new Set();
  try {
    if (backlinks) {
      let cont = null;
      do {
        let url = `https://en.wikipedia.org/w/api.php?action=query&list=backlinks&bltitle=${encodeURIComponent(canonical)}&blnamespace=0&bllimit=max&format=json&origin=*`;
        if (cont) url += `&blcontinue=${encodeURIComponent(cont)}`;
        const res = await wikiFetch(url);
        const data = await res.json();
        if (data.query?.backlinks) {
          for (const l of data.query.backlinks) {
            const t = l.title;
            if (t === canonical || seen.has(t)) continue;
            seen.add(t); candidates.push({ title: t, index: candidates.length });
          }
        }
        cont = data.continue?.blcontinue;
      } while (cont);
    } else {
      let cont = null;
      do {
        let url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(canonical)}&prop=links&plnamespace=0&pllimit=max&format=json&origin=*`;
        if (cont) url += `&plcontinue=${encodeURIComponent(cont)}`;
        const res = await wikiFetch(url);
        const data = await res.json();
        const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
        if (page?.links) {
          for (const l of page.links) {
            const t = l.title;
            if (t === canonical || seen.has(t)) continue;
            seen.add(t); candidates.push({ title: t, index: candidates.length });
          }
        }
        cont = data.continue?.plcontinue;
      } while (cont);
    }
  } catch {}

  const relevance = await fetchRelevance(canonical);
  const scored = candidates.map(c => {
    const r = relevance.get(c.title);
    return {
      title: c.title,
      index: c.index,
      rank: r ? r.rank : Infinity,
      score: r ? r.score : 0
    };
  });
  scored.sort((a,b)=> {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.score !== b.score) return b.score - a.score;
    if (a.index !== b.index) return a.index - b.index;
    return a.title.localeCompare(b.title);
  });
  const neighbors = scored.slice(0,20).map(s=>s.title);

  // Optional metadata for center + neighbors (best-effort; non-blocking)
  let metaByTitle = {};
  try {
    const meta = await fetchPageMetaBatch([canonical, ...neighbors]);
    metaByTitle = meta || {};
  } catch {}

  const star = {
    center: {
      title: canonical,
      summary: summaryData.extract,
      thumbnailUrl: summaryData.thumbnail?.source,
      // Optional fields (may be undefined):
      length: (metaByTitle[canonical]||{}).length,
      categories: (metaByTitle[canonical]||{}).categories,
      wikidataId: (metaByTitle[canonical]||{}).wikidataId
    },
    neighbors,
    metaByTitle,
    fetchedAt: Date.now()
  };
  starCache.set(key, star);
  if (starCache.size > MAX_CACHE) {
    const first = starCache.keys().next().value;
    starCache.delete(first);
  }
  return star;
}

// ===== Wikidata "quick facts" =====
const factsCache = new Map();
// Curated properties -> friendly label + datatype. Order = display priority.
const WD_PROPS = [
  ['P569', 'Born', 'time'],
  ['P570', 'Died', 'time'],
  ['P19',  'Born in', 'entity'],
  ['P27',  'Country', 'entity'],
  ['P17',  'Country', 'entity'],
  ['P571', 'Founded', 'time'],
  ['P112', 'Founded by', 'entity'],
  ['P159', 'Headquarters', 'entity'],
  ['P36',  'Capital', 'entity'],
  ['P1082','Population', 'quantity'],
  ['P38',  'Currency', 'entity'],
  ['P50',  'Author', 'entity'],
  ['P57',  'Director', 'entity'],
  ['P86',  'Composer', 'entity'],
  ['P136', 'Genre', 'entity'],
  ['P641', 'Sport', 'entity'],
  ['P170', 'Creator', 'entity'],
  ['P577', 'Released', 'time'],
  ['P625', 'Coordinates', 'coord']
];

function formatWdTime(t){
  const m = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(t || '');
  if (!m) return null;
  const sign = m[1] === '-' ? '-' : '';
  const year = parseInt(m[2], 10);
  const month = parseInt(m[3], 10);
  const day = parseInt(m[4], 10);
  if (!year) return null;
  if (!month || !day) return `${sign}${year}`;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[month-1]} ${day}, ${sign}${year}`;
}

async function fetchWikidataFacts(id){
  if (!id) return [];
  if (factsCache.has(id)) return factsCache.get(id);
  let facts = [];
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(id)}&props=claims&languages=en&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const claims = data.entities?.[id]?.claims || {};
    const raw = [];
    const toResolve = new Set();
    for (const [prop, label, type] of WD_PROPS) {
      const arr = claims[prop];
      if (!arr || !arr.length) continue;
      const snak = arr[0].mainsnak;
      if (!snak || snak.snaktype !== 'value' || !snak.datavalue) continue;
      const v = snak.datavalue.value;
      if (type === 'time') {
        const f = formatWdTime(v.time);
        if (f) raw.push({ label, value: f });
      } else if (type === 'quantity') {
        const amt = parseFloat(v.amount);
        if (isFinite(amt)) raw.push({ label, value: amt.toLocaleString() });
      } else if (type === 'coord') {
        if (typeof v.latitude === 'number') raw.push({ label, value: `${v.latitude.toFixed(2)}, ${v.longitude.toFixed(2)}` });
      } else if (type === 'entity') {
        const qid = v.id;
        if (qid) { raw.push({ label, qid, value: null }); toResolve.add(qid); }
      }
    }
    if (toResolve.size) {
      const ids = [...toResolve].slice(0, 50).join('|');
      const lurl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=labels&languages=en&format=json&origin=*`;
      const lres = await wikiFetch(lurl);
      const ldata = await lres.json();
      for (const item of raw) {
        if (item.qid) item.value = ldata.entities?.[item.qid]?.labels?.en?.value || null;
      }
    }
    facts = raw.filter(f => f.value).slice(0, 6).map(f => ({ label: f.label, value: f.value }));
  } catch {}
  factsCache.set(id, facts);
  return facts;
}

// ===== Path finder ("six degrees") =====
async function fetchOutgoingLinks(title, cap = 500){
  const out = [];
  const seen = new Set();
  let cont = null;
  do {
    let url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=links&plnamespace=0&pllimit=max&format=json&origin=*`;
    if (cont) url += `&plcontinue=${encodeURIComponent(cont)}`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
    if (page?.links) {
      for (const l of page.links) {
        if (!seen.has(l.title)) { seen.add(l.title); out.push(l.title); }
      }
    }
    cont = data.continue?.plcontinue;
  } while (cont && out.length < cap);
  return out.slice(0, cap);
}

// Pages that link TO `title` (its backlinks), capped. Used as the backward
// frontier for the 3-hop "meet in the middle" search.
async function fetchBacklinks(title, cap = 300){
  const out = [];
  const seen = new Set();
  let cont = null;
  do {
    let url = `https://en.wikipedia.org/w/api.php?action=query&list=backlinks&bltitle=${encodeURIComponent(title)}&blnamespace=0&bllimit=max&format=json&origin=*`;
    if (cont) url += `&blcontinue=${encodeURIComponent(cont)}`;
    const res = await wikiFetch(url);
    const data = await res.json();
    if (data.query?.backlinks) {
      for (const l of data.query.backlinks) {
        if (!seen.has(l.title)) { seen.add(l.title); out.push(l.title); }
      }
    }
    cont = data.continue?.blcontinue;
  } while (cont && out.length < cap);
  return out.slice(0, cap);
}

/**
 * Find a directed link path from -> to, up to 3 hops (path length <= 4 nodes).
 * Stages: 1 hop (to is directly linked), 2 hops (one of from's links points at
 * to), then a bidirectional 3-hop "meet in the middle" — bridge from's forward
 * links (L0) to to's backlinks (B) by checking for an edge a->b with a∈L0, b∈B,
 * using prop=links + pltitles to batch the check. The 3-hop stage is bounded by a
 * request budget (hub pages have huge backlink sets), so it is best-effort, not a
 * guaranteed-shortest path. onProgress(msg) reports status. Returns:
 *   { status:'found', path:[...] } | { status:'notfound', from, to } | { status:'invalid' }
 */
async function findPath(fromTitle, toTitle, onProgress = ()=>{}){
  const from = await normalizeTitle((fromTitle || '').trim());
  const to = await normalizeTitle((toTitle || '').trim());
  if (!from || !to) return { status: 'invalid' };
  if (from === to) return { status: 'found', path: [from] };

  onProgress(`Mapping links from “${from}”…`);
  const L0 = await fetchOutgoingLinks(from, 500);
  if (!L0.length) return { status: 'notfound', from, to };
  if (L0.includes(to)) return { status: 'found', path: [from, to] };

  // ----- 2 hops: from -> a -> to (a links directly to `to`) -----
  onProgress(`Checking ${L0.length} first-hop links…`);
  const chunks = chunkArray(L0, 50);
  let checked = 0;
  for (const ch of chunks) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(ch.join('|'))}&prop=links&pltitles=${encodeURIComponent(to)}&pllimit=max&format=json&origin=*`;
      const res = await wikiFetch(url);
      const data = await res.json();
      const pages = data.query?.pages ? Object.values(data.query.pages) : [];
      for (const p of pages) {
        if (p.links && p.links.length) return { status: 'found', path: [from, p.title, to] };
      }
    } catch {}
    checked += ch.length;
    onProgress(`Checked ${checked}/${L0.length} links…`);
  }

  // ----- 3 hops: from -> a -> b -> to (a∈L0, b links to `to`) -----
  onProgress('No direct link — searching one level deeper…');
  let B = [];
  try { B = await fetchBacklinks(to, 250); } catch {}
  B = B.filter(t => t !== from && t !== to);
  if (B.length) {
    const aChunks = chunkArray(L0.filter(t => t !== to).slice(0, 300), 50);
    const bChunks = chunkArray(B, 50);
    const MAX_REQ = 30; // hub pages would otherwise explode; bail gracefully
    let req = 0;
    for (const aCh of aChunks) {
      for (const bCh of bChunks) {
        if (req >= MAX_REQ) return { status: 'notfound', from, to };
        req++;
        onProgress(`Searching deeper… (${req})`);
        try {
          const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(aCh.join('|'))}&prop=links&plnamespace=0&pllimit=max&pltitles=${encodeURIComponent(bCh.join('|'))}&format=json&origin=*`;
          const res = await wikiFetch(url);
          const data = await res.json();
          const pages = data.query?.pages ? Object.values(data.query.pages) : [];
          for (const p of pages) {
            if (!p.links || !p.links.length) continue;
            const a = p.title;
            const b = p.links[0].title;
            if (a !== from && a !== to && a !== b && b !== from && b !== to) {
              return { status: 'found', path: [from, a, b, to] };
            }
          }
        } catch {}
      }
    }
  }
  return { status: 'notfound', from, to };
}

// ===== Deep path finding via Six Degrees of Wikipedia =====
// Public, CORS-open API backed by a precomputed link graph from the Wikipedia
// dumps. Returns true shortest path(s) at any depth, instantly. Snapshot data
// (not live), so we use it first and fall back to the live search below.
async function findPathSDOW(fromTitle, toTitle){
  const source = (fromTitle || '').trim();
  const target = (toTitle || '').trim();
  if (!source || !target) return { status: 'invalid' };
  let data;
  try {
    const res = await fetch('https://api.sixdegreesofwikipedia.com/paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target })
    });
    if (!res.ok) return { status: 'error' };
    data = await res.json();
  } catch {
    return { status: 'error' };
  }
  const paths = Array.isArray(data.paths) ? data.paths : [];
  const pages = data.pages || {};
  if (!paths.length) return { status: 'notfound' };
  const ids = paths[0];
  const titles = ids.map(id => pages[id] && pages[id].title).filter(Boolean);
  if (titles.length !== ids.length || titles.length < 1) return { status: 'error' };
  return { status: 'found', path: titles, source: 'sdow', pathCount: paths.length };
}

/**
 * Best-effort path finder: try Six Degrees of Wikipedia (deep, instant, full
 * graph) first; if it's unavailable or can't resolve the titles, fall back to
 * the live bidirectional 3-hop search. Result shape matches findPath, plus a
 * `source` field ('sdow' | 'live').
 */
async function findPathBest(fromTitle, toTitle, onProgress = ()=>{}){
  onProgress('Searching the full Wikipedia graph…');
  const sdow = await findPathSDOW(fromTitle, toTitle);
  if (sdow.status === 'found') return sdow;
  onProgress('Searching live links…');
  const live = await findPath(fromTitle, toTitle, onProgress);
  return { ...live, source: 'live' };
}

// Daily "featured" + "on this day" articles for the first-run launchpad.
async function fetchDailyFeed(){
  try {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${yyyy}/${mm}/${dd}`;
    const res = await wikiFetch(url);
    if (!res.ok) return { featured: null, onThisDay: [] };
    const data = await res.json();
    const featured = data.tfa?.titles?.normalized || data.tfa?.title || null;
    const seen = new Set();
    const onThisDay = [];
    if (Array.isArray(data.onthisday)) {
      for (const ev of data.onthisday) {
        const p = ev.pages && ev.pages[0];
        const title = p?.titles?.normalized || p?.title;
        if (title && title !== featured && !seen.has(title)) { seen.add(title); onThisDay.push(title); }
        if (onThisDay.length >= 4) break;
      }
    }
    return { featured, onThisDay };
  } catch {
    return { featured: null, onThisDay: [] };
  }
}

/**
 * Given a set of titles (e.g. the 20 neighbours of a page), return the directed
 * links that exist *among them* as [from, to] pairs. One request: prop=links is
 * restricted with pltitles to the same set, so each page only reports links that
 * land back inside the cluster. Titles are canonical neighbour titles already.
 */
async function fetchCrossLinks(titles){
  const set = (titles || []).slice(0, 50);
  if (set.length < 2) return [];
  const pairs = [];
  try {
    const joined = encodeURIComponent(set.join('|'));
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=links&pllimit=max&titles=${joined}&pltitles=${joined}`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const pages = data.query?.pages ? Object.values(data.query.pages) : [];
    for (const p of pages) {
      if (!p || !p.title || !Array.isArray(p.links)) continue;
      for (const l of p.links) {
        if (l.title && l.title !== p.title) pairs.push([p.title, l.title]);
      }
    }
  } catch {}
  return pairs;
}

/**
 * Resolve a list of article titles to their Wikidata entity ids in one batched
 * request (so galaxy-map typing doesn't depend on ids captured during page load,
 * which can be lost to a rate-limited request). Returns Map(title -> qid).
 */
async function fetchWikidataIds(titles){
  const map = new Map();
  const chunks = chunkArray((titles || []).slice(0, 200), 50);
  for (const ch of chunks) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(ch.join('|'))}`;
      const res = await wikiFetch(url);
      const data = await res.json();
      const pages = data.query?.pages ? Object.values(data.query.pages) : [];
      for (const p of pages) {
        const qid = p.pageprops?.wikibase_item;
        if (p.title && qid) map.set(p.title, qid);
      }
    } catch {}
  }
  return map;
}

/**
 * Batch-fetch the Wikidata "instance of" (P31) values for a list of entity ids.
 * Returns Map(qid -> [p31 qids]). Used to colour galaxy-map nodes by type.
 */
async function fetchInstanceTypes(ids){
  const result = new Map();
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return result;
  const chunks = chunkArray(unique, 50);
  for (const ch of chunks) {
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(ch.join('|'))}&props=claims&languages=en&format=json&origin=*`;
      const res = await wikiFetch(url);
      const data = await res.json();
      for (const qid of ch) {
        const claims = data.entities?.[qid]?.claims?.P31;
        const out = [];
        if (Array.isArray(claims)) {
          for (const c of claims) {
            const v = c.mainsnak?.datavalue?.value;
            if (v && v.id) out.push(v.id);
          }
        }
        result.set(qid, out);
      }
    } catch {}
  }
  return result;
}

async function getRandomTitle(){
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*`;
    const res = await wikiFetch(url);
    const data = await res.json();
    return data.query?.random?.[0]?.title || null;
  } catch {
    return null;
  }
}

export { wikiFetch, fetchSummary, getPageStar, getRandomTitle, fetchWikidataFacts, findPath, findPathBest, fetchDailyFeed, fetchCrossLinks, fetchWikidataIds, fetchInstanceTypes, summaryCache, starCache, fetchPageMetaBatch };
