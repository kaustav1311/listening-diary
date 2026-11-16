#!/usr/bin/env node
// Adds what the Spotify export leaves out (genre, release year, cover art,
// store price/link) by looking tracks and artists up in the public iTunes
// Search API. No key needed. Results are cached in cache/itunes.json, so the
// script is resumable: stop it any time (Ctrl+C) and run it again later.
//
//   node scripts/enrich.mjs                 # playlists, liked songs, top 2500 tracks, top 800 artists
//   node scripts/enrich.mjs --tracks 5000 --artists 1500
//   node scripts/enrich.mjs --country us    # store front for prices (default: in)
//
// Order: playlist songs first, then liked songs, then everything else by how
// much you've played it. Only artist and track names are sent to Apple.
import { exportDir, streams, rank, account } from './lib/export.mjs';
import { loadCache, saveCache, client } from './lib/itunes.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const MAX_TRACKS = +arg('tracks', 2500);
const MAX_ARTISTS = +arg('artists', 800);
const COUNTRY = arg('country', 'in').toLowerCase();

const cache = loadCache(COUNTRY);
const api = client(COUNTRY);
let dirty = 0;
process.on('SIGINT', () => {
  saveCache(cache);
  console.log('\nSaved cache. Run again to continue.');
  process.exit(0);
});

const dir = exportDir();
const { tracks, artists } = rank(streams(dir));

const boost = new Map();
const lib = account(dir, 'YourLibrary') || {};
for (const t of lib.tracks || []) boost.set(t.uri, { uri: t.uri, name: t.track, artist: t.artist, album: t.album, prio: 1e12 });
for (const p of (account(dir, 'Playlist1') || {}).playlists || [])
  for (const it of p.items || [])
    if (it.track?.trackUri)
      boost.set(it.track.trackUri, { uri: it.track.trackUri, name: it.track.trackName, artist: it.track.artistName, album: it.track.albumName, prio: 1e13 });

const want = new Map([...tracks.values()].sort((a, b) => b.ms - a.ms).slice(0, MAX_TRACKS).map((t) => [t.uri, t]));
for (const [uri, t] of boost) if (!want.has(uri)) want.set(uri, { ...t, ms: tracks.get(uri)?.ms || 0 });
const topArtists = [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ARTISTS);

// One queue, ordered by priority then listening time.
const jobs = [
  ...[...want.values()]
    .filter((t) => !cache.tracks[t.uri] && t.name && t.artist)
    .map((t) => ({ kind: 'track', w: t.ms + (boost.get(t.uri)?.prio || 0), t })),
  ...topArtists.filter(([a]) => a && !cache.artists[a]).map(([a, ms]) => ({ kind: 'artist', w: ms * 0.6, a })),
].sort((x, y) => y.w - x.w);

const total = jobs.length;
console.log(
  `iTunes (${COUNTRY}) enrichment: ${Object.keys(cache.tracks).length} tracks + ${Object.keys(cache.artists).length} artists cached, ${total} to go` +
    (total ? ` (~${Math.ceil((total * 2.6) / 60)} min)` : '')
);

let done = 0;
let hits = 0;
for (const job of jobs) {
  const res = job.kind === 'track' ? await api.track(job.t) : await api.artist(job.a);
  done++;
  if (res) {
    if (job.kind === 'track') cache.tracks[job.t.uri] = res;
    else cache.artists[job.a] = res;
    if (!res.miss) hits++;
    dirty++;
  }
  if (dirty >= 20) {
    saveCache(cache);
    dirty = 0;
  }
  if (done % 50 === 0 || done === total)
    console.log(`  ${done}/${total}  matched ${hits}  (${job.kind}: ${job.kind === 'track' ? job.t.name : job.a})`);
}
saveCache(cache);
console.log('Done. Now run: node scripts/build.mjs');
