# StarWiki • Wikipedia Rabbit Hole Explorer

StarWiki is an interactive starfield that lets you drift through Wikipedia one link at a time.  Each page is drawn as the centre of a tiny universe with up to twenty outgoing article links orbiting around it.  Click any ray to fly to the linked page and continue the journey.

## Features
- **Live data** – pages and links are fetched on demand from the Wikipedia API (no pre‑computed files).
- **Deterministic layout** – neighbour positions are derived from their titles so returning to a page looks the same.
- **Return strand** – the page you came from is always included so you can hop back.
- **Caching and throttling** – polite API usage and instant revisits.
- **Wikipedia search** – type to search for any article and re‑centre on it.

## Running locally
The project is a static site; any HTTP server will do:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Attribution
Content from [Wikipedia](https://wikipedia.org) is available under the [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) license.

## Source layout

All application code now lives under `src/` and is split into small modules:

- `data/` – remote data fetching and caching.
- `core/` – global state, constants, math helpers and Three.js scene setup.
- `graph/` – star/edge construction, layout, travel animation and trail handling.
- `ui/` – DOM driven pieces such as the sidebar, preview modal and breadcrumbs.
- `input/` – mouse and keyboard wiring plus hover picking.

`app.js` ties everything together and exposes the public API used by the UI handlers.
