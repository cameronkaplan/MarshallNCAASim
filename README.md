# Marshall NCAA Tournament Simulator

Static simulator for Marshall's NCAA pool using:

- The `NCAA_2026_Teams.xlsx` roster workbook in this repo.
- The 2026 [Boxscorus March Madness page](https://www.boxscorus.com/ncaab/march-madness) as the tournament snapshot.

## What it does

- Maps every participant in the workbook to their owned teams.
- Simulates the remaining tournament using Marshall's scoring rules.
- Tracks first-place ties separately from outright winners.
- Identifies second place by the next distinct score below first.
- Lets you lock a game to either a specific team or an unresolved upstream slot winner.
- Exports both a participant summary CSV and a full simulation-by-simulation score matrix.

## Files

- `scripts/build_data.py`: rebuilds the data bundle from the workbook and Boxscorus snapshot.
- `index.html`: the static UI.
- `simulator-core.js`: the Monte Carlo engine.
- `app.js`: the browser UI logic.
- `app-data.js`: generated data bundle used by the page.
- `data/marshall-simulator-data.json`: generated JSON version of the same data.

## Rebuild the data bundle

If you already have a local HTML snapshot:

```bash
python3 scripts/build_data.py --html /tmp/boxscorus_march_madness.html
```

To fetch a fresh Boxscorus page and save it as the local snapshot:

```bash
python3 scripts/build_data.py --refresh
```

## Open the site

Open `index.html` in a browser. The page is self-contained and loads its data from `app-data.js`, so it does not need a local web server.

## Notes

- The simulator uses Boxscorus-published round-of-64 probabilities when they are directly available in the snapshot.
- All later open games use an Elo-based win model calibrated from the Boxscorus team ratings embedded in the same snapshot.
- First Four games do not score in Marshall's pool.
