#!/usr/bin/env node
// Exports every liked song and every playlist track as clean, parsed,
// machine-readable records that another agent (or a spreadsheet) can use.
//
//   node scripts/export-library.mjs [--data <export dir>] [--out <dir>]
//
// Writes to library-export/ (git-ignored):
//   tracks.jsonl    one JSON record per unique song, in priority order   <- best for agents
//   library.json    { meta, playlists, liked, tracks } in one document
//   tracks.csv      the same records, flattened (arrays joined with " | ")
//   playlists.csv   one row per playlist entry, in playlist order
//   library.md      human-readable: summary, every playlist, liked songs by language
//   schema.json     JSON Schema for a track record
//   README.md       field guide for agents
//
// Run scripts/build.mjs first: artist-level language/genre come from
// site/data/catalog.json so the export agrees with the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, exportDir, streams, account } from './lib/export.mjs';
import { loadCache } from './lib/itunes.mjs';
import { yearOutliers } from './lib/match.mjs';
import { scriptOf, scriptLang, genreLang, playlistHint, titleWordsLang, knownArtistLang, family } from './lib/classify.mjs';

const argv = process.argv;
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > -1 ? argv[i + 1] : d;
};
const OUT = path.resolve(arg('out', path.join(ROOT, 'library-export')));
const dir = exportDir();
const itunes = loadCache();
const catalogPath = path.join(ROOT, 'site', 'data', 'catalog.json');
if (!fs.existsSync(catalogPath)) {
  console.error('site/data/catalog.json not found. Run: node scripts/build.mjs');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const artistInfo = new Map(
  catalog.artists.map(([name, g, l, sleep]) => [name, { genre: g >= 0 ? catalog.genres[g] : null, lang: l >= 0 ? catalog.languages[l] : null, sleep: !!sleep }])
);

// ------------------------------------------------------------ parsing
const VERSION_RX =
  /remaster|version|\bedit\b|\bmix\b|remix|\blive\b|acoustic|unplugged|extended|slowed|reverb|lo-?fi|sped up|instrumental|reprise|radio|\bmono\b|stereo|\bdemo\b|\bcover\b|\bflip\b|rework|bootleg|mashup|deluxe|bonus|unreleased|session|karaoke|female|\bmale\b|duet|recreated|refix|\bvip\b|\bsad\b|lofi|8d audio|piano|orchestral|english|japanese|korean|hindi|spanish/i;

function splitNames(s) {
  return s
    .split(/\s*,\s*|\s+&\s+|\s+(?:and|x|X|×)\s+/)
    .map((x) => x.replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean);
}

export function parseTitle(raw = '') {
  let t = ` ${raw} `;
  const featured = [];
  const versions = [];
  let film = null;
  // (feat. A, B) / [with C]
  t = t.replace(/[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi, (_, n) => (featured.push(...splitNames(n)), ' '));
  // (From "Movie") / - From "Movie"
  t = t.replace(/[([]\s*from\s+(?:the\s+)?["“']?([^)\]"”']+?)["”']?\s*(?:\(.*?\))?\s*[)\]]/gi, (_, m) => ((film = m.trim()), ' '));
  t = t.replace(/\s+-\s+from\s+(?:the\s+)?["“']([^"”']+)["”'].*$/i, (_, m) => ((film = m.trim()), ' '));
  // trailing " - Remastered 2011", " - Ghazal Version", " - Vini Vici Remix"
  t = t.replace(/\s+-\s+([^-]+?)\s*$/, (m, v) => (VERSION_RX.test(v) ? (versions.push(v.trim()), ' ') : m));
  // bracketed versions: (Acoustic), [Slowed + Reverb], (Duet)
  t = t.replace(/[([]([^)\]]*)[)\]]/g, (m, v) => (VERSION_RX.test(v) && !/^pt\.?\s*\d|^part\s*\d/i.test(v) ? (versions.push(v.trim()), ' ') : m));
  // bare " feat. X" at the end
  t = t.replace(/\s+(?:feat\.?|ft\.?)\s+(.+)$/i, (_, n) => (featured.push(...splitNames(n)), ' '));
  return { title: t.replace(/\s+/g, ' ').trim() || raw.trim(), featured, version: versions.join('; ') || null, film };
}

