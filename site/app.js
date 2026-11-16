import { columns, lines, heatmap, segmented, legendEl, table, tip, fmt } from './charts.js';
/* global d3 */

const $ = (id) => document.getElementById(id);
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const getJSON = (p) => fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);

document.documentElement.classList.add('loading');
const [catalog, plays, meta, priv] = await Promise.all([getJSON('data/catalog.json'), getJSON('data/plays.json'), getJSON('data/meta.json'), getJSON('data/private.json')]);
document.documentElement.classList.remove('loading');
if (!catalog || !plays) {
  document.querySelector('main').replaceChildren(h('p', 'empty', 'No data yet. Run `node scripts/build.mjs` and reload.'));
  throw new Error('missing data');
}

// ------------------------------------------------------------------ decode
const C = catalog;
const N = plays.t.length;
const T = new Float64Array(N); // local time, seconds (read with UTC getters)
const YEAR = new Int16Array(N);
const MONTH = new Int8Array(N);
const DOW = new Int8Array(N); // 0 = Monday
const HOUR = new Int8Array(N);
const DAY = new Int32Array(N); // days since epoch
const K = plays.k;
const S = plays.s;
{
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += plays.t[i];
    T[i] = acc;
    const d = new Date(acc * 1000);
    YEAR[i] = d.getUTCFullYear();
    MONTH[i] = d.getUTCMonth();
    DOW[i] = (d.getUTCDay() + 6) % 7;
    HOUR[i] = d.getUTCHours();
    DAY[i] = Math.floor(acc / 86400);
  }
}
const REASON_FWD = plays.reasons.indexOf('fwdbtn');
const REASON_TRACKDONE = plays.reasons.indexOf('trackdone');
const nT = C.tracks.length;
const tArtist = new Int32Array(nT);
const tGenre = new Int32Array(nT);
const tFam = new Int8Array(nT);
const tLang = new Int8Array(nT);
const tSleep = new Uint8Array(nT);
C.tracks.forEach((t, i) => {
  const a = C.artists[t[1]];
  tArtist[i] = t[1];
  const g = t[5] >= 0 ? t[5] : a[1];
  tGenre[i] = g;
  const f = g >= 0 ? C.genreFamily[g] : -1;
  tFam[i] = f >= 0 ? f : C.families.length - 1;
  tLang[i] = a[2] >= 0 ? a[2] : C.languages.length - 1;
  tSleep[i] = a[3];
});
const YEARS = [...new Set(YEAR)].sort();
const firstT = T[0];
const lastT = T[N - 1];
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDate = (sec) => dateFmt.format(new Date(sec * 1000));
const fmtMonth = (sec) => monthFmt.format(new Date(sec * 1000));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// All-time facts that do not depend on the filter.
const trackLast = new Float64Array(nT);
const trackAllMs = new Float64Array(nT);
const artistFirst = new Float64Array(C.artists.length).fill(Infinity);
for (let i = 0; i < N; i++) {
  const k = K[i];
  trackLast[k] = T[i];
  trackAllMs[k] += S[i];
  const a = tArtist[k];
  if (T[i] < artistFirst[a]) artistFirst[a] = T[i];
}
const art = (k, size = 100) => {
  const t = C.tracks[k];
  return t && t[6] ? C.artPrefix + t[6] + C.artSuffix.replaceAll('{s}', size) : null;
};
// Artist & album pictures: the cover of their most-played track that has one.
const artistArt = new Int32Array(C.artists.length).fill(-1);
const albumArt = new Int32Array(C.albums.length).fill(-1);
{
  const order = [...trackAllMs.keys()].sort((a, b) => trackAllMs[b] - trackAllMs[a]);
  for (const k of order) {
    if (!C.tracks[k][6]) continue;
    if (artistArt[tArtist[k]] < 0) artistArt[tArtist[k]] = k;
    if (albumArt[C.tracks[k][2]] < 0) albumArt[C.tracks[k][2]] = k;
  }
}

// ------------------------------------------------------------------ state
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const fromHash = () => {
  const y = +location.hash.slice(1);
  return YEARS.includes(y) ? y : 'all';
};
const state = {
  year: fromHash(),
  sleep: store.get('sleep', '0') === '1',
  colorBy: store.get('colorBy', 'genre'),
  rankA: 'hours',
  rankT: 'hours',
  exSort: { k: 'h', dir: -1 },
  exPage: 0,
  exQ: '',
};

function select() {
  const out = [];
  for (let i = 0; i < N; i++) {
    if (state.year !== 'all' && YEAR[i] !== state.year) continue;
    if (!state.sleep && tSleep[K[i]]) continue;
    out.push(i);
  }
  return out;
}

// ------------------------------------------------------------------ colours
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const slotColors = () => [1, 2, 3, 4, 5, 6, 7].map((i) => css(`--s${i}`)).concat(css('--other'));
const inkFor = (i) => (i === 3 ? '#0b0b0b' : '#fff'); // yellow (slot 4) takes near-black text
function seriesFor(kind) {
  const names = kind === 'lang' ? C.languages : C.families;
  const cols = slotColors();
  return names.map((label, i) => ({ key: i, label: i === names.length - 1 ? `${label} & unknown` : label, color: cols[i], ink: inkFor(i) }));
}

// ------------------------------------------------------------------ helpers
const hrs = (sec) => sec / 3600;
function aggregate(sel) {
  const tMs = new Float64Array(nT);
  const tPlays = new Int32Array(nT);
  const tSkips = new Int32Array(nT);
  const tFirst = new Float64Array(nT).fill(Infinity);
  const tLastSel = new Float64Array(nT);
  for (const i of sel) {
    const k = K[i];
    tMs[k] += S[i];
    if (S[i] >= 30) tPlays[k]++;
    if (plays.re[i] === REASON_FWD) tSkips[k]++;
    if (T[i] < tFirst[k]) tFirst[k] = T[i];
    if (T[i] > tLastSel[k]) tLastSel[k] = T[i];
  }
  return { tMs, tPlays, tSkips, tFirst, tLastSel };
}

// ------------------------------------------------------------------ motion helpers
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT_QUART = 'cubic-bezier(0.25, 1, 0.5, 1)';

// Numbers count to their new value from wherever they were (ease-out-expo).
function countTo(el, to, format, { from, duration = 700 } = {}) {
  const start = from ?? el._value ?? 0;
  el._value = to;
  cancelAnimationFrame(el._raf);
  clearTimeout(el._safety);
  if (reducedMotion.matches || document.hidden || start === to) {
    el.textContent = format(to);
    return;
  }
  el.classList.add('counting');
  const t0 = performance.now();
  const done = () => {
    el.textContent = format(to);
    el.classList.remove('counting');
  };
  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    if (p >= 1) return done();
    el.textContent = format(start + (to - start) * (1 - Math.pow(2, -10 * p)));
    el._raf = requestAnimationFrame(step);
  };
  el.textContent = format(start);
  el._raf = requestAnimationFrame(step);
  el._safety = setTimeout(done, duration + 150); // never leave a stale number if frames stall
}

