// Shared loader for a Spotify privacy export (Account Data, Extended Streaming
// History and Technical Log Information). Nothing here talks to the network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FOLDERS = {
  account: 'Spotify Account Data',
  extended: 'Spotify Extended Streaming History',
  tech: 'Spotify Technical Log Information',
};

// The export lives next to the repo by default (../Spotify Account Data, ...).
// Override with SPOTIFY_EXPORT=<dir> or --data <dir>.
export function exportDir(argv = process.argv) {
  const i = argv.indexOf('--data');
  const dir = i > -1 ? argv[i + 1] : process.env.SPOTIFY_EXPORT || path.resolve(ROOT, '..');
  if (!fs.existsSync(path.join(dir, FOLDERS.extended))) {
    throw new Error(
      `Could not find "${FOLDERS.extended}" inside ${dir}.\n` +
        'Point the scripts at your unzipped export with --data <dir> or SPOTIFY_EXPORT=<dir>.'
    );
  }
  return dir;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function account(dir, name) {
  return readJSON(path.join(dir, FOLDERS.account, `${name}.json`));
}

// Technical logs are arrays of events; return [] when a file is missing.
export function tech(dir, name) {
  const d = readJSON(path.join(dir, FOLDERS.tech, `${name}.json`));
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') return Object.values(d).find(Array.isArray) || [];
  return [];
}

export function techFiles(dir) {
  const p = path.join(dir, FOLDERS.tech);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
}

// Every row of Streaming_History_Audio_*.json and Streaming_History_Video_*.json,
// sorted by time. Video rows are music videos of normal tracks.
export function streams(dir) {
  const p = path.join(dir, FOLDERS.extended);
  const rows = [];
  for (const f of fs.readdirSync(p).sort()) {
    if (!/^Streaming_History_.*\.json$/.test(f)) continue;
    const video = f.includes('_Video_');
    for (const r of readJSON(path.join(p, f)) || []) {
      r._video = video;
      rows.push(r);
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return rows;
}

// Totals per track URI and per artist, used to prioritise metadata lookups.
export function rank(rows) {
  const tracks = new Map();
  const artists = new Map();
  for (const r of rows) {
    if (!r.spotify_track_uri) continue;
    const uri = r.spotify_track_uri;
    let t = tracks.get(uri);
    if (!t) {
      t = {
        uri,
        name: r.master_metadata_track_name,
        artist: r.master_metadata_album_artist_name,
        album: r.master_metadata_album_album_name,
        ms: 0,
      };
      tracks.set(uri, t);
    }
    t.ms += r.ms_played;
    const a = r.master_metadata_album_artist_name;
    artists.set(a, (artists.get(a) || 0) + r.ms_played);
  }
  return { tracks, artists };
}