function filmFromAlbum(album = '') {
  const m = album.match(/^(.*?)\s*[([]\s*(?:original\s+)?(?:motion picture\s+)?(?:soundtrack|ost|original score)[^)\]]*[)\]]\s*$/i) || album.match(/^(.*?)\s*[([]\s*from\s+["“']?([^)\]"”']+)/i);
  if (!m) return null;
  return (m[2] || m[1]).trim() || null;
}

// ------------------------------------------------------------ gather
const rows = streams(dir).filter((r) => r.spotify_track_uri);
const stats = new Map();
for (const r of rows) {
  let s = stats.get(r.spotify_track_uri);
  if (!s)
    stats.set(
      r.spotify_track_uri,
      (s = { ms: 0, plays: 0, skips: 0, first: r.ts, last: r.ts, privatePlays: 0, name: r.master_metadata_track_name, artist: r.master_metadata_album_artist_name, album: r.master_metadata_album_album_name })
    );
  s.ms += r.ms_played;
  if (r.ms_played >= 30000) s.plays++;
  if (r.reason_end === 'fwdbtn') s.skips++;
  if (r.incognito_mode) s.privatePlays++;
  if (r.ts < s.first) s.first = r.ts;
  if (r.ts > s.last) s.last = r.ts;
}

const library = account(dir, 'YourLibrary') || {};
const rawPlaylists = (account(dir, 'Playlist1') || {}).playlists || [];
const hours = (uri) => (stats.get(uri)?.ms || 0) / 3.6e6;

// Playlists ordered like scripts/acquire.mjs: most-played playlist first.
const playlists = rawPlaylists
  .map((p) => ({
    name: p.name,
    modified: p.lastModifiedDate || null,
    followers: p.numberOfFollowers ?? null,
    items: (p.items || []).filter((i) => i.track?.trackUri).map((i, n) => ({ uri: i.track.trackUri, name: i.track.trackName, artist: i.track.artistName, album: i.track.albumName, added: i.addedDate || null, position: n + 1 })),
    other: (p.items || []).filter((i) => !i.track?.trackUri).length,
    source: 'spotify_export',
    kind: 'yours',
  }))
  .map((p) => ({ ...p, hours: p.items.reduce((h, t) => h + hours(t.uri), 0) }))
  .sort((a, b) => b.hours - a.hours || b.items.length - a.items.length);

// Playlists Spotify's export leaves out (followed, Spotify-made), rebuilt from the
// app logs by scripts/discover-playlists.mjs. Song radios are skipped unless asked.
const INCLUDE_RADIO = argv.includes('--include-radio');
const discPath = path.join(ROOT, 'cache', 'discovered-playlists.json');
const likedSet = new Set((library.tracks || []).map((t) => t.uri));
const recovered = (fs.existsSync(discPath) ? JSON.parse(fs.readFileSync(discPath, 'utf8')).playlists : [])
  .filter((p) => !p.in_spotify_export && (INCLUDE_RADIO || !/ Radio$/.test(p.name || '')))
  .map((p) => {
    const likedShare = p.tracks.filter((t) => likedSet.has(t.uri)).length / Math.max(1, p.tracks.length);
    const name = p.name || (likedShare > 0.7 ? 'Liked Songs (Smart Shuffle / Enhance view)' : '(private playlist)');
    return {
      name,
      modified: p.last_seen,
      source: 'app_logs',
      kind: p.kind === 'spotify_made' ? 'spotify_made' : 'followed',
      url: p.url,
      size: p.size,
      coverage: p.coverage,
      plays: p.plays_from_it,
      hours: 0,
      items: p.tracks.map((t, n) => ({ uri: t.uri, title: t.title, added: t.added, position: t.position ?? n + 1 })),
    };
  });
if (!fs.existsSync(discPath)) console.log('Tip: run scripts/discover-playlists.mjs first to add playlists you follow (they are not in Spotify’s export).');
const allPlaylists = [...playlists, ...recovered];

const base = new Map(); // uri -> {name, artist, album}
for (const p of playlists) for (const t of p.items) if (!base.has(t.uri)) base.set(t.uri, t);
for (const t of library.tracks || []) if (!base.has(t.uri)) base.set(t.uri, { uri: t.uri, name: t.track, artist: t.artist, album: t.album });
for (const p of recovered)
  for (const t of p.items) {
    if (base.has(t.uri)) continue;
    const s = stats.get(t.uri);
    base.set(t.uri, s ? { uri: t.uri, name: s.name, artist: s.artist, album: s.album } : { uri: t.uri, name: t.title || null, artist: null, album: null });
  }
const likedRank = new Map((library.tracks || []).map((t, i) => [t.uri, i + 1]));
const banned = new Set((library.bannedTracks || []).map((t) => t.uri));

// ------------------------------------------------------------ records
// Same outlier-year guard as the dashboard, over every song we know a year for.
const badYears = yearOutliers(
  [...new Set([...stats.keys(), ...base.keys()])].map((uri) => {
    const it = itunes.tracks[uri];
    return { key: uri, artist: base.get(uri)?.artist || stats.get(uri)?.artist, year: it && !it.miss ? it.y || 0 : 0, album: it?.al };
  })
);
let priority = 0;
// Your playlists, then liked songs, then followed playlists, then Spotify-made ones.
const order = [
  ...playlists.flatMap((p) => p.items.map((t) => [t.uri, 'your_playlist'])),
  ...(library.tracks || []).map((t) => [t.uri, 'liked']),
  ...recovered.filter((p) => p.kind === 'followed').flatMap((p) => p.items.map((t) => [t.uri, 'followed_playlist'])),
  ...recovered.filter((p) => p.kind === 'spotify_made').flatMap((p) => p.items.map((t) => [t.uri, 'spotify_made_playlist'])),
];
const records = [];
const seen = new Set();
for (const [uri, firstSource] of order) {
  if (seen.has(uri)) continue;
  seen.add(uri);
  const b = base.get(uri);
  const id = uri.split(':')[2];
  const parsed = parseTitle(b.name || '');
  const film = parsed.film || filmFromAlbum(b.album || '');
  const it = itunes.tracks[uri];
  const match = it && !it.miss ? it : null;
  const a = (b.artist && artistInfo.get(b.artist)) || {};
  const memberships = allPlaylists.flatMap((p) =>
    p.items.filter((t) => t.uri === uri).map((t) => ({ name: p.name, position: t.position, added: t.added, source: p.source }))
  );

  // Language, strongest evidence first. English is a fallback: an English title
  // from BTS is still a Korean-language artist, so non-English evidence wins.
  const sl = scriptLang(`${b.name || ''} ${b.album || ''}`);
  const hints = memberships.map((m) => playlistHint(m.name)).filter(Boolean);
  const strongPl = hints.find((h) => h.strong)?.lang;
  const weakPl = hints.find((h) => !h.strong)?.lang;
  const tw = titleWordsLang(parsed.title) || (film ? null : titleWordsLang(b.album || ''));
  const gl = match?.g ? genreLang(match.g) : null;
  const ENG = 'English & global';
  const twMed = tw && tw.confidence !== 'low' ? tw.lang : null;
  const artistLang = a.lang && a.lang !== 'Other' ? a.lang : null;
  const steps = [
    [knownArtistLang(b.artist || ''), 'known_artist', 'high'],
    [tw && tw.confidence === 'high' ? tw.lang : null, 'title_words', 'high'],
    [sl, 'title_script', 'high'],
    [strongPl, 'your_playlist', 'high'],
    [twMed !== ENG ? twMed : null, 'title_words', 'medium'],
    [gl !== ENG ? gl : null, 'store_genre', 'medium'],
    [artistLang !== ENG ? artistLang : null, 'artist_profile', 'medium'],
    [twMed, 'title_words', 'medium'],
    [weakPl, 'your_playlist_mixed', 'medium'],
    [artistLang, 'artist_profile', 'medium'],
    [gl, 'store_genre', 'medium'],
    [tw?.lang, 'title_words', 'low'],
  ];
  const [language, source, confidence] = steps.find(([l]) => l) || [null, null, 'none'];

  const genre = match?.g || a.genre || null;
  const credited = match?.an ? match.an.split(/\s*,\s*|\s+&\s+/).filter(Boolean) : [];
  const allArtists = [...new Set([b.artist, ...parsed.featured, ...credited].filter(Boolean).map((x) => x.trim()).filter(Boolean))];
  const s = stats.get(uri);

  records.push({
    priority: ++priority,
    source: firstSource,
    metadata_quality: b.artist ? 'full' : b.name ? 'title_only' : 'id_only',
    spotify_id: id,
    spotify_uri: uri,
    spotify_url: `https://open.spotify.com/track/${id}`,
    title: b.name ? parsed.title : null,
    title_raw: b.name || null,
    version: parsed.version,
    primary_artist: b.artist || null,
    featured_artists: parsed.featured,
    all_artists: allArtists,
    album: b.album || null,
    from_film: film,
    language: language || 'Unknown',
    language_source: source,
    language_confidence: confidence,
    script: scriptOf(b.name || ''),
    genre,
    genre_family: family(genre),
    genre_source: match?.g ? 'itunes_track' : a.genre ? 'artist_profile' : null,
    release_year: (match?.y && !badYears.has(uri) ? match.y : null),
    duration_ms: match?.d || null,
    explicit: match ? !!match.x : null,
    sleep_or_ambient: !!a.sleep,
    liked: likedRank.has(uri),
    liked_rank: likedRank.get(uri) || null,
    hidden_by_you: banned.has(uri),
    playlists: memberships,
    stats: s
      ? { plays: s.plays, minutes: Math.round(s.ms / 60000), skips: s.skips, private_session_plays: s.privatePlays, first_played: s.first.slice(0, 10), last_played: s.last.slice(0, 10) }
      : { plays: 0, minutes: 0, skips: 0, private_session_plays: 0, first_played: null, last_played: null },
    search_query: b.name ? (b.artist ? `${b.artist} - ${parsed.title}` : parsed.title) : null,
    search_query_full: [b.artist, parsed.title, parsed.featured.length ? `feat. ${parsed.featured.join(', ')}` : '', parsed.version || '', film ? `(from ${film})` : ''].filter(Boolean).join(' '),
    lookup_status: match ? 'matched' : it?.miss ? 'not_found' : 'pending',
    itunes: match ? { track_id: match.id, title: match.tn, artist: match.an, album: match.al, url: match.u, price: match.p > 0 ? match.p : null, currency: match.c, match_score: match.s } : null,
  });
}

// ------------------------------------------------------------ write
fs.mkdirSync(OUT, { recursive: true });
const write = (name, text) => {
  fs.writeFileSync(path.join(OUT, name), text);
  console.log(`  ${name.padEnd(14)} ${(Buffer.byteLength(text) / 1024).toFixed(0).padStart(5)} KB`);
};
const countBy = (arr, fn) => Object.entries(arr.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
const byId = new Map(records.map((r) => [r.spotify_id, r]));
const langMix = (ids) => Object.fromEntries(countBy(ids.map((i) => byId.get(i)), (r) => r.language));

const meta = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: 'Spotify privacy export (YourLibrary.json, Playlist1.json, Extended Streaming History) + iTunes Search API matches',
  counts: {
    unique_tracks: records.length,
    liked: (library.tracks || []).length,
    playlists: playlists.length,
    playlist_entries: playlists.reduce((n, p) => n + p.items.length, 0),
    in_playlists_and_liked: records.filter((r) => r.liked && r.playlists.some((m) => m.source === 'spotify_export')).length,
    recovered_playlists: recovered.length,
    recovered_playlist_entries: recovered.reduce((n, p) => n + p.items.length, 0),
    songs_only_in_recovered_playlists: records.filter((r) => r.source === 'followed_playlist' || r.source === 'spotify_made_playlist').length,
    by_source: Object.fromEntries(countBy(records, (r) => r.source)),
    itunes_matched: records.filter((r) => r.lookup_status === 'matched').length,
    lookup_pending: records.filter((r) => r.lookup_status === 'pending').length,
  },
  languages: Object.fromEntries(countBy(records, (r) => r.language)),
  priority_order:
    'your playlists (most-played first, in playlist order), then liked songs not in them, then playlists you follow, then Spotify-made playlists (both rebuilt from app logs)',
  note: 'Spotify’s export only lists playlists you created. Followed and Spotify-made playlists were rebuilt from the last few months of app logs, so they can be partial (see each playlist’s coverage).',
  followed_artists: (library.artists || []).map((a) => a.name),
  saved_albums: (library.albums || []).map((a) => ({ album: a.album, artist: a.artist, spotify_uri: a.uri })),
};
const playlistOut = allPlaylists.map((p) => ({
  name: p.name,
  source: p.source,
  kind: p.kind,
  url: p.url || null,
  last_modified: p.source === 'spotify_export' ? p.modified : null,
  last_seen_in_logs: p.source === 'app_logs' ? p.modified : null,
  track_count: p.items.length,
  full_size: p.size || p.items.length,
  coverage: p.coverage ?? 1,
  hours_played: +p.items.reduce((h, t) => h + hours(t.uri), 0).toFixed(1),
  language_mix: langMix(p.items.map((t) => t.uri.split(':')[2])),
  tracks: p.items.map((t) => ({ position: t.position, added: t.added, spotify_id: t.uri.split(':')[2] })),
}));

console.log(
  `${records.length} unique songs: ${meta.counts.liked} liked, ${meta.counts.playlist_entries} entries in your ${playlists.length} playlists, ` +
    `${meta.counts.recovered_playlist_entries} entries in ${recovered.length} followed/Spotify-made playlists rebuilt from logs`
);
write('tracks.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
write('library.json', JSON.stringify({ meta, playlists: playlistOut, liked: (library.tracks || []).map((t) => t.uri.split(':')[2]), tracks: records }, null, 2));

// CSV
const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const flat = (r) => ({
  priority: r.priority,
  source: r.source,
  metadata_quality: r.metadata_quality,
  spotify_id: r.spotify_id,
  title: r.title,
  version: r.version,
  primary_artist: r.primary_artist,
  featured_artists: r.featured_artists.join(' | '),
  all_artists: r.all_artists.join(' | '),
  album: r.album,
  from_film: r.from_film,
  language: r.language,
  language_confidence: r.language_confidence,
  script: r.script,
  genre: r.genre,
  genre_family: r.genre_family,
  release_year: r.release_year,
  duration_sec: r.duration_ms ? Math.round(r.duration_ms / 1000) : '',
  explicit: r.explicit,
  liked: r.liked,
  playlists: r.playlists.map((m) => m.name).join(' | '),
  plays: r.stats.plays,
  minutes: r.stats.minutes,
  first_played: r.stats.first_played,
  last_played: r.stats.last_played,
  search_query: r.search_query,
  spotify_url: r.spotify_url,
  itunes_url: r.itunes?.url,
  title_raw: r.title_raw,
});
const cols = Object.keys(flat(records[0]));
write('tracks.csv', '﻿' + [cols.join(','), ...records.map((r) => cols.map((c) => csvEsc(flat(r)[c])).join(','))].join('\r\n') + '\r\n');
const pcols = ['playlist', 'playlist_source', 'position', 'added', 'spotify_id', 'title', 'primary_artist', 'featured_artists', 'album', 'language', 'release_year', 'search_query'];
write(
  'playlists.csv',
  '﻿' +
    [
      pcols.join(','),
      ...allPlaylists.flatMap((p) =>
        p.items.map((t) => {
          const r = byId.get(t.uri.split(':')[2]);
          return [p.name, p.source, t.position, t.added, r.spotify_id, r.title, r.primary_artist, r.featured_artists.join(' | '), r.album, r.language, r.release_year, r.search_query].map(csvEsc).join(',');
        })
      ),
    ].join('\r\n') +
    '\r\n'
);

// Markdown
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const artistsCell = (r) => md([r.primary_artist, ...r.featured_artists].filter(Boolean).join(', ') || '—');
const titleCell = (r) => (r.title ? md(r.title) : `[unknown](${r.spotify_url})`) + (r.version ? ` <sub>${md(r.version)}</sub>` : '') + (r.from_film ? ` <sub>· from ${md(r.from_film)}</sub>` : '');
const table = (list, withPos) =>
  [
    `| ${withPos ? '#' : 'Liked #'} | Song | Artists | Album | Language | Year | Genre | Plays |`,
    '|---:|---|---|---|---|---:|---|---:|',
    ...list.map(({ r, n }) => `| ${n} | ${titleCell(r)} | ${artistsCell(r)} | ${md(r.album)} | ${md(r.language)} | ${r.release_year || ''} | ${md(r.genre || '')} | ${r.stats.plays} |`),
  ].join('\n');
const anchor = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
const likedOnly = (library.tracks || []).map((t, i) => ({ r: byId.get(t.uri.split(':')[2]), n: i + 1 }));
const likedByLang = countBy(likedOnly, (x) => x.r.language);
const mdText = [
  '# My Spotify library',
  '',
  `Generated ${meta.generated_at.slice(0, 10)} · **${records.length} unique songs** · ${meta.counts.liked} liked · ${playlists.length} playlists of yours (${meta.counts.playlist_entries} entries) · ${recovered.length} followed / Spotify-made playlists rebuilt from app logs (${meta.counts.recovered_playlist_entries} entries, ${meta.counts.songs_only_in_recovered_playlists} songs found only there).`,
  '',
  `Spotify’s export only lists playlists you created. Playlists you follow and Spotify-made ones were rebuilt from the last few months of app logs, so some are partial: the coverage column shows how much of each is known.`,
  '',
  `Language is a best guess. The order of evidence is: the title's script, then your single-language playlists, then romanised title words, store genre and artist profile (non-English evidence first), then mixed playlists. English is the fallback. ${meta.counts.lookup_pending ? `${meta.counts.lookup_pending} songs haven't been matched to the store yet, so year and genre are blank for those.` : ''}`,
  '',
  '## Languages',
  '',
  '| Language | Songs | Liked |',
  '|---|---:|---:|',
  ...countBy(records, (r) => r.language).map(([l, n]) => `| ${md(l)} | ${n} | ${likedOnly.filter((x) => x.r.language === l).length} |`),
  '',
  '## Playlists',
  '',
  '| Playlist | Whose | Songs known | Coverage | Hours played | Main languages | Edited / last seen |',
  '|---|---|---:|---:|---:|---|---|',
  ...playlistOut.map(
    (p) =>
      `| [${md(p.name)}](#${anchor(`playlist-${p.name}`)}) | ${{ yours: 'Yours', followed: 'Followed', spotify_made: 'Spotify-made' }[p.kind]} | ${p.track_count}${p.full_size > p.track_count ? ` of ${p.full_size}` : ''} | ${Math.round(p.coverage * 100)}% | ${p.hours_played} | ${md(Object.entries(p.language_mix).slice(0, 3).map(([l, n]) => `${l} ${n}`).join(', '))} | ${p.last_modified || p.last_seen_in_logs || ''} |`
  ),
  '',
  ...allPlaylists.flatMap((p) => [
    `### Playlist: ${md(p.name)}`,
    '',
    p.source === 'app_logs'
      ? `${p.kind === 'followed' ? 'Followed' : 'Spotify-made'} · rebuilt from app logs · ${p.items.length}${p.size > p.items.length ? ` of ${p.size}` : ''} songs known · [open on Spotify](${p.url})`
      : `${p.items.length} songs · edited ${p.modified || '?'}`,
    '',
    table(p.items.map((t, i) => ({ r: byId.get(t.uri.split(':')[2]), n: t.position ?? i + 1 })), true),
    '',
  ]),
  `## Liked songs (${likedOnly.length})`,
  '',
  'Grouped by language. The number is the song’s position in your Liked Songs (1 = most recently liked).',
  '',
  ...likedByLang.flatMap(([l, n]) => [`### ${md(l)} (${n})`, '', table(likedOnly.filter((x) => x.r.language === l), false), '']),
].join('\n');
write('library.md', mdText);

// JSON Schema for one record
const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const nint = { type: ['integer', 'null'] };
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Spotify library track',
  type: 'object',
  required: ['priority', 'spotify_id', 'title', 'primary_artist', 'album', 'language', 'liked', 'playlists', 'search_query'],
  properties: {
    priority: { type: 'integer', description: '1 = first. Your playlists (most-played first), liked songs, followed playlists, Spotify-made playlists.' },
    source: { type: 'string', enum: ['your_playlist', 'liked', 'followed_playlist', 'spotify_made_playlist'], description: 'Where the song first appears in priority order.' },
    metadata_quality: { type: 'string', enum: ['full', 'title_only', 'id_only'], description: 'title_only/id_only: a song from a rebuilt playlist you never played; resolve it via spotify_url.' },
    spotify_id: { ...str, description: 'Unique key. 22-char Spotify track id.' },
    spotify_uri: str,
    spotify_url: str,
    title: { ...nstr, description: 'Clean title: no feat./version/film suffixes. Null only when metadata_quality is id_only.' },
    title_raw: { ...nstr, description: 'Exactly as Spotify shows it.' },
    version: { ...nstr, description: 'e.g. "Remastered 2011", "Ghazal Version", "Acoustic", "Slowed + Reverb".' },
    primary_artist: { ...nstr, description: 'Null when metadata_quality is not full.' },
    featured_artists: { type: 'array', items: str },
    all_artists: { type: 'array', items: str, description: 'Primary + featured + artists credited by the store, de-duplicated.' },
    album: nstr,
    from_film: { ...nstr, description: 'Film/series the song is from, parsed from "(From \\"X\\")" or the soundtrack album name.' },
    language: { ...str, description: 'Best guess: English & global, Hindi & Urdu, Punjabi, Bengali, Nepali, Japanese, Korean, Thai, Tamil, ..., or Unknown.' },
    language_source: { type: ['string', 'null'], enum: ['known_artist', 'title_script', 'your_playlist', 'title_words', 'store_genre', 'your_playlist_mixed', 'artist_profile', null] },
    language_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    script: { ...str, description: 'Writing system of the title: Latin, Devanagari, Bengali, Gurmukhi, Kana, Han, Hangul, Thai, Arabic, ...' },
    genre: nstr,
    genre_family: nstr,
    genre_source: { type: ['string', 'null'], enum: ['itunes_track', 'artist_profile', null] },
    release_year: nint,
    duration_ms: nint,
    explicit: { type: ['boolean', 'null'] },
    sleep_or_ambient: { type: 'boolean' },
    liked: { type: 'boolean' },
    liked_rank: { ...nint, description: 'Position in Liked Songs, 1 = most recently liked.' },
    hidden_by_you: { type: 'boolean' },
    playlists: {
      type: 'array',
      items: { type: 'object', properties: { name: str, position: nint, added: nstr, source: { type: 'string', enum: ['spotify_export', 'app_logs'] } } },
    },
    stats: {
      type: 'object',
      properties: { plays: { type: 'integer', description: 'Plays of 30 s or more.' }, minutes: { type: 'integer' }, skips: { type: 'integer' }, private_session_plays: { type: 'integer' }, first_played: nstr, last_played: nstr },
    },
    search_query: { ...nstr, description: '"Artist - Title" (just the title when the artist is unknown), the most portable lookup string.' },
    search_query_full: { ...str, description: 'Adds featured artists, version and film for disambiguation.' },
    lookup_status: { type: 'string', enum: ['matched', 'not_found', 'pending'] },
    itunes: { type: ['object', 'null'], properties: { track_id: { type: 'integer' }, title: str, artist: str, album: str, url: str, price: { type: ['number', 'null'] }, currency: str, match_score: { type: 'number' } } },
  },
};
write('schema.json', JSON.stringify(schema, null, 2));

const readme = `# Library export — guide for agents

Every liked song and playlist track from a Spotify account, parsed and enriched.
Generated ${meta.generated_at} by \`scripts/export-library.mjs\`.

Spotify's privacy export only lists playlists the user created. Playlists they follow, and
Spotify-made ones, were rebuilt from the app's technical logs (last few months only) by
\`scripts/discover-playlists.mjs\`. Those can be partial: check each playlist's \`coverage\` in
\`library.json\`, and each song's \`source\` and \`metadata_quality\`.

## Files
| File | Use it for |
|---|---|
| \`tracks.jsonl\` | **Start here.** One JSON object per unique song (${records.length} lines), already in priority order. Stream it line by line. |
| \`library.json\` | Everything in one document: \`meta\`, \`playlists\` (with ordered \`spotify_id\`s), \`liked\` (ids in Spotify order), \`tracks\`. |
| \`tracks.csv\` | The same records flattened for spreadsheets; list fields joined with \` \\| \`. UTF-8 with BOM. |
| \`playlists.csv\` | One row per playlist entry, in playlist order (a song in two playlists appears twice). |
| \`library.md\` | Human-readable: languages, every playlist, liked songs grouped by language. |
| \`schema.json\` | JSON Schema (2020-12) for one track record. |

## Conventions
- **Key:** \`spotify_id\` is unique across all files. Join playlists and liked lists to tracks on it.
- **Order:** \`priority\` 1..${records.length}. The user's own playlists come first (most-played playlist first, songs in playlist order), then liked songs not in them, then followed playlists, then Spotify-made playlists. \`source\` says which group a song came from.
- **Partial data:** \`metadata_quality\` is \`full\` for songs the user played or saved. \`title_only\` and \`id_only\` are songs from a rebuilt playlist that were never played, so only Spotify's public title, or just the id, is known; resolve them via \`spotify_url\`.
- **Titles:**
  - \`title\` is cleaned; \`title_raw\` is verbatim.
  - Version info ("Remastered 2011", "Ghazal Version", "Slowed + Reverb") is in \`version\`.
  - Film/series is in \`from_film\`.
  - Guest artists are in \`featured_artists\`.
- **Searching:** \`search_query\` ("Artist - Title") is the most portable lookup string. Use \`search_query_full\` to tell versions apart. Titles keep their original script (Japanese, Bengali, Thai, ...), so don't transliterate unless the target service needs it.
- **Language:** a best guess with provenance.
  - \`language_source\` says where it came from, strongest first: \`known_artist\` (e.g. Nepali artists, since Devanagari can't separate Nepali from Hindi), \`title_script\` (non-Latin script), \`your_playlist\` (a single-language playlist like "Punjabi"), \`title_words\` (romanised words like "tere", "mainu", "tomake", "kimi"), \`store_genre\`, \`artist_profile\`, \`your_playlist_mixed\` (e.g. "Indie Pop/ Hindi/ Urdu/…"). Non-English evidence is checked before English, so an English-titled BTS song stays Korean.
  - \`language_confidence\` is \`high\`, \`medium\`, \`low\` (English guessed from common words) or \`none\`.
  - Treat \`Unknown\` as unclassified, not as a language.
- **Store fields:** \`release_year\`, \`duration_ms\`, \`explicit\` and \`itunes\` are present only when \`lookup_status\` is \`matched\`. \`genre\` falls back to the artist's profile (see \`genre_source\`). \`pending\` means not looked up yet. Re-run \`scripts/enrich.mjs\` and then this script to fill them.
- **Stats:** \`stats\` is lifetime listening (since ${rows[0]?.ts.slice(0, 10)}). Plays count only listens of 30 s or more. Private-session plays are included.

## Counts
${Object.entries(meta.counts).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`).join('\n')}

Languages: ${Object.entries(meta.languages).map(([l, n]) => `${l} ${n}`).join(' · ')}
`;
write('README.md', readme);
console.log(`\nWrote ${OUT}`);
