#!/usr/bin/env node
// Get every song you love onto your own devices: playlists first, then liked
// songs, then your most-played songs.
//
//   node scripts/acquire.mjs
//       -> acquire/shopping-list.html  every song with free links (JioSaavn, YouTube Music,
//                                      Bandcamp) and the iTunes price if you want a file
//       -> acquire/shopping-list.csv
//
//   node scripts/acquire.mjs --music "D:\Music"
//       also scans your music folder (mp3/m4a/flac…), ticks off what you already own
//       and writes acquire/playlists/<playlist>.m3u8 pointing at your local files
//
//   node scripts/acquire.mjs --music "D:\Music" --to-mp3
//       also converts the owned non-MP3 files (e.g. iTunes .m4a purchases) to
//       320 kbps MP3 in <music>/_mp3 using ffmpeg (must be on PATH)
//
// Options: --top <n> most-played songs to add after playlists/likes (default 300)
//          --no-lookup  don't query iTunes for songs missing from cache/itunes.json
//          --out <dir>  output folder (default ./acquire)
//
// This script doesn't bulk-rip songs from YouTube or Spotify. It points you to
// free, official routes instead (in-app offline on JioSaavn / YouTube Music,
// free Bandcamp downloads) and organises whatever music folder you already have.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exportDir, streams, rank, account } from './lib/export.mjs';
import { loadCache, saveCache, client } from './lib/itunes.mjs';
import { norm, baseTitle, artistSim } from './lib/match.mjs';
import { readTags, walk } from './lib/tags.mjs';

const argv = process.argv;
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const TOP = +arg('top', 300);
const MUSIC = arg('music', null);
const OUT = path.resolve(arg('out', path.join(ROOT, 'acquire')));
const LOOKUP = !argv.includes('--no-lookup');
const TO_MP3 = argv.includes('--to-mp3');

const dir = exportDir();
const { tracks: played } = rank(streams(dir));
const playlists = (account(dir, 'Playlist1') || {}).playlists || [];
const liked = (account(dir, 'YourLibrary') || {}).tracks || [];

// ------------------------------------------------------------ the list, in priority order
const hoursOf = (uri) => (played.get(uri)?.ms || 0) / 3.6e6;
const sections = playlists
  .map((p) => ({
    kind: 'playlist',
    name: p.name,
    items: (p.items || [])
      .filter((i) => i.track?.trackUri)
      .map((i) => ({ uri: i.track.trackUri, name: i.track.trackName, artist: i.track.artistName, album: i.track.albumName })),
  }))
  .map((s) => ({ ...s, hours: s.items.reduce((h, t) => h + hoursOf(t.uri), 0) }))
  .sort((a, b) => b.hours - a.hours || b.items.length - a.items.length);

const listed = new Set(sections.flatMap((s) => s.items.map((t) => t.uri)));
sections.push({
  kind: 'liked',
  name: 'Liked songs (not in a playlist)',
  items: liked.filter((t) => !listed.has(t.uri)).map((t) => ({ uri: t.uri, name: t.track, artist: t.artist, album: t.album })),
});
for (const t of liked) listed.add(t.uri);
sections.push({
  kind: 'top',
  name: `Most played (top ${TOP} not above)`,
  items: [...played.values()]
    .filter((t) => t.name && t.uri.startsWith('spotify:track:') && !listed.has(t.uri))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, TOP)
    .map((t) => ({ uri: t.uri, name: t.name, artist: t.artist, album: t.album })),
});
const unique = new Map();
for (const s of sections) for (const t of s.items) if (!unique.has(t.uri)) unique.set(t.uri, t);
console.log(`${unique.size} unique songs: ${sections.filter((s) => s.kind === 'playlist').length} playlists first, then liked, then most played.`);

