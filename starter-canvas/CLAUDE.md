# Canvas conventions

This folder is the Canvas: a website that changes in response to Prompts sent by Players. Several Runs edit it in parallel and their changes are combined, so follow these conventions to keep features from colliding.

## Plain files, no build step

- Write plain HTML, CSS and JavaScript modules (`<script type="module">`). There is no build step: no bundler, no TypeScript, no `npm install`. The files are served exactly as committed.
- Load libraries and fonts from CDNs. Register JavaScript libraries in the import map in `index.html` (`<script type="importmap">`) and import them by name, e.g. add `"canvas-confetti": "https://esm.sh/canvas-confetti@1"` and `import confetti from "canvas-confetti";`.

## One folder per feature

- Every feature lives in its own folder under `features/<feature-name>/`, holding all of its HTML, CSS, JS and assets. See `features/hello/` for an example.
- Change other features' folders only when the Prompt is about them.
- `index.html` is the entry page and only lists features: the title, the import map, the shared stylesheet, and one `<section id="<feature-name>" class="feature">` per feature that pulls in that feature's stylesheet and module. Don't put feature code in it.

## Shared styling through theme variables

- `theme.css` defines a small set of theme variables (`--color-*`, `--font-*`, `--radius`, `--space`). Features use them rather than hard-coded colours and fonts, so the whole Canvas can be restyled in one place.
- Change the theme variables only when the Prompt asks for an overall look change.

## The platform script

- The platform injects its own script into every page it serves (the "changing the page" banner and automatic reload). Don't try to edit, remove or work around it.
