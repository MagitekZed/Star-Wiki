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
  return fetch(url, { headers: { 'Api-User-Agent': 'StarWiki/1.0 (https://example.com)' } });
}

async function fetchSummary(title){
  if (summaryCache.has(title)) return summaryCache.get(title);
  const info = { title, extract: '', thumbnail: null };
  summaryCache.set(title, info);
  try {
    const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) info.title = data.title;
      if (data.extract) info.extract = data.extract;
      if (data.thumbnail?.source) info.thumbnail = data.thumbnail.source;
    }
  } catch {}
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

export { wikiFetch, fetchSummary, getPageStar, summaryCache, starCache, fetchPageMetaBatch };
