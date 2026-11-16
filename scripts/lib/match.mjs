// Fuzzy matching between Spotify titles and catalogue search results.

export function norm(s = '') {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// "Snow (Hey Oh) - 2006 Remaster" -> "snow hey oh"; drops feat./remaster/from-movie noise.
export function baseTitle(s = '') {
  return norm(
    s
      .replace(/\s+-\s+.*$/, (m) => (/remaster|version|edit|mix|live|mono|stereo|from|feat|with|bonus|extended|acoustic|radio/i.test(m) ? '' : m))
      .replace(/[([](?:feat|ft|with|from|prod|remaster|bonus|original|taken|music from)[^)\]]*[)\]]/gi, '')
  );
}

export function queryTitle(s = '') {
  return s
    .replace(/\s+-\s+.*$/, '')
    .replace(/[([][^)\]]*[)\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || s;
}

function tokens(s) {
  return new Set(s.split(' ').filter(Boolean));
}

export function sim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = tokens(a);
  const B = tokens(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const contains = a.includes(b) || b.includes(a) ? 0.85 : 0;
  return Math.max(dice, contains);
}

// Store listings sometimes carry bogus dates (a recent single dated 1927). Drop a
// year that is 40+ years older than the same artist's median release year, and
// any pre-1950 date on a digital "- Single" / "- EP" release.
// items: [{ key, artist, year, album? }] -> Set of keys whose year should be ignored.
export function yearOutliers(items) {
  const out = new Set();
  for (const it of items) if (it.year && it.year < 1950 && /-\s*(single|ep)\s*$/i.test(it.album || '')) out.add(it.key);
  items = items.filter((it) => !out.has(it.key));
  const byArtist = new Map();
  for (const it of items) if (it.year) (byArtist.get(it.artist) || byArtist.set(it.artist, []).get(it.artist)).push(it.year);
  const median = new Map(
    [...byArtist].map(([a, ys]) => {
      const s = ys.slice().sort((x, y) => x - y);
      return [a, s[Math.floor(s.length / 2)]];
    })
  );
  for (const it of items) if (it.year && median.get(it.artist) - it.year > 40) out.add(it.key);
  return out;
}

// The Spotify artist may be one of several credited on the catalogue side
// ("Ali Zafar & Aima Baig"), so check containment first.
export function artistSim(spotifyArtist, catalogueArtist) {
  const a = norm(spotifyArtist);
  const b = norm(catalogueArtist);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  return sim(a, b);
}
