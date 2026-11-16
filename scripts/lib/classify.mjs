// Genre families, language guesses and sleep-sound detection, shared by
// build.mjs (dashboard) and export-library.mjs (agent-readable library).

// Genre -> one of eight families (fixed order = fixed colour slot in the UI).
export const FAMILIES = ['Hip-Hop & R&B', 'Indian', 'Rock & Alt', 'Pop', 'K-Pop, J-Pop & Anime', 'Electronic', 'Chill & Ambient', 'Other'];
export function family(g) {
  if (!g) return null;
  const s = g.toLowerCase();
  if (/sleep|ambient|new age|relax|meditation|lo-?fi|nature|easy listening|instrumental|classical|piano|healing|spa/.test(s)) return 'Chill & Ambient';
  if (/hip.?hop|rap|r&b|soul|trap|grime|drill|funk/.test(s)) return 'Hip-Hop & R&B';
  if (/bollywood|punjabi|bengali|indian|hindi|tamil|telugu|malayalam|kannada|marathi|gujarati|urdu|ghazal|sufi|qawwali|devotional|bhojpuri|regional|desi|carnatic|hindustani|pakistan/.test(s)) return 'Indian';
  if (/k-pop|j-pop|anime|japan|korea|j-rock|mandopop|cantopop|c-pop|thai|vocaloid|enka/.test(s)) return 'K-Pop, J-Pop & Anime';
  if (/rock|alternative|metal|punk|grunge|indie|emo|hardcore|alt/.test(s)) return 'Rock & Alt';
  if (/electronic|dance|house|techno|edm|trance|dubstep|drum|electro|garage/.test(s)) return 'Electronic';
  if (/pop|singer|songwriter|adult contemporary|vocal/.test(s)) return 'Pop';
  return 'Other';
}

// The dashboard's eight language buckets. Finer labels (Tamil, Spanish, ...)
// from the helpers below fall into "Other" there but are kept in exports.
export const LANGS = ['English & global', 'Hindi & Urdu', 'Punjabi', 'Bengali', 'Japanese', 'Korean', 'Thai', 'Other'];

