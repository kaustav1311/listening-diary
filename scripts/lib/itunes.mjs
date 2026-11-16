// iTunes Search API client + shared cache (cache/itunes.json).
// Several scripts may run at once, so saving merges with what is on disk.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './export.mjs';
import { norm, baseTitle, queryTitle, sim, artistSim } from './match.mjs';

export const CACHE = path.join(ROOT, 'cache', 'itunes.json');

export function loadCache(country = 'in') {
  return fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { country, tracks: {}, artists: {} };
}

export function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const disk = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { tracks: {}, artists: {} };
  const merged = {
    country: cache.country || disk.country,
    tracks: { ...disk.tracks, ...cache.tracks },
    artists: { ...disk.artists, ...cache.artists },
  };
  const tmp = `${CACHE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged));
  fs.renameSync(tmp, CACHE);
  Object.assign(cache.tracks, merged.tracks);
  Object.assign(cache.artists, merged.artists);
}

// Polite, adaptive pacing: Apple documents roughly 20 calls/minute.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function client(country = 'in', log = console.log) {
  let gap = 2600;
  let calm = 0;
  async function search(params) {
    const url = 'https://itunes.apple.com/search?' + new URLSearchParams({ country, ...params });
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(gap);
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': 'personal-listening-dashboard/1.0' } });
      } catch {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        gap = Math.min(Math.round(gap * 1.5), 6000);
        calm = 0;
        const wait = 60000 * (attempt + 1);
        log(`  rate limited (${res.status}); pausing ${wait / 1000}s, gap now ${gap}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null;
      if (++calm > 150 && gap > 2600) {
        gap = Math.max(2600, Math.round(gap * 0.9));
        calm = 0;
      }
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    return null;
  }

  // t: {name, artist, album}. Returns a match, {miss:1}, or null on network failure.
  async function track(t) {
    const q = `${queryTitle(t.name)} ${t.artist}`.slice(0, 120);
    const j = await search({ term: q, entity: 'song', limit: '15' });
    if (!j) return null;
    const want = baseTitle(t.name);
    const wantAlbum = norm(t.album);
    const scored = (j.results || [])
      .filter((r) => r.kind === 'song')
      .map((r) => {
        const ts = Math.max(sim(want, baseTitle(r.trackName)), sim(norm(t.name), norm(r.trackName)));
        const as = artistSim(t.artist, r.artistName);
        const al = sim(wantAlbum, norm(r.collectionName)) > 0.6 ? 0.08 : 0;
        return { r, ts, as, score: 0.6 * ts + 0.4 * as + al };
      })
      .filter((x) => x.ts >= 0.6 && x.as >= 0.5)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return { miss: 1 };
    const best = scored[0];
    // Song year = earliest release among equally good matches (skips later compilations).
    const bestYear = +String(best.r.releaseDate || '').slice(0, 4) || 0;
    const years = scored
      .filter((x) => x.score >= best.score - 0.06)
      .map((x) => +String(x.r.releaseDate || '').slice(0, 4))
      .filter((y) => y > 1900 && (!bestYear || bestYear - y <= 40)); // ignore bogus ancient dates
    const r = best.r;
    return {
      id: r.trackId,
      tn: r.trackName,
      an: r.artistName,
      al: r.collectionName,
      g: r.primaryGenreName,
      y: years.length ? Math.min(...years) : null,
      art: r.artworkUrl100 || null,
      p: r.trackPrice ?? null,
      cp: r.collectionPrice ?? null,
      c: r.currency || null,
      u: r.trackViewUrl || null,
      cu: r.collectionViewUrl || null,
      x: r.trackExplicitness === 'explicit' ? 1 : 0,
      d: r.trackTimeMillis || null,
      s: +best.score.toFixed(2),
    };
  }

  async function artist(name) {
    const j = await search({ term: name.slice(0, 100), entity: 'musicArtist', limit: '5' });
    if (!j) return null;
    const want = norm(name);
    const hit = (j.results || [])
      .map((r) => ({ r, s: norm(r.artistName) === want ? 1 : artistSim(name, r.artistName) }))
      .filter((x) => x.s >= 0.9)
      .sort((a, b) => b.s - a.s)[0];
    if (!hit) return { miss: 1 };
    return { id: hit.r.artistId, g: hit.r.primaryGenreName || null, u: hit.r.artistLinkUrl || null };
  }

  return { track, artist };
}
