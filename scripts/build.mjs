#!/usr/bin/env node
// Turns the raw Spotify export (+ cache/itunes.json from enrich.mjs) into the
// compact JSON the dashboard reads:
//
//   site/data/catalog.json  tracks, artists, albums, genres, languages
//   site/data/plays.json    every stream, columnar and delta-encoded
//   site/data/meta.json     library, playlists, Wrapped, phone/app logs (no PII)
//   site/data/private.json  account, ad inferences, searches  <- gitignored, local only
//
//   node scripts/build.mjs [--data <export dir>] [--exclude-incognito]
//
// Private-session plays are included like any other play; pass
// --exclude-incognito to leave them out. IP addresses, e-mail, address,
// birth date and payment details never leave the export.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, exportDir, streams, account, tech } from './lib/export.mjs';
import { yearOutliers } from './lib/match.mjs';
import { FAMILIES, family, LANGS, scriptLang, genreLang, playlistLang, titleWordsLang, knownArtistLang, SLEEP_RX } from './lib/classify.mjs';

const dir = exportDir();
const OUT = path.join(ROOT, 'site', 'data');
const INCLUDE_INCOGNITO = !process.argv.includes('--exclude-incognito');
fs.mkdirSync(OUT, { recursive: true });

const itunesPath = path.join(ROOT, 'cache', 'itunes.json');
const itunes = fs.existsSync(itunesPath) ? JSON.parse(fs.readFileSync(itunesPath, 'utf8')) : { tracks: {}, artists: {} };

// ---------------------------------------------------------------- helpers
const TZ = { IN: 5.5, TH: 7, VN: 7, MY: 8, SG: 8, ID: 7, AE: 4, GB: 0, DZ: 1, FR: 1, DE: 1, NP: 5.75, BD: 6, LK: 5.5, JP: 9, KR: 9, US: -5 };
const localSeconds = (ts, cc) => Math.round(Date.parse(ts) / 1000 + (TZ[cc] ?? 5.5) * 3600);
// Plays from the short account history that couldn't be matched have no Spotify id.
const trackId = (uri) => ((uri || '').startsWith('spotify:track:') ? uri.split(':')[2] : '');

function indexer() {
  const list = [];
  const map = new Map();
  return {
    list,
    id(key, make = () => key) {
      if (map.has(key)) return map.get(key);
      const i = list.length;
      map.set(key, i);
      list.push(make());
      return i;
    },
    has: (key) => map.has(key),
    get: (key) => map.get(key),
  };
}

function platformName(p = '') {
  const s = p.toLowerCase();
  if (s.includes('tizen')) return 'Samsung TV';
  if (s.includes('cast')) return 'Chromecast / TV';
  if (s.includes('windows')) return 'Windows PC';
  if (s.includes('ios') || s.includes('iphone')) return 'iPhone';
  if (s.includes('redmi')) return 'Redmi Note 8 Pro';
  if (s.includes('sm-m307f')) return 'Samsung Galaxy M30s';
  if (s.includes('web')) return 'Web player';
  if (s.includes('android')) return 'Android phone';
  if (!s || s === 'unknown') return 'Unknown device';
  return p;
}


// ---------------------------------------------------------------- load
const rows = streams(dir);
const music = rows.filter((r) => r.spotify_track_uri && r.master_metadata_track_name);
const incognitoRows = music.filter((r) => r.incognito_mode);
const publicRows = INCLUDE_INCOGNITO ? music : music.filter((r) => !r.incognito_mode);
const episodes = rows.filter((r) => r.spotify_episode_uri);

const library = account(dir, 'YourLibrary') || {};
const playlists = (account(dir, 'Playlist1') || {}).playlists || [];

const artists = indexer();
const albums = indexer();
const tracks = indexer();
const genres = indexer();
const artistInfo = []; // per artist index: { ms, langVotes, genreVotes, sleepVotes }

