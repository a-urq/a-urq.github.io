# Amelia Urquhart’s Personal Website

This repository is a static GitHub Pages site. The Chess Boardroom lives in `chess-boardroom/` and is served as a client-side page; no Flask/Python server is needed on GitHub Pages.

## Chess Boardroom development

- Install dependencies with `npm install`.
- Rebuild the self-contained browser bundle with `npm run build:chess`. This embeds `chess-boardroom/games/example-game.pgn`, so edits to the default game require rebuilding.
- Commit `chess-boardroom/app.js` along with source changes because GitHub Pages serves static files and does not run this build command automatically.

The page uses bundled `chess.js` and `gifenc` packages for PGN replay and local animated GIF encoding. FEN rendering and attack-map colors work in the browser. PGN imports are stored in that browser’s local storage; they are not uploaded or committed to the website. Export downloads a metadata-labeled PNG of the current position or a metadata-labeled GIF of the selected game to the visitor’s device.

The chess-piece SVG artwork is adapted from python-chess and carries its GPL-3.0-or-later license; third-party details are in `chess-boardroom/THIRD_PARTY_NOTICES.md`.

The included anonymized Lichess PGN is selected and displayed as the default replay on every page load, ahead of browser-imported games. The rest of the site links to the Boardroom at `./chess-boardroom/`.