// Entrances play when a block scrolls into view, then again on every period change.
// Content is visible without this; .anim only adds the entrance.
const REVEAL_IDS = ['tiles', 'mosaic', 'time-chart', 'top-artists', 'top-tracks', 'top-albums', 'genre-family', 'genre-list', 'lang-seg', 'lang-year', 'age-chart', 'clock', 'habits', 'eras', 'binges', 'forgotten', 'ends', 'devices', 'playlists', 'tech-tiles', 'volume', 'wr-tiles', 'wr-stories', 'capsule'];
const revealer =
  'IntersectionObserver' in window && !reducedMotion.matches
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add('anim');
            revealer.unobserve(e.target);
          }
        },
        { rootMargin: '0px 0px -10% 0px' }
      )
    : null;

function seg(container, options, current, onPick, label) {
  const prev = container._box;
  const thumb = container._thumb || h('span', 'seg-thumb');
  container.replaceChildren(thumb);
  container._thumb = thumb;
  let active = null;
  for (const [value, text] of options) {
    const b = h('button', null, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    b.addEventListener('click', () => onPick(value));
    container.appendChild(b);
    if (value === current) active = b;
  }
  if (label) container.setAttribute('aria-label', label);
  if (!active) return;
  container.classList.add('has-thumb');
  // FLIP: jump to the new spot, then animate from the old box (transform only).
  const x = active.offsetLeft;
  const w = active.offsetWidth;
  thumb.style.width = `${w}px`;
  thumb.style.transform = `translateX(${x}px)`;
  if (prev && (prev.x !== x || prev.w !== w) && !reducedMotion.matches && thumb.animate)
    thumb.animate([{ transform: `translateX(${prev.x}px) scaleX(${prev.w / w})` }, { transform: `translateX(${x}px)` }], { duration: 260, easing: EASE_OUT_QUART });
  container._box = { x, w };
  if (container.scrollWidth > container.clientWidth)
    container.scrollTo({ left: x - container.clientWidth / 2 + w / 2, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// Tiles remember their last number so a period change counts from old to new.
const tileMemory = new Map();
function tile(label, value, note) {
  const t = h('div', 'tile');
  const v = h('div', 't-value');
  t.append(h('div', 't-label', label), v);
  if (value && typeof value === 'object') {
    countTo(v, value.n, value.fmt, { from: tileMemory.get(label) ?? 0 });
    tileMemory.set(label, value.n);
  } else v.textContent = value;
  if (note) t.appendChild(h('div', 't-note', note));
  return t;
}
const stagger = (els) => els.forEach((el, i) => el && el.style.setProperty('--i', i));

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>';
function thumb(k, letter) {
  const box = h('span', 'art');
  const src = k >= 0 ? art(k, 100) : null;
  if (src) {
    const img = h('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    box.appendChild(img);
  } else box.appendChild(h('span', 'noart', (letter || '♪').slice(0, 1).toUpperCase()));
  const overlay = h('span', 'art-play');
  overlay.innerHTML = PLAY_ICON; // static markup, no data
  box.appendChild(overlay);
  return box;
}
const eqMark = () => {
  const eq = h('span', 'eq');
  eq.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) eq.appendChild(h('i'));
  return eq;
};

// Player: Spotify's own embed. With their iFrame API we also hear when music
// plays or pauses, so the page can show what's playing.
const player = { controller: null, k: -1, paused: true };
function markNowPlaying() {
  const open = $('player').classList.contains('open');
  document.querySelectorAll('li.now').forEach((li) => li.classList.remove('now'));
  if (open && player.k >= 0) document.querySelectorAll(`li[data-k="${player.k}"]`).forEach((li) => li.classList.add('now'));
  document.documentElement.classList.toggle('is-playing', open && player.k >= 0 && !player.paused);
}
function embedController(uri) {
  const host = h('div');
  $('player-embed').replaceChildren(host);
  window.__spotifyApi.createController(host, { uri, width: '100%', height: 80 }, (c) => {
    player.controller = c;
    c.addListener('playback_update', (e) => {
      player.paused = !!e.data?.isPaused;
      markNowPlaying();
    });
    c.addListener('ready', () => c.play());
  });
}
function play(k) {
  const id = C.tracks[k]?.[3];
  if (!id) return;
  const uri = `spotify:track:${id}`;
  player.k = k;
  player.paused = true;
  if (player.controller) {
    player.controller.loadUri(uri);
    player.controller.play();
  } else if (window.__spotifyApi) embedController(uri);
  else {
    const f = h('iframe');
    f.title = 'Spotify player';
    f.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    f.src = `https://open.spotify.com/embed/track/${id}?utm_source=generator`;
    $('player-embed').replaceChildren(f);
  }
  $('player').classList.add('open');
  $('player').setAttribute('aria-hidden', 'false');
  markNowPlaying();
}
$('player-close').addEventListener('click', () => {
  player.controller?.pause();
  if (!player.controller) $('player-embed').replaceChildren();
  $('player').classList.remove('open');
  $('player').setAttribute('aria-hidden', 'true');
  player.k = -1;
  markNowPlaying();
});
function playable(li, k) {
  li.classList.add('playable');
  li.dataset.k = k;
  li.tabIndex = 0;
  li.title = 'Play on Spotify';
  li.addEventListener('click', () => play(k));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      play(k);
    }
  });
}

// Ambient glow: the period's #1 cover, blurred, crossfading on change.
function setGlow(src) {
  const box = $('hero-glow');
  if (!src || box._src === src) return;
  box._src = src;
  const layer = h('span');
  layer.style.backgroundImage = `url("${src.replace(/["\\\s]/g, '')}")`;
  box.appendChild(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('on')));
  for (const old of [...box.children].slice(0, -1)) {
    old.classList.remove('on');
    setTimeout(() => old.remove(), 1000);
  }
}

function topRow(rank, imgEl, name, by, value, sub, frac) {
  const li = h('li');
  li.style.setProperty('--i', rank - 1);
  const what = h('div', 'what');
  what.append(h('div', 'name', name), h('div', 'by', by));
  const bar = h('div', 'inbar');
  bar.style.width = `${Math.max(2, frac * 100)}%`;
  bar.style.setProperty('--i', rank - 1);
  what.appendChild(bar);
  const val = h('div', 'val', value);
  if (sub) val.appendChild(h('small', null, sub));
  const r = h('span', 'rank');
  r.append(h('span', 'num', String(rank)), eqMark());
  li.append(r, imgEl, what, val);
  return li;
}

function barList(ol, rows, valueFormat = fmt.hours) {
  ol.replaceChildren();
  const max = d3.max(rows, (r) => r.value) || 1;
  for (const [n, r] of rows.entries()) {
    const li = h('li');
    li.style.setProperty('--i', n);
    const lab = h('span', 'bl-label', r.label);
    lab.title = r.label;
    const track = h('div', 'bl-track');
    const bar = h('div', 'bl-bar');
    bar.style.width = `${(r.value / max) * 82}%`;
    bar.style.background = r.color || css('--s1');
    bar.tabIndex = 0;
    const show = (e) => tip.show(e, r.label, [{ value: valueFormat(r.value), label: r.note || 'listened', color: r.color }]);
    bar.addEventListener('pointermove', show);
    bar.addEventListener('focus', show);
    bar.addEventListener('pointerleave', () => tip.hide());
    bar.addEventListener('blur', () => tip.hide());
    track.append(bar, h('span', 'bl-val', r.valueText || valueFormat(r.value)));
    li.append(lab, track);
    ol.appendChild(li);
  }
}

// ------------------------------------------------------------------ sections
function renderFilters() {
  seg($('years'), [['all', 'All time'], ...YEARS.map((y) => [y, String(y)])], state.year, (y) => setYear(y));
  $('sleep').checked = state.sleep;
}

