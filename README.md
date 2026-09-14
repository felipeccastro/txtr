# Txtr

> Txtr is the future of text. From notes to Kanban.

Txtr is a text-first workspace — the lightness of a plain Markdown file,
with better navigation, organization, and portability. No accounts, no
schemas, no onboarding: open it and write.

It's a static PWA. There's no build step and no backend — `index.html`,
`styles.css`, and `scripts.js` are the whole app.

## Running it locally

```sh
make
```

This serves the app at `http://localhost:8777` (see `Makefile`). Any static
file server works too, e.g. `python3 -m http.server 8777`.

## Project layout

- `index.html` — markup and shell
- `styles.css` — all styling
- `scripts.js` — app logic: parsing, rendering, editing, storage
- `sw.js` — service worker (offline support, PWA install)
- `SPEC.txt` — the product spec and design philosophy this app follows

## Design philosophy

The guiding rule, from `SPEC.txt`:

> If plain text is easier, use plain text. Txtr should only exist where it
> makes working with that text better.

A Binder's content is Markdown-like text; the app is a live view onto that
text, not a separate data model bolted on top of it.
