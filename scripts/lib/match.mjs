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