function renderHero(sel, A) {
  let sec = 0;
  let streams = 0;
  let skips = 0;
  const days = new Set();
  const artistsSeen = new Set();
  let sleepSec = 0;
  for (const i of sel) {
    sec += S[i];
    if (S[i] >= 30) streams++;
    if (plays.re[i] === REASON_FWD) skips++;
    days.add(DAY[i]);
    artistsSeen.add(tArtist[K[i]]);
  }
  if (!state.sleep) for (let i = 0; i < N; i++) if (tSleep[K[i]] && (state.year === 'all' || YEAR[i] === state.year)) sleepSec += S[i];
  $('sleep-note').textContent = !state.sleep && sleepSec > 3600 ? `${fmt.hours(hrs(sleepSec))} hidden` : '';

  const songs = A.tPlays.reduce((n, p, k) => n + (A.tMs[k] > 0 ? 1 : 0), 0);
  const y0 = state.year === 'all' ? -Infinity : Date.UTC(state.year, 0, 1) / 1000;
  const y1 = state.year === 'all' ? Infinity : Date.UTC(state.year + 1, 0, 1) / 1000;
  let fresh = 0;
  for (const a of artistsSeen) if (artistFirst[a] >= y0 && artistFirst[a] < y1) fresh++;
  const sortedDays = [...days].sort((a, b) => a - b);
  let streak = sortedDays.length ? 1 : 0;
  let run = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    run = sortedDays[i] - sortedDays[i - 1] === 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }

  countTo($('hero-hours'), hrs(sec), (v) => `${fmt.int(v)} hours`, { duration: 900 });
  const period = state.year === 'all' ? `since ${fmtMonth(firstT)}` : `in ${state.year}`;
  $('hero-sub').textContent = `That’s ${(hrs(sec) / 24).toFixed(1)} days of non-stop music ${period}, about ${fmt.hours(hrs(sec) / Math.max(1, days.size))} on a day you pressed play.`;
  const n = (value, f = fmt.int) => ({ n: value, fmt: f });
  const tiles = [
    tile('Streams', n(streams, fmt.compact), '30 seconds or more'),
    tile('Songs', n(songs)),
    tile('Artists', n(artistsSeen.size)),
    state.year === 'all' ? tile('Albums', n(new Set(sel.map((i) => C.tracks[K[i]][2])).size)) : tile('New artists', n(fresh), 'first heard this year'),
    tile('Days listening', n(days.size)),
    tile('Longest streak', n(streak, (v) => `${Math.round(v)} days`)),
    tile('Skipped', n(skips / Math.max(1, sel.length), (v) => fmt.pct(v)), 'of plays, with next'),
  ];
  stagger(tiles);
  $('tiles').replaceChildren(...tiles);

  // Mosaic of the period's most-played covers; each one plays its top song.
  const order = [...A.tMs.keys()].filter((k) => A.tMs[k] > 0 && C.tracks[k][6]).sort((a, b) => A.tMs[b] - A.tMs[a]);
  const seen = new Set();
  const mosaic = $('mosaic');
  mosaic.replaceChildren();
  for (const k of order) {
    const al = C.tracks[k][2];
    if (seen.has(al)) continue;
    seen.add(al);
    const b = h('button', 'mosaic-item');
    b.type = 'button';
    b.style.setProperty('--i', seen.size - 1);
    const label = `Play ${C.tracks[k][0]} by ${C.artists[C.tracks[k][1]][0]}`;
    b.setAttribute('aria-label', label);
    b.title = label;
    const img = h('img');
    img.src = art(k, 300);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    b.appendChild(img);
    b.addEventListener('click', () => play(k));
    mosaic.appendChild(b);
    if (seen.size === 12) break;
  }
  mosaic.hidden = seen.size < 4;
  setGlow(order.length ? art(order[0], 300) : null);
}

