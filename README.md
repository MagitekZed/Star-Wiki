# StarWiki — explore Wikipedia as a galaxy

### ▶ **[Open StarWiki](https://magitekzed.github.io/Star-Wiki/)**  ·  *where every link has gravity*

StarWiki turns Wikipedia into a 3D starfield you drift through one link at a time. Every
article is a glowing star; its most‑related links orbit it as rays. Travel along a ray to
the next page and fall down the rabbit hole — then zoom out to see your whole journey
charted as a constellation.

No backend, no sign‑up, nothing to install — it's a static page that pulls live data from
the Wikipedia and Wikidata APIs and renders it with [Three.js](https://threejs.org/).

> A passion / portfolio project, built for the joy of wandering — not for clicks, accounts,
> or retention. Poke around and see where you end up.

## Try this first

1. **Search** a topic you like — or hit **Surprise me** for a random one.
2. **Tap a star** to peek at it, then **tap the card** to fly there.
3. Keep going. The **green** spoke points to where you're headed; the **red** one leads back.
4. Open the **galaxy map** (the constellation icon) to see everywhere you've been.
5. Or use **Find a path** to connect any two articles — and watch the camera fly the route.

## Getting around

- **Tap to travel.** Tap a star or ray to preview it, then tap the card to fly there. Drag
  to orbit, scroll / pinch to zoom.
- **Spoke colours.** Green = forward (your next stop), red = back (where you came from),
  gold = a branch you've already explored. Everything else is blue, ranked by relevance
  (via the Wikipedia `morelike:` search), with brighter rays for closer matches.
- **Breadcrumbs.** The bar up top tracks your trail; **← / →** step through it and any crumb
  flies you straight there — the camera glides one continuous flight through every stop in
  between, rather than cutting a straight line.
- **Find a path.** Instant shortest paths between any two articles via
  [Six Degrees of Wikipedia](https://www.sixdegreesofwikipedia.com/) (a precomputed link
  graph of all of Wikipedia), with a live bidirectional link‑walk as a fallback. Then fly
  the whole route.
- **Search · Surprise me · Daily launchpad.** Jump anywhere, roll a random article, or start
  from the day's featured / "on this day" picks on the welcome screen.

## The galaxy map

Zoom out from a single cluster to your **entire journey** as a constellation:

- **Size** — each stop grows with how many of your *other* stops it links to, so the hub of
  your rabbit hole pops out (the most‑connected one gets a corona).
- **Colour** — nodes are tinted by their Wikidata "instance of" type (person, place,
  organization, event, work, species, concept).
- **Edges** — solid lines are paths you've travelled (your route *and* any side‑branches);
  dashed lines reveal other links between your stops.
- **Tap any node** for an info popup (type, connections, length, categories) with a
  **Travel here** button. Faraway nodes simplify to dim points so long journeys stay smooth.

## Journeys & sharing

- **Shareable links** — your path lives in the URL hash, so a link reopens the exact journey.
- **Saved journeys** — bookmark a route to revisit later.
- **Snapshot** — download a PNG of the current view.
- **Start over / recenter** — back to the welcome screen, or re‑centre the camera.

## Craft

- Selective **bloom** so bright stars and rays glow without the faint cross‑links flaring.
- Nebula backdrop, parallax starfield, twinkle, flowing "comet" dots, a hero corona on the
  current page, and a cinematic fly‑through for multi‑stop jumps.
- Respects **`prefers-reduced-motion`**, adapts to mobile (bottom sheet + tap‑to‑expand
  legend), prefetches on hover, and throttles the frame rate when idle.
- **Polite API use** — requests are throttled and cached in‑memory, sent with a descriptive
  `Api-User-Agent`.

## Under the hood

A static site, no build step. Three.js is loaded from a CDN via an import map.

| File | Role |
| --- | --- |
| `index.html` | Markup, SVG icon defs, import map |
| `styles.css` | All styling |
| `wikipedia.js` | Live data: links, relevance, summaries, Wikidata facts/types, cross‑links, path‑finding |
| `graphics.js` | Three.js scene, travel/flight animation, galaxy map, walk‑based navigation, sidebar, sharing |
| `layout.js` | DOM wiring (search, menus, path modal, keyboard) |

## Run locally

Any static HTTP server works — no build, no dependencies:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Credits & attribution

- Article content & metadata: **[Wikipedia](https://wikipedia.org)** and
  **[Wikidata](https://www.wikidata.org)**, under
  [CC BY‑SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Pathfinding: **[Six Degrees of Wikipedia](https://www.sixdegreesofwikipedia.com/)** by
  Jacob Wenger (open‑source).
- Rendering: **[Three.js](https://threejs.org/)**.

StarWiki is an independent project and is **not affiliated with or endorsed by the Wikimedia
Foundation**.
