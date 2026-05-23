# StarWiki • Wikipedia Rabbit Hole Explorer

StarWiki turns Wikipedia into a 3D starfield you can drift through one link at a time. Every article is a glowing star; its most related links orbit around it as rays. Click a ray to fly to the next page and fall down the rabbit hole — then zoom out to see the whole journey as a constellation.

It's a static site with **no backend** — pages, links, and metadata are fetched live from the Wikipedia and Wikidata APIs and rendered with [Three.js](https://threejs.org/).

## Exploring

- **Click to travel.** Hover a ray or star to see its title, click it for a quick preview, then click the preview to fly there. The pink **return ray** always leads back to the page you came from.
- **Relevance‑ranked links.** Each page shows up to ~20 outgoing links, ordered by relevance (via the Wikipedia `morelike:` search), with brighter rays for closer matches.
- **Trail.** The pages you've visited stay behind as a faint glowing trail of ghost clusters, so you can see where you've been.
- **Breadcrumbs & keys.** A breadcrumb bar tracks your path; **← / →** step back and forward through it, and any crumb jumps straight there.
- **Search · Surprise me · Daily launchpad.** Jump to any article, roll a random one, or start from the day's featured / "on this day" articles on the welcome screen.
- **Find a path.** Discover a chain of links between two articles — up to **3 links** via a bidirectional "meet in the middle" search — then fly the whole route.

## The galaxy map

Zoom out from a single cluster to your **entire journey** as a constellation:

- **Size by relation** — each stop is sized by how many of your *other* visited articles it links with; the most‑connected hub gets a corona, so the centre of gravity of your rabbit hole pops out.
- **Colour by type** — nodes are tinted by their Wikidata "instance of" type (person, place, organization, event, work, species, concept).
- **Interlinks** — faint lines reveal which of your stops actually link to one another, not just the route you walked.
- **Click any node** for an info popup (type, connections, length, categories) with a **Travel here** button.

The map zooms out smoothly while the spokes fade away, "focuses in" as the data lands, and zooms back to your current page before flying the normal travel animation when you pick a destination.

## Visual encoding (cluster view)

- **Node colours by type.** Neighbour stars use the same Wikidata‑type palette as the map, and each ray fades from blue at the hub to its target's type colour toward the tip.
- **Star size by article length** (optional, in *View options*).
- **Cross‑links** (optional toggle) — a faint web showing how the current page's neighbours relate to each other.
- **Legends.** A collapsible "Node types" key (bottom‑left, expands on hover) in the cluster view, and a fuller legend in the map.
- **Wikidata facts & categories** for the current article in the sidebar, plus a filterable / sortable neighbour list.

## Journeys & sharing

- **Shareable links** — your path lives in the URL hash, so a link reopens the exact journey.
- **Saved journeys** — bookmark a route to revisit later.
- **Snapshot** — download a PNG of the current view.
- **Start over / recenter** — reset to the welcome screen or re‑centre the camera.

## Craft

- **Selective bloom** so the bright stars and rays glow without the faint cross‑links flaring near the core.
- Nebula backdrop, parallax starfield, twinkle, flowing "comet" dots, and a hero corona on the current page.
- **Respects `prefers-reduced-motion`**, adapts to mobile (bottom sheet), prefetches on hover, and throttles the frame rate when idle.
- **Polite API use** — requests are throttled and cached in‑memory, and sent with a descriptive `Api-User-Agent`.

## Architecture

A static site, no build step. Three.js is loaded from a CDN via an import map.

| File | Role |
| --- | --- |
| `index.html` | Markup, SVG icon defs, import map |
| `styles.css` | All styling |
| `wikipedia.js` | Live data: links, relevance, summaries, Wikidata facts/types, cross‑links, path‑finding |
| `graphics.js` | Three.js scene, travel/animation, galaxy map, interaction, sidebar, sharing |
| `layout.js` | DOM wiring (search, menus, path modal, keyboard) |

## Running locally

Any static HTTP server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Attribution

Content is from [Wikipedia](https://wikipedia.org) and [Wikidata](https://www.wikidata.org), available under [CC BY‑SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). StarWiki is an independent project and is **not affiliated with or endorsed by the Wikimedia Foundation**.