function renderTimeline(sel) {
  seg($('colorby'), [['genre', 'Genre'], ['lang', 'Language']], state.colorBy, (v) => {
    state.colorBy = v;
    store.set('colorBy', v);
    renderTimeline(select());
  });
  const series = seriesFor(state.colorBy);
  const keyOf = state.colorBy === 'lang' ? (k) => tLang[k] : (k) => tFam[k];
  let bins;
  if (state.year === 'all') {
    const first = YEAR[0] * 12 + MONTH[0];
    const last = YEAR[N - 1] * 12 + MONTH[N - 1];
    bins = d3.range(first, last + 1).map((m) => ({ key: m, label: m % 12 === 0 || (m === first && m % 12 < 9) ? String(Math.floor(m / 12)) : '', title: `${MONTHS[m % 12]} ${Math.floor(m / 12)}`, year: Math.floor(m / 12), values: {} }));
    const base = first;
    for (const i of sel) {
      const b = bins[YEAR[i] * 12 + MONTH[i] - base];
      const s = keyOf(K[i]);
      b.values[s] = (b.values[s] || 0) + hrs(S[i]);
    }
    $('time-sub').textContent = 'Hours per month. Click a column to zoom into that year.';
  } else {
    const start = Date.UTC(state.year, 0, 1) / 86400000; // ms -> days since epoch, same unit as DAY
    bins = d3.range(0, 53).map((w) => {
      const d = new Date((start + w * 7) * 86400000);
      return { key: w, label: d.getUTCDate() <= 7 ? MONTHS[d.getUTCMonth()] : '', title: `Week of ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, values: {} };
    });
    for (const i of sel) {
      const b = bins[Math.min(52, Math.floor((DAY[i] - start) / 7))];
      const s = keyOf(K[i]);
      b.values[s] = (b.values[s] || 0) + hrs(S[i]);
    }
    $('time-sub').textContent = `Hours per week in ${state.year}.`;
  }
  const used = series.filter((s) => bins.some((b) => b.values[s.key]));
  $('time-legend').replaceChildren(legendEl(used));
  columns($('time-chart'), {
    bins,
    series: used,
    height: 280,
    tickEvery: state.year === 'all' ? 1 : 1,
    yFormat: (v) => `${fmt.compact(v)} h`,
    valueFormat: fmt.hours,
    onPick: state.year === 'all' ? (b) => setYear(b.year) : null,
  });
  table($('time-table'), {
    columns: [{ label: state.year === 'all' ? 'Month' : 'Week', value: (b) => b.title }, ...used.map((s) => ({ label: s.label, num: true, value: (b) => (b.values[s.key] ? b.values[s.key].toFixed(1) : '') })), { label: 'Total h', num: true, value: (b) => d3.sum(Object.values(b.values)).toFixed(1) }],
    rows: bins.filter((b) => Object.keys(b.values).length),
  });
}

function renderTop(sel, A) {
  // Artists
  const aMs = new Float64Array(C.artists.length);
  const aPlays = new Int32Array(C.artists.length);
  const aTracks = new Map();
  for (let k = 0; k < nT; k++) {
    if (!A.tMs[k]) continue;
    const a = tArtist[k];
    aMs[a] += A.tMs[k];
    aPlays[a] += A.tPlays[k];
    aTracks.set(a, (aTracks.get(a) || 0) + 1);
  }
  const by = (arrH, arrP, mode) => (mode === 'plays' ? (i) => arrP[i] : (i) => arrH[i]);
  seg($('rank-artists'), [['hours', 'Hours'], ['plays', 'Plays']], state.rankA, (v) => {
    state.rankA = v;
    renderTop(select(), A);
  });
  seg($('rank-tracks'), [['hours', 'Hours'], ['plays', 'Plays']], state.rankT, (v) => {
    state.rankT = v;
    renderTop(select(), A);
  });
  const fa = by(aMs, aPlays, state.rankA);
  const topA = [...aMs.keys()].filter((a) => aMs[a] > 0).sort((x, y) => fa(y) - fa(x)).slice(0, 10);
  const ol = $('top-artists');
  ol.replaceChildren();
  topA.forEach((a, i) => {
    const g = C.artists[a][1] >= 0 ? C.genres[C.artists[a][1]] : '';
    const li = topRow(i + 1, thumb(artistArt[a], C.artists[a][0]), C.artists[a][0], [g, `${aTracks.get(a)} songs`].filter(Boolean).join(' · '), state.rankA === 'plays' ? `${fmt.int(aPlays[a])} plays` : fmt.hours(hrs(aMs[a])), state.rankA === 'plays' ? fmt.hours(hrs(aMs[a])) : `${fmt.int(aPlays[a])} plays`, fa(a) / fa(topA[0]));
    if (artistArt[a] >= 0) {
      // play their most-played song
      let best = -1;
      for (let k = 0; k < nT; k++) if (tArtist[k] === a && (best < 0 || A.tMs[k] > A.tMs[best])) best = k;
      playable(li, best);
    }
    ol.appendChild(li);
  });

  // Tracks
  const ft = by(A.tMs, A.tPlays, state.rankT);
  const topT = [...A.tMs.keys()].filter((k) => A.tMs[k] > 0).sort((x, y) => ft(y) - ft(x)).slice(0, 10);
  const ot = $('top-tracks');
  ot.replaceChildren();
  topT.forEach((k, i) => {
    const t = C.tracks[k];
    const li = topRow(i + 1, thumb(k, t[0]), t[0], C.artists[t[1]][0], state.rankT === 'plays' ? `${fmt.int(A.tPlays[k])} plays` : fmt.hours(hrs(A.tMs[k])), state.rankT === 'plays' ? fmt.hours(hrs(A.tMs[k])) : `${fmt.int(A.tPlays[k])} plays`, ft(k) / ft(topT[0]));
    playable(li, k);
    ot.appendChild(li);
  });

  // Albums
  const alMs = new Float64Array(C.albums.length);
  const alBest = new Int32Array(C.albums.length).fill(-1);
  for (let k = 0; k < nT; k++) {
    if (!A.tMs[k]) continue;
    const al = C.tracks[k][2];
    alMs[al] += A.tMs[k];
    if (alBest[al] < 0 || A.tMs[k] > A.tMs[alBest[al]]) alBest[al] = k;
  }
  const topAl = [...alMs.keys()].filter((a) => alMs[a] > 0).sort((x, y) => alMs[y] - alMs[x]).slice(0, 10);
  const oa = $('top-albums');
  oa.replaceChildren();
  topAl.forEach((al, i) => {
    const [name, a] = C.albums[al];
    const li = topRow(i + 1, thumb(albumArt[al] >= 0 ? albumArt[al] : alBest[al], name), name, C.artists[a][0], fmt.hours(hrs(alMs[al])), null, alMs[al] / alMs[topAl[0]]);
    playable(li, alBest[al]);
    oa.appendChild(li);
  });
}

function renderGenres(sel) {
  const fam = new Float64Array(C.families.length);
  const gen = new Map();
  let known = 0;
  let total = 0;
  for (const i of sel) {
    const k = K[i];
    const v = hrs(S[i]);
    fam[tFam[k]] += v;
    total += v;
    if (tGenre[k] >= 0) {
      known += v;
      gen.set(tGenre[k], (gen.get(tGenre[k]) || 0) + v);
    }
  }
  $('genre-sub').textContent = `Genre known for ${fmt.pct(known / Math.max(1e-9, total))} of this listening time. Bars are coloured by genre family.`;
  const series = seriesFor('genre');
  segmented($('genre-family'), { parts: series.map((s) => ({ label: s.label, value: fam[s.key], color: s.color, ink: s.ink })) });
  const cols = slotColors();
  barList(
    $('genre-list'),
    [...gen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([g, v]) => {
        const f = C.genreFamily[g] >= 0 ? C.genreFamily[g] : C.families.length - 1;
        return { label: C.genres[g], value: v, color: cols[f], note: C.families[f] };
      })
  );
}

function renderLangs(sel) {
  const series = seriesFor('lang');
  const tot = new Float64Array(C.languages.length);
  for (const i of sel) tot[tLang[K[i]]] += hrs(S[i]);
  segmented($('lang-seg'), { parts: series.map((s) => ({ label: s.label, value: tot[s.key], color: s.color, ink: s.ink })) });

  const useMonths = state.year !== 'all';
  const keys = useMonths ? d3.range(12) : YEARS;
  const bins = keys.map((key) => ({ key, label: useMonths ? MONTHS[key] : String(key), title: useMonths ? `${MONTHS[key]} ${state.year}` : String(key), values: {} }));
  for (const i of sel) {
    const b = bins[useMonths ? MONTH[i] : YEARS.indexOf(YEAR[i])];
    const l = tLang[K[i]];
    b.values[l] = (b.values[l] || 0) + hrs(S[i]);
  }
  // 100% stacked: convert to shares
  for (const b of bins) {
    const s = d3.sum(Object.values(b.values));
    b.raw = { ...b.values };
    if (s) for (const k in b.values) b.values[k] /= s;
  }
  $('lang-year-h').textContent = useMonths ? `Language mix by month, ${state.year}` : 'Language mix by year';
  const used = series.filter((s) => bins.some((b) => b.values[s.key]));
  columns($('lang-year'), { bins, series: used, height: 220, yFormat: (v) => fmt.pct(v), valueFormat: (v) => fmt.pct(v, 1), onPick: useMonths ? null : (b) => setYear(b.key) });
  table($('lang-table'), {
    columns: [{ label: useMonths ? 'Month' : 'Year', value: (b) => b.title }, ...used.map((s) => ({ label: `${s.label} (h)`, num: true, value: (b) => (b.raw[s.key] ? b.raw[s.key].toFixed(1) : '') }))],
    rows: bins,
  });
}

function renderAge(sel) {
  const byYear = new Map();
  let known = 0;
  let total = 0;
  let lagSum = 0;
  const weighted = [];
  let oldest = -1;
  for (const i of sel) {
    const k = K[i];
    const v = hrs(S[i]);
    total += v;
    const ry = C.tracks[k][4];
    if (!ry) continue;
    known += v;
    byYear.set(ry, (byYear.get(ry) || 0) + v);
    lagSum += (YEAR[i] - ry) * v;
    weighted.push([ry, v]);
    if (S[i] >= 30 && (oldest < 0 || ry < C.tracks[oldest][4])) oldest = k;
  }
  weighted.sort((a, b) => a[0] - b[0]);
  let half = known / 2;
  let median = null;
  for (const [y, v] of weighted) {
    half -= v;
    if (half <= 0) {
      median = y;
      break;
    }
  }
  const pre2010 = d3.sum([...byYear].filter(([y]) => y < 2010), (d) => d[1]);
  $('age-sub').textContent = known
    ? `Release year known for ${fmt.pct(known / total)} of this listening. Hours by the year each song first came out.`
    : 'Release years appear here once scripts/enrich.mjs has looked songs up.';
  $('age-tiles').replaceChildren(
    tile('Median release year', median ? String(median) : '—'),
    tile('Before 2010', known ? fmt.pct(pre2010 / known) : '—'),
    tile('Oldest song played', oldest >= 0 ? `${C.tracks[oldest][4]}` : '—', oldest >= 0 ? `${C.tracks[oldest][0]} — ${C.artists[C.tracks[oldest][1]][0]}` : null)
  );
  if (!known) {
    $('age-chart').replaceChildren(h('p', 'empty', 'No release years yet.'));
    return;
  }
  const y0 = Math.max(Math.min(...byYear.keys()), 1950);
  const y1 = Math.max(...byYear.keys());
  const bins = d3.range(y0, y1 + 1).map((y) => ({ key: y, label: y % 5 === 0 ? String(y) : '', title: String(y), values: { 0: byYear.get(y) || 0 } }));
  columns($('age-chart'), { bins, series: [{ key: 0, label: 'Hours', color: css('--s1') }], height: 220, yFormat: (v) => `${fmt.compact(v)} h`, valueFormat: fmt.hours, tickEvery: 1 });
  table($('age-table'), { columns: [{ label: 'Release year', value: (b) => b.title }, { label: 'Hours', num: true, value: (b) => b.values[0].toFixed(1) }], rows: bins.filter((b) => b.values[0] > 0) });
  void lagSum;
}

function renderClock(sel) {
  const grid = d3.range(7).map(() => new Array(24).fill(0));
  for (const i of sel) grid[DOW[i]][HOUR[i]] += hrs(S[i]);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hourLabel = (c) => (c === 0 ? '12a' : c < 12 ? `${c}a` : c === 12 ? '12p' : `${c - 12}p`);
  let best = [0, 0];
  grid.forEach((r, d) => r.forEach((v, hh) => v > grid[best[0]][best[1]] && (best = [d, hh])));
  const byHour = d3.range(24).map((hh) => d3.sum(grid, (r) => r[hh]));
  const night = d3.sum(byHour.slice(0, 6));
  const total = d3.sum(byHour) || 1;
  $('clock-sub').textContent = `Busiest slot: ${['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][best[0]]} around ${hourLabel(best[1])}m. ${fmt.pct(night / total)} of your listening happens between midnight and 6 am.`;

  // "You are here": where right now falls in your week, and how busy that hour usually is.
  const now = new Date();
  const nowRow = (now.getDay() + 6) % 7;
  const nowHour = now.getHours();
  const rank = 1 + byHour.filter((v) => v > byHour[nowHour]).length;
  const clock = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
  const logged = fmt.hours(byHour[nowHour]);
  const nowText =
    rank === 1
      ? `It’s ${clock} now: your busiest hour of the day (${logged} so far).`
      : rank <= 6
        ? `It’s ${clock} now: your ${ordinal(rank)}-busiest hour, ${logged} logged.`
        : rank >= 19
          ? `It’s ${clock} now: one of your quietest hours, just ${logged}.`
          : `It’s ${clock} now: ${logged} logged at this hour (outlined).`;
  $('clock-sub').append(' ', h('span', 'now-line', nowText));

  const ramp = [1, 2, 3, 4, 5, 6, 7].map((i) => css(`--seq-${i}`));
  heatmap($('clock'), { grid, rowLabels: days, colLabel: hourLabel, ramp, mark: [nowRow, nowHour] });
  const lg = $('clock-legend');
  lg.replaceChildren(h('span', null, 'Less'));
  for (const c of ramp) {
    const s = h('span', 'sw');
    s.style.background = c;
    lg.appendChild(s);
  }
  lg.appendChild(h('span', null, 'More'));
}

function renderHabits(sel) {
  const byMonth = state.year !== 'all';
  const keys = byMonth ? d3.range(12) : YEARS;
  const agg = new Map(keys.map((k) => [k, { n: 0, sh: 0, sk: 0 }]));
  for (const i of sel) {
    const o = agg.get(byMonth ? MONTH[i] : YEAR[i]);
    o.n++;
    if (plays.f[i] & 1) o.sh++;
    if (plays.re[i] === REASON_FWD) o.sk++;
  }
  const points = keys.filter((k) => agg.get(k).n > 20).map((k) => ({ key: k, label: byMonth ? MONTHS[k] : String(k) }));
  const series = [
    { key: 'sh', label: 'Shuffle', color: css('--s1'), values: Object.fromEntries(points.map((p) => [p.key, agg.get(p.key).sh / agg.get(p.key).n])) },
    { key: 'sk', label: 'Skipped', color: css('--s2'), values: Object.fromEntries(points.map((p) => [p.key, agg.get(p.key).sk / agg.get(p.key).n])) },
  ];
  $('habit-legend').replaceChildren(legendEl(series, 'line'));
  if (points.length < 2) {
    $('habits').replaceChildren(h('p', 'empty', 'Not enough plays to chart.'));
    return;
  }
  lines($('habits'), { points, series, height: 230 });
}

function renderEras() {
  const box = $('eras');
  box.replaceChildren();
  for (const y of YEARS) {
    const sel = [];
    for (let i = 0; i < N; i++) if (YEAR[i] === y && (state.sleep || !tSleep[K[i]])) sel.push(i);
    const A = aggregate(sel);
    const aMs = new Float64Array(C.artists.length);
    let sec = 0;
    for (let k = 0; k < nT; k++) if (A.tMs[k]) aMs[tArtist[k]] += A.tMs[k];
    for (const i of sel) sec += S[i];
    const topA = d3.maxIndex(aMs);
    const topT = d3.maxIndex(A.tMs);
    let fresh = 0;
    const y0 = Date.UTC(y, 0, 1) / 1000;
    const y1 = Date.UTC(y + 1, 0, 1) / 1000;
    for (let a = 0; a < C.artists.length; a++) if (aMs[a] && artistFirst[a] >= y0 && artistFirst[a] < y1) fresh++;
    const b = h('button', 'era');
    b.type = 'button';
    b.style.setProperty('--i', YEARS.indexOf(y));
    b.setAttribute('aria-pressed', String(state.year === y));
    const yr = h('div', 'yr', String(y));
    yr.appendChild(h('small', null, fmt.hours(hrs(sec))));
    const row = (k, label, value, letter) => {
      const r = h('div', 'row');
      const t = h('div');
      t.append(h('div', 'k', label), h('div', 'v', value));
      r.append(thumb(k, letter), t);
      return r;
    };
    b.append(
      yr,
      row(artistArt[topA], '#1 artist', C.artists[topA][0], C.artists[topA][0]),
      row(topT, '#1 song', C.tracks[topT][0], C.tracks[topT][0]),
      h('div', 'k', `${fmt.int(fresh)} new artists`)
    );
    b.addEventListener('click', () => setYear(state.year === y ? 'all' : y));
    box.appendChild(b);
  }
}

function renderBinges(sel) {
  const m = new Map();
  for (const i of sel) {
    if (S[i] < 30) continue;
    const key = DAY[i] * 1e6 + K[i];
    m.set(key, (m.get(key) || 0) + 1);
  }
  const seenTrack = new Set();
  const top = [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([key]) => !seenTrack.has(key % 1e6) && seenTrack.add(key % 1e6))
    .slice(0, 8);
  const ol = $('binges');
  ol.replaceChildren();
  top.forEach(([key, n], i) => {
    const k = key % 1e6;
    const day = Math.floor(key / 1e6);
    const t = C.tracks[k];
    const li = topRow(i + 1, thumb(k, t[0]), t[0], `${C.artists[t[1]][0]} · ${fmtDate(day * 86400)}`, `${n}×`, 'in one day', n / top[0][1]);
    playable(li, k);
    ol.appendChild(li);
  });
}

function renderForgotten(sel, A) {
  const cutoff = lastT - 365 * 86400;
  const top = [...A.tMs.keys()].filter((k) => A.tMs[k] > 1800 && trackLast[k] < cutoff).sort((a, b) => A.tMs[b] - A.tMs[a]).slice(0, 8);
  $('forgot-sub').textContent = `Songs you loved${state.year === 'all' ? '' : ` in ${state.year}`} that you haven’t played since ${fmtMonth(cutoff)}.`;
  const ol = $('forgotten');
  ol.replaceChildren();
  if (!top.length) ol.appendChild(h('li', 'empty', 'You’re still playing everything you loved then.'));
  top.forEach((k, i) => {
    const t = C.tracks[k];
    const li = topRow(i + 1, thumb(k, t[0]), t[0], `${C.artists[t[1]][0]} · last played ${fmtMonth(trackLast[k])}`, fmt.hours(hrs(A.tMs[k])), `${A.tPlays[k]} plays`, A.tMs[k] / A.tMs[top[0]]);
    playable(li, k);
    ol.appendChild(li);
  });
}

const END_LABELS = {
  trackdone: 'Played to the end',
  fwdbtn: 'Skipped to next',
  endplay: 'Stopped or paused',
  logout: 'App closed',
  backbtn: 'Went back',
  'unexpected-exit-while-paused': 'App killed while paused',
  'unexpected-exit': 'App crashed or killed',
  remote: 'Another device took over',
  trackerror: 'Playback error',
  unknown: 'Unknown',
};
function renderEnds(sel) {
  const c = new Map();
  for (const i of sel) c.set(plays.re[i], (c.get(plays.re[i]) || 0) + 1);
  const total = sel.length || 1;
  barList(
    $('ends'),
    [...c.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([r, n]) => ({ label: END_LABELS[plays.reasons[r]] || plays.reasons[r], value: n, valueText: `${fmt.pct(n / total)} · ${fmt.compact(n)}`, note: 'plays', color: css('--s1') })),
    fmt.int
  );
  void REASON_TRACKDONE;
}

// Device colour follows the device (fixed by all-time volume), never the filter.
const deviceOrder = (() => {
  const c = new Map();
  for (let i = 0; i < N; i++) c.set(plays.p[i], (c.get(plays.p[i]) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
})();
function renderDevices(sel) {
  const cols = slotColors();
  const slots = new Map(deviceOrder.slice(0, 7).map((p, i) => [p, i]));
  const series = [...deviceOrder.slice(0, 7).map((p, i) => ({ key: i, label: plays.platforms[p], color: cols[i] })), { key: 7, label: 'Other', color: cols[7] }];
  const byMonth = state.year !== 'all';
  const keys = byMonth ? d3.range(12) : YEARS;
  const bins = keys.map((key) => ({ key, label: byMonth ? MONTHS[key] : String(key), title: byMonth ? `${MONTHS[key]} ${state.year}` : String(key), values: {} }));
  const cc = new Map();
  for (const i of sel) {
    const b = bins[byMonth ? MONTH[i] : YEARS.indexOf(YEAR[i])];
    const s = slots.has(plays.p[i]) ? slots.get(plays.p[i]) : 7;
    b.values[s] = (b.values[s] || 0) + 1;
    cc.set(plays.c[i], (cc.get(plays.c[i]) || 0) + 1);
  }
  const used = series.filter((s) => bins.some((b) => b.values[s.key]));
  $('dev-legend').replaceChildren(legendEl(used));
  columns($('devices'), { bins, series: used, height: 220, yFormat: fmt.compact, valueFormat: (v) => `${fmt.int(v)} plays`, onPick: byMonth ? null : (b) => setYear(b.key) });
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const abroad = [...cc.entries()].filter(([c]) => plays.countries[c] !== 'IN').sort((a, b) => b[1] - a[1]);
  $('countries').textContent = abroad.length
    ? `Listening abroad: ${abroad
        .map(([c, n]) => {
          let name = plays.countries[c];
          try {
            name = names.of(name);
          } catch {}
          return `${name} (${fmt.int(n)})`;
        })
        .join(', ')}.`
    : '';
}

function renderLibrary() {
  if (!meta) return;
  const liked = meta.library.liked.filter((k) => k >= 0);
  const barely = liked.filter((k) => trackAllMs[k] < 90).length;
  $('lib-sub').textContent = `${fmt.int(liked.length)} liked songs (${fmt.int(barely)} of them you’ve barely played), ${meta.library.artists.length} followed artists, ${meta.playlists.length} playlists. The thin bars show each playlist’s language mix.`;
  const box = $('playlists');
  box.replaceChildren();
  const series = seriesFor('lang');
  for (const p of [...meta.playlists].sort((a, b) => b.tracks.length - a.tracks.length)) {
    const card = h('div', 'pl');
    let sec = 0;
    const mix = new Float64Array(C.languages.length);
    for (const [k] of p.tracks) {
      if (k < 0) continue;
      sec += trackAllMs[k];
      mix[tLang[k]]++;
    }
    card.append(h('div', 'pl-name', p.name), h('div', 'pl-meta', `${p.tracks.length} songs · ${fmt.hours(hrs(sec))} played · edited ${p.modified}`));
    const thin = h('div', 'thin');
    thin.setAttribute('role', 'img');
    thin.setAttribute('aria-label', series.filter((s) => mix[s.key]).map((s) => `${s.label} ${Math.round((100 * mix[s.key]) / p.tracks.length)}%`).join(', '));
    for (const s of series) {
      if (!mix[s.key]) continue;
      const span = h('span');
      span.style.flexGrow = mix[s.key];
      span.style.background = s.color;
      span.title = `${s.label}: ${mix[s.key]} songs`;
      thin.appendChild(span);
    }
    card.appendChild(thin);
    card.style.setProperty('--i', box.children.length);
    box.appendChild(card);
  }
  $('pl-legend').replaceChildren(legendEl(series));
}

function renderExplorer(sel, A) {
  const q = state.exQ.trim().toLowerCase();
  let rows = [];
  for (let k = 0; k < nT; k++) {
    if (!A.tMs[k]) continue;
    const t = C.tracks[k];
    const artist = C.artists[t[1]][0];
    const genre = tGenre[k] >= 0 ? C.genres[tGenre[k]] : '';
    if (q && !`${t[0]} ${artist} ${genre} ${C.albums[t[2]][0]}`.toLowerCase().includes(q)) continue;
    const n = A.tPlays[k];
    rows.push({ k, t: t[0], a: artist, g: genre, y: t[4] || 0, p: n, h: hrs(A.tMs[k]), s: A.tSkips[k] / Math.max(1, n + A.tSkips[k]), f: A.tFirst[k], l: A.tLastSel[k] });
  }
  const { k: sk, dir } = state.exSort;
  rows.sort((a, b) => (typeof a[sk] === 'string' ? a[sk].localeCompare(b[sk]) : a[sk] - b[sk]) * dir);
  const per = 25;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  state.exPage = Math.min(state.exPage, pages - 1);
  $('ex-sub').textContent = `${fmt.int(rows.length)} songs${state.year === 'all' ? '' : ` played in ${state.year}`}. Click a title to play it, a header to sort.`;
  const cols = [
    ['t', 'Song'],
    ['a', 'Artist'],
    ['g', 'Genre'],
    ['y', 'Released', true],
    ['p', 'Plays', true],
    ['h', 'Hours', true],
    ['s', 'Skip rate', true],
    ['f', 'First played', true],
    ['l', 'Last played', true],
  ];
  const tbl = $('explorer');
  tbl.replaceChildren();
  const tr = tbl.createTHead().insertRow();
  for (const [key, label, num] of cols) {
    const th = h('th', num ? 'num' : null, label);
    th.dataset.k = key;
    th.tabIndex = 0;
    th.scope = 'col';
    if (sk === key) th.setAttribute('aria-sort', dir < 0 ? 'descending' : 'ascending');
    const sort = () => {
      state.exSort = { k: key, dir: sk === key ? -dir : typeof rows[0]?.[key] === 'string' ? 1 : -1 };
      renderExplorer(sel, A);
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => e.key === 'Enter' && sort());
    tr.appendChild(th);
  }
  const tb = tbl.createTBody();
  for (const r of rows.slice(state.exPage * per, state.exPage * per + per)) {
    const row = tb.insertRow();
    const c0 = row.insertCell();
    c0.className = 't';
    const b = h('button', null, r.t);
    b.title = `Play ${r.t}`;
    b.addEventListener('click', () => play(r.k));
    c0.appendChild(b);
    const cell = (text, cls) => {
      const c = row.insertCell();
      c.textContent = text;
      if (cls) c.className = cls;
    };
    cell(r.a, 'a');
    cell(r.g);
    cell(r.y ? String(r.y) : '', 'num');
    cell(fmt.int(r.p), 'num');
    cell(r.h.toFixed(1), 'num');
    cell(fmt.pct(r.s), 'num');
    cell(fmtDate(r.f), 'num');
    cell(fmtDate(r.l), 'num');
  }
  const pager = $('pager');
  pager.replaceChildren();
  const prev = h('button', null, 'Previous');
  prev.disabled = state.exPage === 0;
  prev.addEventListener('click', () => {
    state.exPage--;
    renderExplorer(sel, A);
  });
  const next = h('button', null, 'Next');
  next.disabled = state.exPage >= pages - 1;
  next.addEventListener('click', () => {
    state.exPage++;
    renderExplorer(sel, A);
  });
  pager.append(prev, h('span', null, `Page ${state.exPage + 1} of ${pages}`), next);
}

const WARN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="var(--warning)"/><path d="M12 10v5M12 18v.01" stroke="#0b0b0b" stroke-width="2" stroke-linecap="round"/></svg>';
function renderTech() {
  const t = meta?.tech;
  if (!t) return;
  $('tech-sub').textContent = t.window ? `From the technical logs, ${t.window[0]} to ${t.window[1]} — the only window Spotify keeps them for.` : '';
  const alert = $('tech-alert');
  alert.replaceChildren();
  if (t.streaming && Math.max(t.streaming.wifi || 0, t.streaming.cellular || 0) < 160000) {
    const c = h('div', 'callout');
    c.innerHTML = WARN_ICON; // static markup, no data
    const body = h('div');
    body.append(
      h('strong', null, `Warning: streaming at ${Math.round(t.streaming.wifi / 1000)} kbps on Wi-Fi and ${Math.round(t.streaming.cellular / 1000)} kbps on mobile data`),
      h('span', null, 'That is “Normal” quality, and the app picked it, not you. On Premium you can set Settings → Audio quality to Very high (320 kbps), or Lossless if it’s offered. You’ll hear the difference most on wired headphones.')
    );
    c.appendChild(body);
    alert.appendChild(c);
  }
  const out = Object.fromEntries(t.outputs || []);
  const outTotal = d3.sum(Object.values(out)) || 1;
  const lowMem = (t.exits || []).find(([r]) => r === 'REASON_LOW_MEMORY');
  const skipsRemote = (t.remote || []).find(([a]) => a === 'skip_to_next');
  const techTiles = [
      t.device && tile('Phone', `${t.device.maker}`, `${t.device.os} · ${t.device.ramGB} GB RAM`),
      t.offline && tile('Downloaded', `${fmt.int(t.offline.downloaded)} songs`, `from ${t.offline.links} playlists/albums`),
      tile('Phone speaker', fmt.pct((out.BUILT_IN_SPEAKER || 0) / outTotal), `vs ${fmt.pct((out.LINE_OUT || 0) / outTotal)} wired/line-out`),
      tile('Lyrics opened', fmt.int(t.lyricsViews)),
      lowMem && tile('Killed by Android', `${lowMem[1]}×`, 'for low memory'),
      tile('Jams started', fmt.int(t.jams.created), `${t.jams.withGuests} with someone else`),
      skipsRemote && tile('Skips from notification', fmt.int(skipsRemote[1]), 'lock screen & earbuds'),
      tile('Liked / unliked', `${t.liked} / ${t.unliked}`),
      t.audio && tile('Normalisation', t.audio.normalization ? 'On' : 'Off', `crossfade ${t.audio.crossfade ? 'on' : 'off'}, gapless ${t.audio.gapless ? 'on' : 'off'}`),
  ].filter(Boolean);
  stagger(techTiles);
  $('tech-tiles').replaceChildren(...techTiles);
  const vols = (t.volume || []).map(([v, n]) => ({ key: +v, label: `${Math.round(v * 100)}%`, title: `Volume ${Math.round(v * 100)}%`, values: { 0: n } }));
  columns($('volume'), { bins: vols, series: [{ key: 0, label: 'Volume changes', color: css('--s1') }], height: 180, yFormat: fmt.compact, valueFormat: (v) => `${fmt.int(v)} times`, tickEvery: 2 });
  const dl = $('daylists');
  dl.replaceChildren();
  const chips = h('div', 'chips');
  for (const d of t.daylists || []) {
    const c = h('div', 'chip big');
    c.append(h('strong', null, `daylist · ${d.title}`), h('span', null, d.desc));
    chips.appendChild(c);
  }
  if (t.releaseRadarServed) chips.appendChild(h('span', 'chip', `Release Radar refreshed ${t.releaseRadarServed}×`));
  if (t.smartShuffleOn) chips.appendChild(h('span', 'chip', `Smart Shuffle switched on ${t.smartShuffleOn}×, off ${t.smartShuffleOff}×`));
  dl.appendChild(chips);
  const or = $('onrepeat');
  or.replaceChildren();
  for (const k of t.onRepeat || []) {
    const li = h('li');
    const b = h('button', null, `${C.tracks[k][0]} — ${C.artists[C.tracks[k][1]][0]}`);
    b.addEventListener('click', () => play(k));
    li.appendChild(b);
    or.appendChild(li);
  }
}

function renderWrapped() {
  const w = meta?.wrapped2025;
  if (!w) {
    $('wrapped-card').hidden = true;
    return;
  }
  let sec = 0;
  for (let i = 0; i < N; i++) if (YEAR[i] === 2025) sec += S[i];
  const clubName = (w.club || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const wrTiles = [
    tile('Minutes (Wrapped)', fmt.int(w.minutes), `your data says ${fmt.int(sec / 60)} for all of 2025${meta.incognitoExcluded ? ', private sessions excluded' : ''}`),
    tile('Top fan', `Top ${w.topFanPercent}%`, 'of listeners of your #1 artist'),
    tile('Listening age', String(w.listeningAge)),
    tile('Club', clubName, (w.clubRole || '').toLowerCase()),
    tile('Artists', fmt.int(w.uniqueArtists), `${fmt.int(w.discovered)} discovered`),
    tile('Genres', fmt.int(w.genres)),
    tile('Longest streak', `${w.streak} days`),
    tile('Mood split', `${Math.round(w.partyPct)}% party`, `${Math.round(w.lovePct)}% love · ${Math.round(w.chillPct)}% chill`),
  ];
  stagger(wrTiles);
  $('wr-tiles').replaceChildren(...wrTiles);
  const st = $('wr-stories');
  st.replaceChildren();
  for (const s of w.stories || []) {
    const c = h('div', 'story');
    c.style.setProperty('--i', st.children.length);
    const d = `${s.date.slice(6, 8)}/${s.date.slice(4, 6)}/${s.date.slice(0, 4)}`;
    c.append(h('strong', null, s.title), h('span', null, s.text), h('div', 'd', d));
    st.appendChild(c);
  }
}

const SEGMENTS = [
  ['Super Listeners', 'Super listener of'],
  ['Moderate listeners', 'Regular listener of'],
  ['Light listeners', 'Light listener of'],
  ['Previously Active Listeners', 'Drifted away from'],
];
function renderNotes() {
  const mq = meta?.marquee || {};
  const caps = meta?.capsule || [];
  if (!Object.keys(mq).length && !caps.length) return;
  $('notes-card').hidden = false;
  const box = $('marquee');
  box.replaceChildren();
  for (const [key, label] of SEGMENTS) {
    const seg = mq[key];
    if (!seg) continue;
    const g = h('div', 'inf-group');
    g.appendChild(h('h4', null, `${label} (${fmt.int(seg.count)} artist${seg.count === 1 ? '' : 's'})`));
    const chips = h('div', 'chips');
    for (const a of seg.sample) chips.appendChild(h('span', 'chip', a));
    if (seg.count > seg.sample.length) chips.appendChild(h('span', 'chip', `+${fmt.int(seg.count - seg.sample.length)} more`));
    g.appendChild(chips);
    box.appendChild(g);
  }
  const cap = $('capsule');
  cap.replaceChildren();
  for (const c of caps.slice(0, 12)) {
    const card = h('div', 'story');
    card.style.setProperty('--i', cap.children.length);
    card.append(h('strong', null, c.text), h('div', 'd', c.date));
    cap.appendChild(card);
  }
}

function renderPrivate() {
  if (!priv) return;
  $('private-card').hidden = false;
  $('pv-tiles').replaceChildren(
    tile('Display name', priv.profile.displayName || '—'),
    tile('Member since', priv.profile.created || '—'),
    tile('Private sessions', `${fmt.int(priv.incognito.plays)} plays`, `${fmt.hours(priv.incognito.hours)} · ${meta?.incognitoExcluded ? 'left out of the charts' : 'included in the charts'}`),
    tile('Searches', fmt.int(priv.searches.total)),
    tile('Data shared with', `${d3.sum(priv.dataRecipients, (r) => r.count)} companies`)
  );
  const inf = $('pv-inferences');
  inf.replaceChildren();
  for (const [group, items] of Object.entries(priv.inferences)) {
    const g = h('div', 'inf-group');
    g.appendChild(h('h4', null, `${group} (${items.length})`));
    const chips = h('div', 'chips');
    for (const x of items.slice(0, 24)) chips.appendChild(h('span', 'chip', x));
    if (items.length > 24) chips.appendChild(h('span', 'chip', `+${items.length - 24} more`));
    g.appendChild(chips);
    inf.appendChild(g);
  }
  const ps = $('pv-searches');
  ps.replaceChildren(...priv.searches.top.slice(0, 15).map(([q, n]) => h('li', null, `${q} (${n})`)));
  const pi = $('pv-incognito');
  pi.replaceChildren(...priv.incognito.topArtists.slice(0, 8).map(([a, n]) => h('li', null, `${a} (${n} plays)`)));
}

// ------------------------------------------------------------------ orchestration
function renderAll() {
  tip.hide();
  renderFilters();
  const sel = select();
  const A = aggregate(sel);
  renderHero(sel, A);
  renderTimeline(sel);
  renderTop(sel, A);
  renderGenres(sel);
  renderLangs(sel);
  renderAge(sel);
  renderClock(sel);
  renderHabits(sel);
  renderEras();
  renderBinges(sel);
  renderForgotten(sel, A);
  renderEnds(sel);
  renderDevices(sel);
  renderExplorer(sel, A);
  markNowPlaying(); // re-rendered rows keep showing what's playing
}
function setYear(y) {
  state.year = y;
  state.exPage = 0;
  history.replaceState(null, '', y === 'all' ? location.pathname + location.search : `#${y}`);
  renderAll();
}

$('range').textContent = `${fmtMonth(firstT)} – ${fmtMonth(lastT)}`;
$('foot').textContent = meta ? `Data built ${meta.generated.slice(0, 10)} · ${fmt.int(N)} plays · ${fmt.int(meta.enrichment.tracksMatched)} songs and ${fmt.int(meta.enrichment.artistsMatched)} artists matched to the iTunes catalogue.` : '';
$('sleep').addEventListener('change', (e) => {
  state.sleep = e.target.checked;
  store.set('sleep', state.sleep ? '1' : '0');
  renderAll();
});
let q;
$('ex-q').addEventListener('input', (e) => {
  clearTimeout(q);
  q = setTimeout(() => {
    state.exQ = e.target.value;
    state.exPage = 0;
    const sel = select();
    renderExplorer(sel, aggregate(sel));
  }, 150);
});
window.addEventListener('hashchange', () => {
  const y = fromHash();
  if (y !== state.year) setYear(y);
});
function rerenderStatic() {
  renderAll();
  renderLibrary();
  renderTech();
}
// Theme switch: the new theme spreads out from the toggle (View Transitions),
// charts redraw with that theme's own colour steps, and nothing re-animates.
$('theme').addEventListener('click', (e) => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const r = e.currentTarget.getBoundingClientRect();
  root.style.setProperty('--vt-x', `${r.left + r.width / 2}px`);
  root.style.setProperty('--vt-y', `${r.top + r.height / 2}px`);
  const apply = () => {
    root.classList.add('no-anim');
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
    rerenderStatic();
  };
  const settle = () => requestAnimationFrame(() => root.classList.remove('no-anim'));
  if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(apply).finished.finally(settle);
  else {
    apply();
    settle();
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  document.documentElement.classList.add('no-anim');
  rerenderStatic();
  requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
});

// The filter bar gets an edge once it is actually stuck to the top.
if ('IntersectionObserver' in window)
  new IntersectionObserver(([e]) => document.querySelector('.filters').classList.toggle('stuck', !e.isIntersecting)).observe(document.querySelector('.masthead'));

renderAll();
renderLibrary();
renderTech();
renderWrapped();
renderNotes();
renderPrivate();
if (revealer) for (const id of REVEAL_IDS) $(id) && revealer.observe($(id));
