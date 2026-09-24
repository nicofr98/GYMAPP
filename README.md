# GymApp

Offline workout logger for two people on one phone. Static files only: no
build step, no backend, and no dependencies.

## Install on your phone
1. Enable GitHub Pages: repo **Settings → Pages → Deploy from a branch →
   `master` / `(root)`**.
2. Open `https://nicofr98.github.io/GYMAPP/` on the phone.
   - iPhone (Safari): Share → **Add to Home Screen**.
   - Android (Chrome): menu → **Install app**.
3. In the app, go to **Settings → Import backup** and choose the
   `gymapp-backup-from-excel.json` file to load the weeks already logged.

After the first load it works with no signal.

## Using it
- The top buttons switch between people. The week and day stay the same, so
  you can alternate sets.
- The app opens on the day after the last one you logged.
- Grey numbers are last session's values: tap ✓ to log them, or adjust with
  −/+ first. The next set is highlighted, and supersets (A1/A2) alternate.
- `i` shows the notes, and ⇄ swaps in the substitute exercise.
- **Program** tab: edit exercises, reorder them, and start a new block.
- **Settings → Export backup** now and then. Data only lives on the phone.

## Development
Run the tests with `npm test` (needs Node 20+). The browser test needs a
one-time `npm install`; `npm run test:py` tests the Excel importer (needs
`pip install openpyxl`).

Serve the folder with any static server, e.g. `python3 -m http.server`, and
open `http://localhost:8000`.

When you change any file, bump `VERSION` in `sw.js` so installed copies pick
up the update.

`tools/import_xlsx.py` regenerates `js/default-program.js` from the Excel
sheet. It can also write a backup file with the logged weeks; never commit
that file.