function artistIdx(name) {
  return artists.id(name, () => {
    artistInfo.push({ ms: 0, lang: {}, genre: {}, sleep: 0, total: 0 });
    return name;
  });
}
function trackIdx(uri, name, artist, album) {
  return tracks.id(uri, () => {
    const a = artistIdx(artist);
    const al = albums.id(`${album}\u0000${a}`, () => [album, a]);
    const it = itunes.tracks[uri];
    const hit = it && !it.miss ? it : null;
    return { name, a, al, id: trackId(uri), it: hit };
  });
}

for (const r of publicRows) trackIdx(r.spotify_track_uri, r.master_metadata_track_name, r.master_metadata_album_artist_name, r.master_metadata_album_album_name);
for (const t of library.tracks || []) trackIdx(t.uri, t.track, t.artist, t.album);
for (const p of playlists)
  for (const it of p.items || [])
    if (it.track?.trackUri) trackIdx(it.track.trackUri, it.track.trackName, it.track.artistName, it.track.albumName);

// ---------------------------------------------------------------- votes for genre / language / sleep
const trackMs = new Float64Array(tracks.list.length);
for (const r of publicRows) trackMs[tracks.get(r.spotify_track_uri)] += r.ms_played;

tracks.list.forEach((t, i) => {
  const info = artistInfo[t.a];
  const w = trackMs[i] + 1;
  info.ms += trackMs[i];
  info.total += w;
  const sl = scriptLang(t.name) || scriptLang(artists.list[t.a]);
  if (sl) info.lang[sl] = (info.lang[sl] || 0) + w * 3;
  const tw = titleWordsLang(t.name);
  if (tw && tw.confidence !== 'low') info.lang[tw.lang] = (info.lang[tw.lang] || 0) + w * (tw.confidence === 'high' ? 4 : 2);
  if (t.it?.g) {
    info.genre[t.it.g] = (info.genre[t.it.g] || 0) + w;
    const gl = genreLang(t.it.g);
    if (gl) info.lang[gl] = (info.lang[gl] || 0) + w;
  }
  if (SLEEP_RX.test(t.name) || SLEEP_RX.test(t.it?.al || '')) info.sleep += w;
});
for (const p of playlists) {
  const pl = playlistLang(p.name);
  if (!pl) continue;
  for (const it of p.items || []) {
    if (!it.track?.trackUri) continue;
    const t = tracks.list[tracks.get(it.track.trackUri)];
    const info = artistInfo[t.a];
    info.lang[pl] = (info.lang[pl] || 0) + 5e8; // the user's own labels win
  }
}
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

const artistRows = artists.list.map((name, i) => {
  const info = artistInfo[i];
  const ai = itunes.artists[name];
  const g = (ai && !ai.miss && ai.g) || top(info.genre);
  let lang = knownArtistLang(name) || top(info.lang) || genreLang(g || '') || scriptLang(name);
  if (!lang && g && family(g) !== 'Indian') lang = null; // unknown stays unknown
  const sleep = SLEEP_RX.test(name) || info.sleep / info.total > 0.5 || /new age|ambient|relax|meditation|sleep/i.test(g || '') ? 1 : 0;
  return [name, g ? genres.id(g) : -1, lang ? LANGS.indexOf(lang) : -1, sleep];
});

