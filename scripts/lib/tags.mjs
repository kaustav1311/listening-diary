// Minimal, dependency-free audio tag readers: ID3v2 (mp3), Vorbis comments
// (flac) and iTunes atoms (m4a/mp4). Falls back to "Artist - Title" filenames.
import fs from 'node:fs';
import path from 'node:path';

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

function decodeText(buf) {
  const enc = buf[0];
  const body = buf.subarray(1);
  let s;
  if (enc === 1 || enc === 2) {
    let b = body;
    let le = enc === 1;
    if (b[0] === 0xff && b[1] === 0xfe) (le = true), (b = b.subarray(2));
    else if (b[0] === 0xfe && b[1] === 0xff) (le = false), (b = b.subarray(2));
    if (!le) {
      const sw = Buffer.from(b);
      for (let i = 0; i + 1 < sw.length; i += 2) [sw[i], sw[i + 1]] = [sw[i + 1], sw[i]];
      b = sw;
    }
    s = b.toString('utf16le');
  } else if (enc === 3) s = body.toString('utf8');
  else s = body.toString('latin1');
  return s.replace(/\u0000+$/, '').split('\u0000')[0].trim();
}

function id3(fd) {
  const head = readAt(fd, 0, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = head[3];
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const tag = readAt(fd, 10, Math.min(size, 4 * 1024 * 1024));
  const out = {};
  const want = ver === 2 ? { TT2: 'title', TP1: 'artist', TAL: 'album' } : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
  let p = 0;
  while (p + (ver === 2 ? 6 : 10) <= tag.length) {
    let id, len, hdr;
    if (ver === 2) {
      id = tag.toString('latin1', p, p + 3);
      len = (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5];
      hdr = 6;
    } else {
      id = tag.toString('latin1', p, p + 4);
      len = ver === 4 ? ((tag[p + 4] & 0x7f) << 21) | ((tag[p + 5] & 0x7f) << 14) | ((tag[p + 6] & 0x7f) << 7) | (tag[p + 7] & 0x7f) : tag.readUInt32BE(p + 4);
      hdr = 10;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0) break;
    if (want[id]) out[want[id]] = decodeText(tag.subarray(p + hdr, p + hdr + len));
    p += hdr + len;
  }
  return out.title ? out : null;
}

function flac(fd) {
  if (readAt(fd, 0, 4).toString('latin1') !== 'fLaC') return null;
  let pos = 4;
  for (let i = 0; i < 64; i++) {
    const h = readAt(fd, pos, 4);
    if (h.length < 4) return null;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) {
      const b = readAt(fd, pos + 4, len);
      let p = 4 + b.readUInt32LE(0);
      const n = b.readUInt32LE(p);
      p += 4;
      const out = {};
      for (let j = 0; j < n && p < b.length; j++) {
        const l = b.readUInt32LE(p);
        const [k, ...v] = b.toString('utf8', p + 4, p + 4 + l).split('=');
        const key = k.toUpperCase();
        if (key === 'TITLE') out.title = v.join('=');
        if (key === 'ARTIST') out.artist = v.join('=');
        if (key === 'ALBUM') out.album = v.join('=');
        p += 4 + l;
      }
      return out.title ? out : null;
    }
    if (last) return null;
    pos += 4 + len;
  }
  return null;
}

function mp4(fd, fileSize) {
  // Find the top-level moov atom without reading the audio.
  let pos = 0;
  let moov = null;
  while (pos + 8 <= fileSize) {
    const h = readAt(fd, pos, 16);
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hdr = 8;
    if (size === 1) (size = Number(h.readBigUInt64BE(8))), (hdr = 16);
    if (size === 0) size = fileSize - pos;
    if (size < hdr) return null;
    if (type === 'moov') {
      moov = readAt(fd, pos + hdr, Math.min(size - hdr, 32 * 1024 * 1024));
      break;
    }
    pos += size;
  }
  if (!moov) return null;
  const children = (buf, from = 0) => {
    const list = [];
    let p = from;
    while (p + 8 <= buf.length) {
      const size = buf.readUInt32BE(p);
      if (size < 8) break;
      list.push({ type: buf.toString('latin1', p + 4, p + 8), body: buf.subarray(p + 8, p + size) });
      p += size;
    }
    return list;
  };
  const find = (buf, type, from) => children(buf, from).find((a) => a.type === type)?.body;
  const udta = find(moov, 'udta');
  const meta = udta && find(udta, 'meta', 0);
  const ilst = meta && find(meta, 'ilst', 4); // meta is a full box: skip version/flags
  if (!ilst) return null;
  const out = {};
  for (const a of children(ilst)) {
    const data = find(a.body, 'data');
    if (!data) continue;
    const text = data.subarray(8).toString('utf8');
    if (a.type === '©nam') out.title = text;
    if (a.type === '©ART') out.artist = text;
    if (a.type === '©alb') out.album = text;
    if (a.type === 'aART' && !out.artist) out.artist = text;
  }
  return out.title ? out : null;
}

export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.m4p', '.mp4', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.alac']);

export function readTags(file) {
  const ext = path.extname(file).toLowerCase();
  let tags = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (ext === '.mp3' || ext === '.aac' || ext === '.wav') tags = id3(fd);
    else if (ext === '.flac') tags = flac(fd);
    else if (ext === '.m4a' || ext === '.m4p' || ext === '.mp4' || ext === '.alac') tags = mp4(fd, size);
  } catch {
    tags = null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (tags?.title && tags?.artist) return tags;
  // Fallback: "Artist - Title.mp3", or "01 Title.mp3" inside an artist folder.
  const base = path.basename(file, ext).replace(/^\d{1,3}[\s.\-_]+/, '');
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: tags?.artist || parts[0], title: tags?.title || parts.slice(1).join(' - ') };
  return { artist: tags?.artist || path.basename(path.dirname(file)), title: tags?.title || base };
}

export function* walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}