// ------------------------------------------------------------ store lookups (same order)
const cache = loadCache();
const missing = [...unique.values()].filter((t) => !cache.tracks[t.uri]);
if (missing.length && LOOKUP) {
  console.log(`Looking up ${missing.length} songs on iTunes (~${Math.ceil((missing.length * 2.6) / 60)} min, Ctrl+C to stop and keep progress)…`);
  const api = client(cache.country || 'in');
  let n = 0;
  process.on('SIGINT', () => {
    saveCache(cache);
    process.exit(0);
  });
  for (const t of missing) {
    const r = await api.track(t);
    if (r) cache.tracks[t.uri] = r;
    if (++n % 20 === 0) {
      saveCache(cache);
      console.log(`  ${n}/${missing.length}`);
    }
  }
  saveCache(cache);
} else if (missing.length) console.log(`${missing.length} songs not looked up yet (run without --no-lookup).`);

// ------------------------------------------------------------ local library
const owned = new Map(); // uri -> file
if (MUSIC) {
  console.log(`Scanning ${MUSIC} …`);
  const byTitle = new Map();
  let files = 0;
  for (const f of walk(path.resolve(MUSIC))) {
    if (f.includes(`${path.sep}_mp3${path.sep}`) && !TO_MP3) continue;
    const tags = readTags(f);
    files++;
    const key = baseTitle(tags.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push({ file: f, artist: tags.artist });
  }
  for (const t of unique.values()) {
    const cands = byTitle.get(baseTitle(t.name)) || [];
    const hit = cands.find((c) => artistSim(t.artist, c.artist) >= 0.5) || cands.find((c) => norm(c.artist).includes(norm(t.artist).split(' ')[0]));
    if (hit) owned.set(t.uri, hit.file);
  }
  console.log(`  ${files} audio files, ${owned.size} of your songs found.`);
}

// ------------------------------------------------------------ outputs
fs.mkdirSync(OUT, { recursive: true });
const it = (uri) => {
  const r = cache.tracks[uri];
  return r && !r.miss ? r : null;
};
const money = (v, c) => {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: c || 'INR', maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v} ${c}`;
  }
};
const bandcamp = (t) => `https://bandcamp.com/search?q=${encodeURIComponent(`${t.artist} ${t.name}`)}&item_type=t`;
const jiosaavn = (t) => `https://www.jiosaavn.com/search/song/${encodeURIComponent(`${queryName(t.name)} ${t.artist}`)}`;
const ytmusic = (t) => `https://music.youtube.com/search?q=${encodeURIComponent(`${queryName(t.name)} ${t.artist}`)}`;
function queryName(s) {
  return s.replace(/\s+-\s+.*$/, '').replace(/[([][^)\]]*[)\]]/g, '').trim() || s;
}
const spotify = (uri) => `https://open.spotify.com/track/${uri.split(':')[2]}`;
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// CSV
const csvRows = [['section', 'song', 'artist', 'album', 'your_hours', 'owned_file', 'jiosaavn', 'youtube_music', 'bandcamp_search', 'itunes_price', 'currency', 'itunes_url', 'spotify_url']];
for (const s of sections)
  for (const t of s.items) {
    const r = it(t.uri);
    csvRows.push([s.name, t.name, t.artist, t.album, hoursOf(t.uri).toFixed(2), owned.get(t.uri) || '', jiosaavn(t), ytmusic(t), bandcamp(t), r?.p > 0 ? r.p : '', r?.c || '', r?.u || '', spotify(t.uri)]);
  }