const SCRIPTS = [
  ['Hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/, 'Korean'],
  ['Kana', /[぀-ヿ]/, 'Japanese'],
  ['Thai', /[฀-๿]/, 'Thai'],
  ['Bengali', /[ঀ-৿]/, 'Bengali'],
  ['Gurmukhi', /[਀-੿]/, 'Punjabi'],
  ['Devanagari', /[ऀ-ॿ]/, 'Hindi & Urdu'],
  ['Arabic', /[؀-ۿݐ-ݿ]/, 'Hindi & Urdu'],
  ['Tamil', /[஀-௿]/, 'Tamil'],
  ['Telugu', /[ఀ-౿]/, 'Telugu'],
  ['Kannada', /[ಀ-೿]/, 'Kannada'],
  ['Malayalam', /[ഀ-ൿ]/, 'Malayalam'],
  ['Gujarati', /[઀-૿]/, 'Gujarati'],
  ['Cyrillic', /[Ѐ-ӿ]/, 'Russian'],
  ['Han', /[一-鿿]/, 'Japanese'], // kanji-only titles in this library are mostly Japanese
];

// Writing system of a string: "Latin", "Devanagari", "Kana", ...
export function scriptOf(s = '') {
  for (const [name, rx] of SCRIPTS) if (rx.test(s)) return name;
  return /[A-Za-z]/.test(s) ? 'Latin' : 'Unknown';
}

export function scriptLang(s = '') {
  for (const [, rx, lang] of SCRIPTS) if (rx.test(s)) return lang;
  return null;
}

export function genreLang(g = '') {
  const s = g.toLowerCase();
  if (s.includes('punjabi')) return 'Punjabi';
  if (s.includes('bengali')) return 'Bengali';
  if (/k-pop|korean/.test(s)) return 'Korean';
  if (/j-pop|anime|japan|j-rock|enka/.test(s)) return 'Japanese';
  if (s.includes('thai')) return 'Thai';
  for (const l of ['Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Marathi', 'Gujarati', 'Bhojpuri']) if (s.includes(l.toLowerCase())) return l;
  if (/bollywood|hindi|indian pop|ghazal|sufi|qawwali|urdu|devotional|indian/.test(s)) return 'Hindi & Urdu';
  if (/latin|reggaeton|latino/.test(s)) return 'Spanish';
  if (/hip.?hop|rap|rock|alternative|metal|punk|r&b|soul|electronic|dance|country|jazz|blues|singer|new age|ambient|classical/.test(s)) return 'English & global';
  return null;
}

// The user's own playlists are named by language — the strongest signal we have,
// as long as the name points at one language ("Punjabi", "KPOP", "Jap").
// Mixed names ("Indie Pop/ Hindi/ Urdu/Hinglish/ Whatver") are only a weak hint.
export function playlistHint(name = '') {
  const s = name.toLowerCase();
  const found = [];
  if (/bengali|bangla/.test(s)) found.push('Bengali');
  if (/punjabi/.test(s)) found.push('Punjabi');
  if (/kpop|k-pop|korean/.test(s)) found.push('Korean');
  if (/\bjap|japan|anime|jpop/.test(s)) found.push('Japanese');
  if (/thai/.test(s)) found.push('Thai');
  if (/hindi|urdu|bollywood|hinglish/.test(s)) found.push('Hindi & Urdu');
  if (!found.length) return null;
  const mixed = new Set(found).size > 1 || /[/,&+]|indie|mix|whatever|whatver|misc|diff/.test(s) || (s.match(/hindi|urdu|hinglish/g) || []).length > 1;
  return { lang: found[0], strong: !mixed };
}
export function playlistLang(name = '') {
  const h = playlistHint(name);
  return h && h.strong ? h.lang : null;
}

// Artists whose language the script can't reveal (Nepali shares Devanagari with
// Hindi; most of these titles are romanised anyway).
const KNOWN_ARTISTS = {
  Nepali:
    'bipul chettri|tribal rain|swoopna suman|sajjan raj vaidya|sushant kc|melina rai|rohit john chettri|neetesh jung kunwar|yabesh thapa|uniq poet|wangden sherpa|abhaya & the steam engines|ulto pulto|albatross|1974 ad|narayan gopal|bartika eam rai|kutumba|nepathya|trishna gurung|purna rai|pramod kharel|raju lama|mongolian heart|sabin rai|ani choying drolma|arthur gunn|vten|yama buddha|sacar|laure|girish khatiwada|anju panta|deepak bajracharya|kali prasad baskota|prabisha adhikari|bartika rai|joint family international|shreya sotang|samir shrestha|kamal khatri|aastha raut|sugam pokharel|mohan shrestha',
  // Kept short and exact on purpose: a name here overrides every other signal.
};
const KNOWN = Object.entries(KNOWN_ARTISTS).map(([lang, list]) => [lang, new Set(list.split('|'))]);
export function knownArtistLang(artist = '') {
  const a = artist.toLowerCase().trim();
  for (const [lang, set] of KNOWN) if (set.has(a)) return lang;
  return null;
}

// Romanised titles: "Tere Ishq Nachaya", "Ami Tomake", "Kimi no Uta", "Je Chhau Timi".
const WORDS = {
  Nepali: 'timi timro timilai timrai mero malai hajur hamro ramro kasto kina sanga chha chhau chhu chhan bhayo hola pirati samjhana laijau laijaw nacha mayalu sanu bhanna garna hijo bholi basanta pahad lahara',
  Punjabi: 'mainu tenu tusi tuhanu kudi kudiye munde jatt jattan gallan gal kithe sohni sohneya jind assi vich pind lagdi nachaya akh akhiyan tutt dass mutiyaar putt yaar yaara yaarian yaariyan sardar chann mahiya ve haye nachdi',
  'Hindi & Urdu':
    'tere mere teri meri tera mera tum tumhe tumse tumhari hum humein hume humko dil dilbar dildaar ishq pyaar pyar mohabbat zindagi kya hai hain nahi nahin jaana jaane jaaneman sajna sajni sanam rabba maahi raat raatein ankhiyan aankhein aankhon kaun aaja saathi khuda maula nazar chand chanda bhool gaye idhar udhar baat mori piya saiyaan saiyan judaai jaan zara phir kabhi sapna sapne duniya barsaat baarish mausam ghar safar raahein khwab khwaab aashiq aashiqui deewana deewani kahani kyun aise jaise tujhe mujhe tujh mujh tu hoga hogi tha thi wohi woh yeh mein dekha dekho chalo chal pyaari pyara kuch jiya jiye tanha mehfil sawan saawan dhadkan intezaar shaam subah rasiya bairi meherbaan qawwali ali maahiya ranjha heer ghazal sufi hasna rona yaadein yaad',
  Bengali: 'ami tumi amar tomar tomake amake bhalobasha bhalobashi keno ekhon shudhu moner mon chol jabo ache kichu akash brishti hridoy nodi khnoro shopno ektu ekta amra tomra kotha bolo bondhu',
  Japanese: 'kimi boku watashi anata koi sayonara arigatou hikari sakura yume kokoro todome ichigeki doushite naze itsumo zutto kirei tsuki hoshi mirai desu masu uta no wa ga wo',
  Korean: 'saranghae saranghae oppa naega neoui nae uri hanaui sarang gwaenchana annyeong',
};
const WORD_SETS = Object.fromEntries(Object.entries(WORDS).map(([l, w]) => [l, new Set(w.split(/\s+/))]));
const ENGLISH = new Set(
  'the a an and or of to in on at for from with my your our their his her its me you we they i it is are was be love heart night day time life world girl boy baby home dream light sky rain sun moon fire water fountain easy know did do does don t can cant will wont never always forever again away back down up out over under into around blue red black white gold little big good bad new old young wild free alone together tonight today tomorrow yesterday summer winter city road street song songs music dance party feel feeling like want need come go stay run fall rise lost found more less only all every one two three last first best better this that these those what when where why how who dont im youre ill ive its lets gonna wanna got get kiss tears eyes mind soul sweet crazy beautiful happy sad people friends story fade ocean stars star'.split(' ')
);

// Returns { lang, confidence } from title words, or null.
export function titleWordsLang(title = '') {
  const tokens = title
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const score = {};
  for (const [lang, set] of Object.entries(WORD_SETS)) {
    const n = tokens.filter((t) => set.has(t)).length;
    // Japanese particles (no/wa/ga/wo) need a second, distinctive word.
    if (n && (lang !== 'Japanese' || tokens.filter((t) => set.has(t) && t.length > 2).length)) score[lang] = n;
  }
  // Punjabi and Nepali markers are more specific than the shared Hindi vocabulary.
  if (score.Punjabi && score['Hindi & Urdu']) score.Punjabi += 0.5;
  if (score.Nepali && score['Hindi & Urdu']) score.Nepali += 0.5;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  // Two or more distinctive words ("Je Chhau Timi") is strong enough to beat a playlist label.
  // Shared Hindi/Urdu vocabulary ("Tere", "Dil") is not distinctive: Punjabi songs use it too.
  const distinctive = ['Nepali', 'Bengali', 'Punjabi', 'Korean'];
  if (best) return { lang: best[0], confidence: best[1] >= 2 && distinctive.includes(best[0]) ? 'high' : 'medium' };
  const eng = tokens.filter((t) => ENGLISH.has(t)).length;
  // "When We Feel Young" (3 of 4 common English words) is solid; "Easy" alone is a guess.
  if (eng >= 2 && eng >= tokens.length / 2) return { lang: 'English & global', confidence: 'medium' };
  if (eng && eng >= Math.ceil(tokens.length / 3)) return { lang: 'English & global', confidence: 'low' };
  return null;
}

export const SLEEP_RX = /sleep|white noise|brown noise|pink noise|rain sounds|relaxing|relaxation|meditat|ambient|lullab|delta waves|theta|binaural|asmr|soothing|nature sounds|spa music|healing|calm/i;
