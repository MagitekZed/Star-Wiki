# WordSpace • Semantic Starfield

## What it is
An interactive "word universe" where you explore meaning by moving from one word to its nearest meanings—and a few intentionally far-off contrasts. It’s like flying through a semantic starfield: every word becomes a small galaxy of related ideas.

## Core use
- **Start anywhere.** Type a word to place it at the center.
- **See relationships.** Blue rays point to the most closely related words; optional red dashed rays highlight a handful of very distant/contrasting words to give perspective.
- **Explore by traveling.** Click any ray to “fly” to that word. The view re-centers there, showing its closest neighbors and a couple of contrasts. You can keep hopping, building an intuitive path through meaning.
- **Always know your way back.** The word you came from remains one of the rays, so you can easily step back.

## What it’s for
- **Sense-making:** Quickly grasp the semantic "neighborhood" around a term.
- **Discovery:** Find adjacent concepts, unexpected bridges, and useful contrasts.
- **Brainstorming & writing:** Generate alternatives, related themes, or oppositional angles.
- **Learning:** Explore vocabulary relationally—how ideas cluster, diverge, and connect.

## How it behaves (user perspective)
- The scene is clean and focused: one central word, its rays, and clickable labels—no cluttered cloud.
- Similarity is visualized: closer/clearer blue rays ≈ stronger relationship; red dashed rays = deliberate opposites/outsiders for contrast.
- Navigation feels physical: you move along a chosen connection, land, and a new star of meanings blooms around your destination.
- The experience is repeatable: the same word shows the same pattern of connections, so you can retrace or share discoveries.

## Run locally
```bash
cd wordmap-starfield
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy on GitHub Pages
- Push this folder to a repo root (e.g., `main`).
- Enable Pages for the root of `main` in repo settings.
- Visit the URL GitHub gives you.

## Files
- `index.html` – app shell
- `styles.css` – UI
- `app.js` – Three.js starfield, camera travel, re-root logic
- `data/` – toy dataset:
  - `words.json` – admissible words
  - `coords.json` – global 3-D coords per word (used only to orient rays deterministically)
  - `nn.json` – top-K similar neighbors with cosine-like scores
  - `far.json` – contrast picks (negative-ish scores)
  - `freq.json` – fake frequency ranks for node size

## Behavior
- **No global cloud.** Only the current **star** renders.
- **Travel along the clicked ray** (≈800ms), then re-root at the destination.
- Always inject a **return strand** (previous center) if missing from top-K, so navigation is symmetric.
- **Contrast rays** are dashed red; toggle via the checkbox.
- Labels appear on hover and in the sidebar; click entries in the sidebar to travel too.

## Swap in real data later
Keep the same shapes for a zero-code swap:
- `words.json` → `["apple","banana",...]`
- `coords.json` → `{ "apple":[x,y,z], ... }`  (from your once-run global PCA→3D)
- `nn.json` → `{ "apple":[["banana",0.78], ...], ... }` (K neighbors by cosine)
- `far.json` → `{ "apple":[["thermodynamics",-0.41], ...], ... }` (C far/negative, e.g. NN on −v)
- `freq.json` → `{ "apple": 134, ... }` (optional, for node size)

No backend required.