fs.writeFileSync(path.join(OUT, 'shopping-list.csv'), '\ufeff' + csvRows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'));

// M3U8 playlists over local files
if (MUSIC) {
  const pdir = path.join(OUT, 'playlists');
  fs.mkdirSync(pdir, { recursive: true });
  for (const s of sections.filter((x) => x.kind === 'playlist')) {
    const lines = ['#EXTM3U', `#PLAYLIST:${s.name}`];
    for (const t of s.items) {
      const f = owned.get(t.uri);
      lines.push(f ? `#EXTINF:-1,${t.artist} - ${t.name}\n${f}` : `# missing: ${t.artist} - ${t.name}`);
    }
    fs.writeFileSync(path.join(pdir, `${s.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'playlist'}.m3u8`), lines.join('\n') + '\n');
  }
}

// Convert owned non-MP3 files to MP3
if (TO_MP3) {
  if (!MUSIC) console.log('--to-mp3 needs --music <folder>.');
  else if (spawnSync('ffmpeg', ['-version']).status !== 0) console.log('ffmpeg not found on PATH: install it (winget install Gyan.FFmpeg) and run again.');
  else {
    const dest = path.join(path.resolve(MUSIC), '_mp3');
    fs.mkdirSync(dest, { recursive: true });
    let made = 0;
    for (const [uri, file] of owned) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.mp3') continue;
      if (ext === '.m4p') {
        console.log(`  skip (DRM-protected): ${file}`);
        continue;
      }
      const t = unique.get(uri);
      const out = path.join(dest, `${t.artist} - ${t.name}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) + '.mp3');
      if (fs.existsSync(out)) continue;
      const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-map', '0:a', '-codec:a', 'libmp3lame', '-b:a', '320k', '-map_metadata', '0', '-id3v2_version', '3', out]);
      if (r.status === 0) made++;
      else console.log(`  failed: ${file}`);
    }
    console.log(`Converted ${made} files to MP3 in ${dest}`);
  }
}

// HTML shopping list
const seen = new Set();
let grand = 0;
let currency = 'INR';
let priced = 0;
let unavailable = 0;
let pending = 0;
const sectionHtml = sections
  .filter((s) => s.items.length)
  .map((s, si) => {
    let cost = 0;
    let have = 0;
    const rows = s.items
      .map((t, i) => {
        const r = it(t.uri);
        const dup = seen.has(t.uri);
        seen.add(t.uri);
        const own = owned.has(t.uri);
        if (own) have++;
        if (r?.p > 0 && !own && !dup) {
          cost += r.p;
          grand += r.p;
          currency = r.c || currency;
          priced++;
        }
        const looked = !!cache.tracks[t.uri];
        if (!dup) looked ? !r && unavailable++ : pending++;
        const buy = r?.p > 0 ? `<a href="${esc(r.u)}" target="_blank" rel="noopener">${esc(money(r.p, r.c))}</a>` : r?.cu ? `<a href="${esc(r.cu)}" target="_blank" rel="noopener">Album only</a>` : `<span class="muted">${looked ? 'Not on iTunes' : 'Not checked yet'}</span>`;
        return `<tr data-uri="${esc(t.uri)}"${own ? ' class="own" data-owned="1"' : ''}>
<td class="n">${i + 1}</td>
<td><strong>${esc(t.name)}</strong><div class="muted">${esc(t.artist)}${dup ? ' · also listed above' : ''}</div></td>
<td class="num">${hoursOf(t.uri) ? hoursOf(t.uri).toFixed(1) + ' h' : ''}</td>
<td class="links"><a href="${esc(jiosaavn(t))}" target="_blank" rel="noopener">JioSaavn</a> · <a href="${esc(ytmusic(t))}" target="_blank" rel="noopener">YT Music</a> · <a href="${esc(bandcamp(t))}" target="_blank" rel="noopener">Bandcamp</a></td>
<td>${buy}</td>
<td><a href="${esc(spotify(t.uri))}" target="_blank" rel="noopener">Spotify</a></td>
<td class="c"><label><input type="checkbox" ${own ? 'checked disabled' : ''} aria-label="I own ${esc(t.name)}"> <span class="muted">${own ? 'in library' : ''}</span></label></td>
</tr>`;
      })
      .join('');
    return `<section><h2><span class="tag">${si + 1}</span> ${esc(s.name)}</h2>
<p class="muted">${s.items.length} songs${MUSIC ? ` · ${have} already in your library` : ''}${cost ? ` · ${esc(money(cost, currency))} for the rest on iTunes` : ''}</p>
<div class="wrap-t"><table><thead><tr><th>#</th><th>Song</th><th class="num">You played</th><th>Free (offline in app / free downloads)</th><th>Buy as a file</th><th>Listen</th><th>Owned</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  })
  .join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Music to own</title>
<style>
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--accent:#1c5cab;--own:#eef6ee}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--accent:#86b6ef;--own:#16261a}}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:28px 0 2px;display:flex;gap:10px;align-items:center}
.tag{font-size:12px;background:var(--grid);border-radius:999px;padding:1px 8px;color:var(--ink2)}
.muted{color:var(--muted);font-size:13px}a{color:var(--accent)}
.note{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:14px 16px;margin:16px 0;color:var(--ink2)}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stat{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:10px 14px;min-width:150px}
.stat b{display:block;font-size:22px}.stat span{font-size:12.5px;color:var(--muted)}
.wrap-t{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--surface);border-radius:12px;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:left;vertical-align:top}th{font-size:12.5px;color:var(--muted);font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.links{white-space:nowrap}.n{color:var(--muted);width:28px}.c{white-space:nowrap}
tr.own,tr.mine{background:var(--own)}body.hide-owned tr.own,body.hide-owned tr.mine{display:none}
.bar{position:sticky;top:0;background:var(--page);padding:10px 0;border-bottom:1px solid var(--grid);z-index:2;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
</style></head><body><main>
<h1>Music to own</h1>
<p class="muted">Generated ${new Date().toISOString().slice(0, 10)} from your Spotify export · playlists first (most-played playlist on top), then liked songs, then your most-played songs.</p>
<div class="stats">
<div class="stat"><b>${unique.size}</b><span>songs on this list</span></div>
${MUSIC ? `<div class="stat"><b>${owned.size}</b><span>already in your library</span></div>` : ''}
<div class="stat"><b>${priced}</b><span>buyable as single tracks on iTunes</span></div>
<div class="stat"><b>${esc(money(grand, currency))}</b><span>to buy all of those</span></div>
<div class="stat"><b>${unavailable}</b><span>not found on iTunes (try Bandcamp)</span></div>
${pending ? `<div class="stat"><b>${pending}</b><span>not checked yet (run again without --no-lookup)</span></div>` : ''}
</div>
<div class="note"><strong>Free first.</strong> JioSaavn and YouTube Music are free with ads and let you save songs for offline listening in the app (JioSaavn Pro and Wynk Premium often come bundled with Jio and Airtel plans). Many artists also offer free or name-your-price downloads on Bandcamp. If you want a file you keep forever, iTunes sells DRM-free 256 kbps tracks for ₹15–18 each.<br><br><strong>Your folder, organised.</strong> Run <code>node scripts/acquire.mjs --music "&lt;your music folder&gt;" --to-mp3</code>: songs you have get ticked off, your Spotify playlists are rebuilt as .m3u8 files over those files, and anything that isn't MP3 is converted to 320 kbps MP3.</div>
<div class="bar"><label><input type="checkbox" id="hide"> Hide songs I own</label><span class="muted" id="count"></span></div>
${sectionHtml}
</main>
<script>
const KEY='music-to-own';let mine={};try{mine=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{}
function sync(){let n=0;document.querySelectorAll('tr[data-uri]').forEach(tr=>{const own=tr.dataset.owned||mine[tr.dataset.uri];tr.classList.toggle('mine',!!mine[tr.dataset.uri]);const cb=tr.querySelector('input');if(!cb.disabled)cb.checked=!!mine[tr.dataset.uri];if(own)n++});document.getElementById('count').textContent=n+' marked as owned'}
document.addEventListener('change',e=>{if(e.target.id==='hide'){document.body.classList.toggle('hide-owned',e.target.checked);return}const tr=e.target.closest('tr[data-uri]');if(!tr)return;if(e.target.checked)mine[tr.dataset.uri]=1;else delete mine[tr.dataset.uri];try{localStorage.setItem(KEY,JSON.stringify(mine))}catch{}sync()});sync();
</script></body></html>`;
fs.writeFileSync(path.join(OUT, 'shopping-list.html'), html);
console.log(`\nWrote ${path.join(OUT, 'shopping-list.html')}`);
console.log(`      ${path.join(OUT, 'shopping-list.csv')}`);
if (MUSIC) console.log(`      ${path.join(OUT, 'playlists')}${path.sep}*.m3u8`);
console.log(`${priced} songs buyable on iTunes for ${money(grand, currency)}; ${unavailable} not found there${pending ? `; ${pending} not checked yet` : ''}.`);
