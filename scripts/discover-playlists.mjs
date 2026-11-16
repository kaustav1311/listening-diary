#!/usr/bin/env node
// Spotify's privacy export only lists playlists you created (Playlist1.json).
// Playlists you follow, collaborative ones someone else owns, and Spotify-made
// mixes are missing. This rebuilds them from the Technical Log Information:
//
//   ShuffleSequenceEvent   up to 50 songs per shuffle + the playlist's total size
//   ConductorEvent         every song that started playing from a playlist
//   ContextPlayerCommand   the song playing when you pressed play/pause/skip
//   AddedToPlaylist / AddToPlaylist / RemovedFromPlaylist   your edits
//   ListPlayerEvent        playlist sizes
//
// Names come from Spotify's public oEmbed endpoint (only the playlist id is sent).
// Logs cover roughly the last 90-180 days, so older playlists can't be recovered,
// and big playlists are only partly known ("coverage" says how much).
//
//   node scripts/discover-playlists.mjs [--data <export dir>] [--no-names]
//   -> cache/discovered-playlists.json   (git-ignored; read by export-library.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, exportDir, tech, account, streams } from './lib/export.mjs';
import { norm } from './lib/match.mjs';

const dir = exportDir();
const OUT = path.join(ROOT, 'cache', 'discovered-playlists.json');
const NAMES = path.join(ROOT, 'cache', 'playlist-names.json');
const FETCH_NAMES = !process.argv.includes('--no-names');

const lists = new Map();
const get = (uri) => {
  if (!uri || !uri.startsWith('spotify:playlist:')) return null;
  if (!lists.has(uri))
    lists.set(uri, { uri, id: uri.split(':')[2], tracks: new Map(), removed: new Set(), size: 0, starts: 0, shuffles: 0, edits: 0, first: null, last: null });
  return lists.get(uri);
};
const seen = (p, ts) => {
  if (!ts) return;
  if (!p.first || ts < p.first) p.first = ts;
  if (!p.last || ts > p.last) p.last = ts;
};
const addTrack = (p, uri, how, ts, pos) => {
  if (!uri || !uri.startsWith('spotify:track:')) return;
  const t = p.tracks.get(uri) || { uri, how: new Set(), pos: null, added: null };
  t.how.add(how);
  if (pos != null && t.pos == null) t.pos = pos;
  if (how === 'added' && ts && (!t.added || ts < t.added)) t.added = ts;
  p.tracks.set(uri, t);
};

for (const e of tech(dir, 'ShuffleSequenceEvent')) {
  const p = get(e.message_context_uri);
  if (!p) continue;
  p.shuffles++;
  p.size = Math.max(p.size, e.message_play_context_length || 0);
  seen(p, e.timestamp_utc);
  const pos = e.message_shuffled_sequence_original_position || [];
  (e.message_shuffled_sequence || []).forEach((u, i) => addTrack(p, u, 'shuffle', e.timestamp_utc, pos[i]));
}
for (const e of tech(dir, 'ConductorEvent')) {
  const p = get(e.message_list_uri);
  if (!p) continue;
  if (e.message_event === 'clip-started') p.starts++;
  seen(p, e.timestamp_utc);
  addTrack(p, e.message_item_uri, 'played', e.timestamp_utc);
}
for (const e of tech(dir, 'ContextPlayerCommandEvent')) {
  const p = get(e.message_current_context_context_uri);
  if (!p) continue;
  seen(p, e.timestamp_utc);
  addTrack(p, e.message_current_context_track_uri, 'played', e.timestamp_utc);
}
for (const e of tech(dir, 'ListPlayerEvent')) {
  const p = get(e.message_list_uri);
  if (!p) continue;
  p.size = Math.max(p.size, e.message_unfiltered_count || 0, e.message_number_of_items || 0);
  seen(p, e.timestamp_utc);
}
for (const e of tech(dir, 'AddedToPlaylist')) {
  const p = get(e.message_playlist_uri);
  if (!p) continue;
  p.edits++;
  seen(p, e.timestamp_utc);
  addTrack(p, e.message_item_uri, 'added', e.timestamp_utc);
}
for (const e of tech(dir, 'AddToPlaylist')) {
  const p = get(e.message_playlist_uri);
  if (!p) continue;
  p.edits++;
  seen(p, e.timestamp_utc);
  for (const u of e.message_item_uris || []) addTrack(p, u, 'added', e.timestamp_utc);
}
for (const e of tech(dir, 'RemovedFromPlaylist')) {
  const p = get(e.message_playlist_uri);
  if (p) p.removed.add(e.message_item_uri);
}

