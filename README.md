# Listening Diary

A personal dashboard built from my Spotify privacy export, covering every stream since August 2021. It's a static site with no framework and no build step, hosted on GitHub Pages.

## What's on the page

- **Time listened**: total hours, streams, songs, artists, active days, longest streak and skip rate, with a mosaic of the most-played covers.
- **Listening over time**: hours per month, coloured by genre family or language. Click a year to zoom in.
- **Top artists, songs and albums**: ranked by hours or plays. Click any row to play it in the Spotify embed.
- **Genres and languages**: a language mix per year, with languages guessed from song scripts, genres and the names of my own playlists.
- **How old is your music?**: listening hours by the year each song came out.
- **When you listen**: a weekday × hour heatmap in local time.
- **Shuffle and skipping**: how both have changed over the years.
- **Your eras**: each year's #1 artist and song. Click one to filter the whole page.
- **On repeat**: the most times one song was played in a single day.
- **Rediscover**: songs I loved but haven't played in a year.
- **How songs end, and devices**: phones, PC, TV, and listening abroad.
- **Library and playlists**: each playlist's language mix.
- **Every song**: a searchable, sortable table of every track.
- **Phone and app**: from the technical logs (last ~90 days): streaming quality, volume, offline downloads, daylists, On Repeat.
- **Wrapped 2025, unwrapped**: Spotify's numbers next to the raw data.
- **Only on this computer**: ad-targeting segments, searches and private-session stats. This panel reads `site/data/private.json`, which is git-ignored and never deployed.

A toggle hides sleep and ambient sounds (rain, white noise, sleep podcasts) so they don't drown out the music.

## Update it with a new export

1. Request **Account data**, **Extended streaming history** and **Technical log information** at <https://www.spotify.com/account/privacy/>.
2. Unzip the three folders next to this repo, so `../Spotify Extended Streaming History/` exists. Or pass `--data <folder>` to the scripts below.
3. Run:

```bash
node scripts/enrich.mjs   # genres, release years, cover art from the iTunes Search API (resumable; ~20 lookups/min)
node scripts/build.mjs    # writes site/data/*.json
node scripts/serve.mjs    # preview at http://localhost:5173
```

4. Commit `site/data` and `cache/itunes.json`, then push. The workflow in `.github/workflows/pages.yml` publishes `site/`.

Node 20+ is required. There are no npm dependencies; d3 is loaded from jsDelivr.

### What gets published

- **Never published:** the raw export, IP addresses, e-mail, postal address, birth date and payment details. The build doesn't copy any of them out.
- **Published:** the full play log, as listening time plus track. This includes private-session plays; to leave those out, run `node scripts/build.mjs --exclude-incognito`.
- **Local only:** `private.json`, which holds ad inferences and search history.

## Export the whole library for another agent

```bash
node scripts/discover-playlists.mjs   # rebuild followed / Spotify-made playlists from the app logs
node scripts/export-library.mjs       # library-export/: tracks.jsonl, library.json, CSVs, library.md, schema.json
```

Spotify's export only lists playlists you created. `discover-playlists.mjs` recovers the ones you follow, plus Spotify-made ones, from the technical logs. It covers only the last few months, and only the songs that appeared there, so each playlist carries a `coverage` figure.

Every song becomes one parsed record. Each has a clean title, version, featured artists and the film it's from, plus language (with its source and confidence), genre, year, playlists, liked status and play stats. See `library-export/README.md` for the fields. The output stays local because it's git-ignored.

## Get the music: `scripts/acquire.mjs`

Builds a list of every song, in this priority order:

1. **Playlists first**, with the most-played playlist on top.
2. **Liked songs.**
3. **Most-played songs.**

For each song it shows free links to JioSaavn and YouTube Music (free with ads, offline in the app), a Bandcamp search (many free or name-your-price downloads), and the iTunes price in INR if you want a file to keep.

```bash
node scripts/acquire.mjs                                # acquire/shopping-list.html + .csv
node scripts/acquire.mjs --music "D:\Music"             # tick off songs already in your folder + playlists as .m3u8
node scripts/acquire.mjs --music "D:\Music" --to-mp3    # convert m4a/flac in that folder to 320 kbps MP3 (needs ffmpeg)
```

It doesn't bulk-rip songs from YouTube or Spotify.