// ---------------------------------------------------------------- catalog
const ART_PREFIX = 'https://is1-ssl.mzstatic.com/image/thumb/';
const shortArt = (u) => (u ? u.replace(/^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\//, '').replace(/\/100x100bb\.jpg$/, '') : 0);
const badYear = yearOutliers(tracks.list.map((t, i) => ({ key: i, artist: t.a, year: t.it?.y || 0, album: t.it?.al })));
const trackRows = tracks.list.map((t, i) => {
  const g = t.it?.g ? genres.id(t.it.g) : -1;
  return [t.name, t.a, t.al, t.id, badYear.has(i) ? 0 : t.it?.y || 0, g, shortArt(t.it?.art), t.it?.x || 0];
});
const catalog = {
  artPrefix: ART_PREFIX,
  artSuffix: '/{s}x{s}bb.jpg',
  families: FAMILIES,
  languages: LANGS,
  genres: genres.list,
  genreFamily: genres.list.map((g) => FAMILIES.indexOf(family(g))),
  artists: artistRows, // [name, genreIdx, langIdx, isSleep]
  albums: albums.list, // [name, artistIdx]
  tracks: trackRows, // [name, artistIdx, albumIdx, spotifyId, year, genreIdx, art, explicit]
};

// ---------------------------------------------------------------- plays (columnar)
const reasons = indexer();
const platforms = indexer();
const countries = indexer();
const P = { t: [], k: [], s: [], f: [], rs: [], re: [], p: [], c: [] };
let prev = 0;
for (const r of publicRows) {
  const t = localSeconds(r.ts, r.conn_country);
  P.t.push(t - prev);
  prev = t;
  P.k.push(tracks.get(r.spotify_track_uri));
  P.s.push(Math.round(r.ms_played / 1000));
  P.f.push((r.shuffle ? 1 : 0) | (r.offline ? 2 : 0) | (r._video ? 4 : 0) | (r.skipped ? 8 : 0));
  P.rs.push(reasons.id(r.reason_start || 'unknown'));
  P.re.push(reasons.id(r.reason_end || 'unknown'));
  P.p.push(platforms.id(platformName(r.platform)));
  P.c.push(countries.id(r.conn_country || '??'));
}
const plays = { ...P, reasons: reasons.list, platforms: platforms.list, countries: countries.list };

// ---------------------------------------------------------------- meta (public, no PII)
const tIdx = (uri) => (tracks.has(uri) ? tracks.get(uri) : -1);
const count = (arr, fn) => {
  const m = {};
  for (const x of arr) {
    const k = fn(x);
    if (k == null) continue;
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
const span = (arr) => {
  const t = arr.map((r) => r.timestamp_utc).filter(Boolean).sort();
  return t.length ? [t[0].slice(0, 10), t[t.length - 1].slice(0, 10)] : null;
};

const wrapped = account(dir, 'Wrapped2025');
const streamSettings = tech(dir, 'AudioStreamingSettingsReport').sort((a, b) => (a.timestamp_utc < b.timestamp_utc ? 1 : -1))[0];
const audioSettings = tech(dir, 'AudioSettingsReport').sort((a, b) => (a.timestamp_utc < b.timestamp_utc ? 1 : -1))[0];
const offline = tech(dir, 'OfflineReport').sort((a, b) => (a.timestamp_utc < b.timestamp_utc ? 1 : -1))[0];
const deviceReport = tech(dir, 'AndroidDeviceReport')[0];
const volume = tech(dir, 'SystemVolumeControl');
const lyrics = tech(dir, 'MinimumLyricsCharactersSeen');
const route = tech(dir, 'ConnectActiveDeviceChanged');
const exits = tech(dir, 'AndroidAppExitReason');
const jams = tech(dir, 'SocialConnectSessionCreated');
const jamEnds = tech(dir, 'SocialConnectSessionEnded');
const accessory = tech(dir, 'ExternalAccessoryRemoteInteraction');
const added = tech(dir, 'AddedToCollection');
const removed = tech(dir, 'RemovedFromCollection');
const daylists = tech(dir, 'DaylistGenerated');
const onRepeat = tech(dir, 'OnRepeatContents');
const radar = tech(dir, 'ReleaseRadarServedRecs');
const smart = tech(dir, 'SmartShuffleOperationResultAction');
const canvas = tech(dir, 'CanvasLoad');
const tvViews = tech(dir, 'TvappPageView');
const discovered = tech(dir, 'ConnectDeviceDiscovered');
const allTech = [volume, lyrics, exits, accessory, added, route].flat();

const stripTags = (s = '') => s.replace(/<[^>]+>/g, '');
const techLog = {
  window: span(allTech),
  device: deviceReport
    ? { maker: deviceReport.context_device_manufacturer, os: `Android ${deviceReport.context_os_version}`, ramGB: Math.round((deviceReport.message_memory || 0) / 1e9), screen: deviceReport.message_screen_size ? +deviceReport.message_screen_size.toFixed(1) : null }
    : null,
  streaming: streamSettings
    ? { wifi: streamSettings.message_play_bitrate_wifi, cellular: streamSettings.message_play_bitrate_cellular, userChoseWifi: streamSettings.message_user_selected_play_bitrate_wifi, userChoseCell: streamSettings.message_user_selected_play_bitrate_cellular }
    : null,
  audio: audioSettings
    ? { normalization: audioSettings.message_enable_normalization, crossfade: audioSettings.message_enable_crossfade, crossfadeMs: audioSettings.message_crossfade_time, gapless: audioSettings.message_enable_gapless }
    : null,
  offline: offline ? { downloaded: offline.message_num_downloaded_tracks, total: offline.message_total_num_tracks, links: offline.message_total_num_links } : null,
  volume: count(volume, (v) => (v.message_volume == null ? null : Math.round(v.message_volume * 10) / 10)).sort((a, b) => a[0] - b[0]),
  outputs: count(route, (r) => r.message_new_active_device_audio_output_device_type),
  exits: count(exits, (e) => e.message_reason),
  lyricsViews: lyrics.length,
  lyricsTracks: count(lyrics, (l) => tIdx(l.message_track_uri)).filter(([k]) => +k >= 0).slice(0, 8).map(([k, n]) => [+k, n]),
  jams: { created: jams.length, withGuests: jamEnds.filter((j) => j.message_n_participants > 0).length },
  remote: count(accessory, (a) => a.message_action),
  liked: added.length,
  unliked: removed.length,
  daylists: [...new Set(daylists.map((d) => d.message_playlist_title))].map((title) => ({
    title,
    desc: stripTags(daylists.find((d) => d.message_playlist_title === title).message_playlist_description),
  })),
  onRepeat: (() => {
    const latest = onRepeat.sort((a, b) => (a.timestamp_utc < b.timestamp_utc ? 1 : -1))[0];
    return latest ? latest.message_contents.map(tIdx).filter((i) => i >= 0).slice(0, 12) : [];
  })(),
  releaseRadarServed: radar.length,
  smartShuffleOn: smart.filter((s) => s.message_smart_shuffle_state).length,
  smartShuffleOff: smart.filter((s) => !s.message_smart_shuffle_state).length,
  canvasLoads: canvas.length,
  tvPageViews: tvViews.length,
  nearbyTv: [...new Set(discovered.map((d) => [d.message_discovered_brand_display_name, d.message_discovered_device_type].filter(Boolean).join(' ')))].filter(Boolean).slice(0, 5),
};

// Spotify's own artist segments ("Previously active listener", ...).
const marquee = account(dir, 'Marquee') || [];
const marqueeSeg = {};
for (const m of marquee) (marqueeSeg[m.segment] ||= []).push(m.artistName);

// Sound Capsule: the weekly/monthly notes Spotify shows in the app, as sentences.
const capsule = account(dir, 'YourSoundCapsule') || {};
const pct = (x) => (x < 0.01 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
const mins = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} hours` : `${Math.round(s / 60)} minutes`);
const capsuleText = (h) => {
  switch (h.highlightType) {
    case 'TIME_WELL_SPENT': {
      const it = h.timeWellSpentHighlight?.items?.[0];
      return it && `${mins(it.secondsPlayed)} of music from the ${it.entity}s`;
    }
    case 'PROPORTION_LISTENING_ENTITY':
      return `${h.proportionListeningHighlight.entity} was ${Math.round(h.proportionListeningHighlight.listeningPercentage)}% of your listening`;
    case 'UNLIKE_COMBINATION':
      return `Unlikely pairing: ${h.unlikeCombinationHighlight.firstEntity} + ${h.unlikeCombinationHighlight.secondEntity}`;
    case 'STREAKS':
      return `${h.streaksHighlight.dayStreaks}-day streak of “${h.streaksHighlight.entity}”`;
    case 'MILESTONE':
      return `${mins(h.multiEntityMilestoneHighlight.milestoneListeningSeconds)} with ${h.multiEntityMilestoneHighlight.entities.slice(0, 3).join(', ')} and more`;
    case 'MONTHLY_RECAP':
      return `${mins(h.monthlyRecapHighlight.totalSecondsPlayed)} this month; top song “${h.monthlyRecapHighlight.topTracks?.[0]}”`;
    case 'TOP_LISTENER':
      return `Top ${pct(h.topListenerHighlight.topPercentile)} of ${h.topListenerHighlight.entity} listeners`;
    case 'ON_THIS_PERIOD':
      return `${h.onThisPeriodHighlight.nostalgiaUnitsAgo} ${h.onThisPeriodHighlight.nostalgiaPeriod.toLowerCase()}s ago you were playing “${h.onThisPeriodHighlight.entity}”`;
    case 'ON_REPEAT':
      return `“${h.onRepeatHighlight.entity}” on repeat: ${h.onRepeatHighlight.streamCount} plays`;
    default:
      return null;
  }
};
const capsuleOut = (capsule.highlights || [])
  .map((h) => ({ date: h.date, type: h.highlightType, text: capsuleText(h) }))
  .filter((h) => h.text)
  .sort((a, b) => (a.date < b.date ? 1 : -1));

const wrappedOut = wrapped
  ? {
      minutes: wrapped.party?.totalNumListeningMinutes ?? Math.round((wrapped.yearlyMetrics?.totalMsListened || 0) / 60000),
      days: wrapped.party?.totalNumListeningDays,
      streak: wrapped.party?.streakNumListeningDays,
      uniqueArtists: wrapped.topArtists?.numUniqueArtists,
      uniqueTracks: wrapped.topTracks?.numUniqueTracks,
      genres: wrapped.topGenres?.totalNumGenres,
      topFanPercent: wrapped.topArtists?.topNPercentileFan != null ? +(wrapped.topArtists.topNPercentileFan * 100).toFixed(2) : null,
      discovered: wrapped.party?.numArtistsDiscovered,
      listeningAge: wrapped.listeningAge?.listeningAge,
      club: wrapped.clubs?.userClub,
      clubRole: wrapped.clubs?.role,
      explicitPct: wrapped.party?.percentListenedExplicit,
      partyPct: wrapped.party?.percentPartyTracks,
      lovePct: wrapped.party?.percentLoveTracks,
      chillPct: wrapped.party?.percentChillTracks,
      topTracks: (wrapped.topTracks?.topTracks || []).map((t) => ({ k: tIdx(t.trackUri), plays: t.count, ms: t.msPlayed })),
      stories: (wrapped.archiveReports?.archiveReports || []).slice(0, 6).map((r) => ({ date: r.columnQualifier, title: r.title, text: r.description })),
    }
  : null;

const meta = {
  generated: new Date().toISOString(),
  incognitoExcluded: !INCLUDE_INCOGNITO,
  enrichment: {
    tracksMatched: Object.values(itunes.tracks).filter((t) => !t.miss).length,
    artistsMatched: Object.values(itunes.artists).filter((a) => !a.miss).length,
    store: itunes.country || 'in',
  },
  library: {
    liked: (library.tracks || []).map((t) => tIdx(t.uri)),
    artists: (library.artists || []).map((a) => a.name),
    albums: (library.albums || []).map((a) => `${a.album} — ${a.artist}`),
  },
  playlists: playlists.map((p) => ({
    name: p.name,
    modified: p.lastModifiedDate,
    tracks: (p.items || []).filter((i) => i.track?.trackUri).map((i) => [tIdx(i.track.trackUri), i.addedDate]),
  })),
  podcasts: count(episodes, (e) => e.episode_show_name)
    .map(([show]) => ({ show, hours: +(episodes.filter((e) => e.episode_show_name === show).reduce((s, e) => s + e.ms_played, 0) / 3.6e6).toFixed(1) }))
    .slice(0, 10),
  wrapped2025: wrappedOut,
  marquee: Object.fromEntries(Object.entries(marqueeSeg).map(([k, v]) => [k, { count: v.length, sample: v.slice(0, 12) }])),
  capsule: capsuleOut,
  shortHistoryPlays: rows.filter((r) => r._short).length,
  tech: techLog,
};

// ---------------------------------------------------------------- private (local only)
const user = account(dir, 'UserAttributes') || {};
const identity = account(dir, 'Identity') || {};
const inferences = (account(dir, 'Inferences') || {}).inferences || [];
const searches = account(dir, 'SearchQueries') || [];
const recipients = tech(dir, 'recipients');
const follow = account(dir, 'Follow') || {};
// Keep only the final query of each typing burst ("n", "na", "nakamur" -> "nakamura"):
// drop a query when a longer one starting with it was typed within two minutes.
const searchTime = (s) => Date.parse(String(s.searchTime).replace(/\[.*\]$/, ''));
const finalSearches = searches.filter((s) => {
  const q = (s.searchQuery || '').trim().toLowerCase();
  if (!q) return false;
  const t = searchTime(s);
  return !searches.some((o) => {
    const oq = (o.searchQuery || '').trim().toLowerCase();
    return oq.length > q.length && oq.startsWith(q) && Math.abs(searchTime(o) - t) < 120000;
  });
});
const readableSegment = (x) =>
  x
    .replace(/\s*\(1P\)$/, '')
    .replace(/^Interest \| /, '')
    .replace(/^Purchase Intent\* \| /, '')
    .replace(/^[13]P_/, '')
    .replace(/^Custom_/, '')
    .replace(/_\d{1,2}[A-Za-z]{3,9}\d{4}/, '')
    .replace(/_([A-Z]{2})$/, ' ($1)')
    .replace(/_/g, ' ')
    .replace(/^(.+) \| \1 \| \1$/, '$1')
    .replace(/^(.+) \| (.+) \| \2$/, '$1 · $2');
const privateOut = {
  profile: { displayName: identity.displayName, created: user.creationTime, country: user.country },
  incognito: {
    plays: incognitoRows.length,
    hours: +(incognitoRows.reduce((s, r) => s + r.ms_played, 0) / 3.6e6).toFixed(1),
    topArtists: count(incognitoRows, (r) => r.master_metadata_album_artist_name).slice(0, 10),
  },
  inferences: (() => {
    const groups = {};
    for (const x of inferences) {
      const k = x.startsWith('Interest') ? 'Interests' : x.startsWith('Purchase') ? 'Purchase intent' : x.startsWith('3P') ? 'Bought from data brokers (3P)' : x.startsWith('1P') ? 'Spotify’s own segments (1P)' : 'Other';
      (groups[k] ||= []).push(readableSegment(x));
    }
    return groups;
  })(),
  dataRecipients: recipients.map((r) => ({ name: r.name, count: (r.members || []).length, members: r.members })),
  searches: { total: finalSearches.length, top: count(finalSearches, (s) => s.searchQuery.trim().toLowerCase()).slice(0, 25) },
  follow: { following: follow.userIsFollowing || [], followers: (follow.userIsFollowedBy || []).length },
};

// ---------------------------------------------------------------- write
const write = (name, obj) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`  ${name.padEnd(14)} ${(fs.statSync(file).size / 1024).toFixed(0).padStart(6)} KB`);
};
console.log(`Built from ${publicRows.length.toLocaleString()} plays (${incognitoRows.length.toLocaleString()} private-session plays ${INCLUDE_INCOGNITO ? 'included' : 'left out'})`);
write('catalog.json', catalog);
write('plays.json', plays);
write('meta.json', meta);
write('private.json', privateOut);
const known = artistRows.filter((a) => a[1] >= 0).length;
console.log(`Genres known for ${known}/${artistRows.length} artists, release year for ${trackRows.filter((t) => t[4]).length}/${trackRows.length} tracks.`);