// Keep playlists you actually used: played from, shuffled or edited.
const used = [...lists.values()].filter((p) => p.starts || p.shuffles || p.edits);

// Names via oEmbed, cached.
const names = fs.existsSync(NAMES) ? JSON.parse(fs.readFileSync(NAMES, 'utf8')) : {};
if (FETCH_NAMES) {
  const todo = used.filter((p) => !(p.id in names));
  if (todo.length) console.log(`Looking up ${todo.length} playlist names…`);
  for (const p of todo) {
    try {
      const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${p.id}`)}`);
      names[p.id] = r.ok ? (await r.json()).title || null : null; // 404 = private or deleted
    } catch {
      continue; // offline: try again next run
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  fs.writeFileSync(NAMES, JSON.stringify(names, null, 1));
}

// Titles for songs you've never played and never saved: oEmbed gives the title
// (not the artist). Only for playlists that aren't auto-generated radios.
const TITLES = path.join(ROOT, 'cache', 'track-titles.json');
const titles = fs.existsSync(TITLES) ? JSON.parse(fs.readFileSync(TITLES, 'utf8')) : {};
if (FETCH_NAMES) {
  const known = new Set(streams(dir).map((r) => r.spotify_track_uri).filter(Boolean));
  for (const t of (account(dir, 'YourLibrary') || {}).tracks || []) known.add(t.uri);
  for (const p of ((account(dir, 'Playlist1') || {}).playlists) || []) for (const i of p.items || []) known.add(i.track?.trackUri);
  const todo = [
    ...new Set(
      used
        .filter((p) => !/ Radio$/.test(names[p.id] || ''))
        .flatMap((p) => [...p.tracks.keys()])
        .filter((u) => !known.has(u) && !(u in titles))
    ),
  ];
  if (todo.length) console.log(`Looking up ${todo.length} song titles…`);
  let n = 0;
  for (const u of todo) {
    try {
      const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${u.split(':')[2]}`)}`);
      titles[u] = r.ok ? (await r.json()).title || null : null;
    } catch {
      continue;
    }
    if (++n % 50 === 0) fs.writeFileSync(TITLES, JSON.stringify(titles));
    await new Promise((r) => setTimeout(r, 300));
  }
  fs.writeFileSync(TITLES, JSON.stringify(titles));
}

const exported = new Set((((account(dir, 'Playlist1') || {}).playlists) || []).map((p) => norm(p.name)));
const out = used
  .map((p) => {
    const tracks = [...p.tracks.values()].filter((t) => !p.removed.has(t.uri));
    tracks.sort((a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9));
    const name = names[p.id] ?? null;
    const spotifyMade = p.id.startsWith('37i9dQZ');
    return {
      id: p.id,
      uri: p.uri,
      url: `https://open.spotify.com/playlist/${p.id}`,
      name,
      kind: spotifyMade ? 'spotify_made' : 'user_or_followed',
      in_spotify_export: !!name && exported.has(norm(name)),
      size: p.size || null,
      known_tracks: tracks.length,
      coverage: p.size ? +Math.min(1, tracks.length / p.size).toFixed(2) : null,
      plays_from_it: p.starts,
      shuffles: p.shuffles,
      edits: p.edits,
      first_seen: p.first?.slice(0, 10) || null,
      last_seen: p.last?.slice(0, 10) || null,
      tracks: tracks.map((t) => ({ uri: t.uri, position: t.pos != null ? t.pos + 1 : null, how: [...t.how].sort(), added: t.added?.slice(0, 10) || null, title: titles[t.uri] ?? undefined })),
    };
  })
  .sort((a, b) => b.plays_from_it + b.shuffles * 5 - (a.plays_from_it + a.shuffles * 5));

fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), log_window: [out.map((p) => p.first_seen).filter(Boolean).sort()[0], out.map((p) => p.last_seen).filter(Boolean).sort().pop()], playlists: out }, null, 1));

const missing = out.filter((p) => !p.in_spotify_export);
console.log(`${out.length} playlists used in the logs; ${out.length - missing.length} are in Spotify's export, ${missing.length} are not:`);
for (const p of missing.slice(0, 40))
  console.log(`  ${(p.name || '(private or deleted)').padEnd(42).slice(0, 42)} ${p.kind === 'spotify_made' ? 'Spotify-made' : 'yours/followed'}  ${p.known_tracks}${p.size ? `/${p.size}` : ''} songs  ${p.plays_from_it} plays`);
console.log(`Wrote ${OUT}`);
