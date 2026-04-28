/**
 * Eclipse Universal Addon
 * Sources (in priority order):
 *   MUSIC:    HiFi instances → SoundCloud → Internet Archive
 *   PODCASTS: Podcast Index → Taddy → Apple Podcasts 
 * All API keys are optional and passed via query string when installing:
 *   https://your-addon.vercel.app/{token}/manifest.json
 *
 * Token format (base64url of JSON):
 *   { hifi, sc, pi_key, pi_secret, taddy_key, taddy_uid }
 */

import { Hono } from 'hono';

// ─── safeYear: always returns Int for Android JSON parser ─────────────────────
function safeYear(val) {
  if (val === null || val === undefined || val === '' || val === 0) return 0;
  const n = parseInt(String(val).replace(/[^0-9]/g, '').slice(0, 4), 10);
  return (isNaN(n) || n < 1000 || n > 2100) ? 0 : n;
}



const app = new Hono();

const memCache = new Map();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const textHeaders = { 'content-type': 'text/html; charset=utf-8' };


async function cacheGet(key) {
  const v = memCache.get(key);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { memCache.delete(key); return null; }
  return v.value;
}

async function cacheSet(key, value, ttl = 300) {
  memCache.set(key, { value, exp: Date.now() + ttl * 1000 });
}


// ─── Axios-compatible fetch shim (Workers-safe) ──────────────────────────────
function buildUrl(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const axios = {
  get: async (url, config = {}) => {
    const fullUrl = buildUrl(url, config.params);
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: config.headers || {},
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      const ct = res.headers.get('content-type') || '';
      let data = text;
      if (ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  post: async (url, body, config = {}) => {
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { data = text; }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

// ─── Token / Config Parsing ──────────────────────────────────────────────────
function parseToken(tokenStr) {
  if (!tokenStr || tokenStr === 'noop') return {};
  try {
    const json = decodeBase64Url(tokenStr);
    return JSON.parse(json);
  } catch {
    try {
      const json = decodeBase64(tokenStr);
      return JSON.parse(json);
    } catch { return {}; }
  }
}


function decodeBase64Url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4 || 4)) % 4);
  return atob(padded);
}

function decodeBase64(str) {
  return atob(String(str || ''));
}

function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getConfig(c) {
  const token = c.req.param('token') || '';
  const cfg = parseToken(token);
  const VALID_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  return {
    hifiInstances: cfg.hifi
      ? cfg.hifi.split(',').map(u => u.trim()).filter(Boolean)
      : (c.env.HIFI_INSTANCES
          ? c.env.HIFI_INSTANCES.split(',').map(u => u.trim()).filter(Boolean)
          : []),
    scClientId: cfg.sc || c.env.SC_CLIENT_ID || null,
    piKey: cfg.pi_key || c.env.PI_KEY || null,
    piSecret: cfg.pi_secret || c.env.PI_SECRET || null,
    taddyKey: cfg.taddy_key || c.env.TADDY_KEY || null,
    taddyUid: cfg.taddy_uid || c.env.TADDY_UID || null,
    preferredQuality: VALID_QUALITIES.includes(cfg.q) ? cfg.q : null,
  };
}

// ─── SoundCloud Client ID Auto-Discovery ─────────────────────────────────────
let _scClientIdCache = null;
let _scClientIdExpiry = 0;

async function getSCClientId(providedId) {
  if (providedId) return providedId;
  if (_scClientIdCache && Date.now() < _scClientIdExpiry) return _scClientIdCache;
  const cached = await cacheGet('sc:client_id');
  if (cached) {
    _scClientIdCache = cached;
    _scClientIdExpiry = Date.now() + 3600000;
    return cached;
  }
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' };
    const page = await axios.get('https://soundcloud.com', { headers, timeout: 8000 });
    const scriptUrls = [...new Set((page.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g) || []))];
    for (const url of scriptUrls.slice(-5).reverse()) {
      try {
        const js = await axios.get(url, { headers, timeout: 5000 });
        const m = js.data.match(/client_id[:"'\s=]+([a-zA-Z0-9]{32})/);
        if (m) {
          _scClientIdCache = m[1];
          _scClientIdExpiry = Date.now() + 3600000;
          await cacheSet('sc:client_id', m[1], 3600);
          console.log('[SC] Auto-discovered client_id:', m[1].slice(0, 8) + '...');
          return m[1];
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[SC] client_id discovery failed:', e.message);
  }
  return null;
}

// ─── HiFi Instance Helpers ───────────────────────────────────────────────────
const DEFAULT_HIFI_INSTANCES = [
  'https://hifi-api-pj08.onrender.com',
  'https://tidal-api.binimum.org',
  'https://triton.squid.wtf',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://vogel.qqdl.site',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://monochrome-api.samidy.com',
  'https://hifi-two.spotisaver.net',
  'https://wolf.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://api.monochrome.tf',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const QOBUZ_BASE = 'https://qobuz-api1.onrender.com';

async function getWorkingHiFiInstance(instances) {
  // Always try all instances in parallel — never skip or cache a "down" instance
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const results = await Promise.allSettled(list.map(async inst => {
    const r = await axios.get(`${inst}/search/`, {
      params: { s: 'test', limit: 1 },
      headers: { 'User-Agent': UA },
      timeout: 4000,
    });
    const isJson = typeof r.data === 'object' && r.data !== null;
    if (r.status === 200 && isJson) return inst;
    return null;
  }));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}


// ─── Qobuz client (via proxy — same as Claudochrome) ─────────────────────────
// Proxy: https://qobuz-api1.onrender.com handles all Qobuz auth internally.
// qobuzStream: tries Hi-Res 192kHz → Hi-Res 96kHz → Lossless 16bit → MP3 320
// qobuzFindBestTrack: searches proxy and picks best title+artist match

async function qobuzStream(trackId) {
  for (const fmt of [27, 7, 6, 5]) {
    try {
      const r = await axios.get(QOBUZ_BASE + '/stream/' + trackId, {
        params: { format_id: fmt },
        headers: { 'User-Agent': UA },
        timeout: 12000,
      });
      if (r.data && r.data.url) {
        const quality = fmt === 27 ? 'hires-192' : fmt === 7 ? 'hires-96' : fmt === 6 ? 'lossless' : '320kbps';
        return { url: r.data.url, format: fmt !== 5 ? 'flac' : 'mp3', quality, source: 'qobuz', expiresAt: Math.floor(Date.now() / 1000) + 1800 };
      }
    } catch(e) { continue; }
  }
  return null;
}

async function qobuzFindBestTrack(title, artist) {
  if (!title) return null;
  const q = (artist ? artist + ' ' : '') + title;
  try {
    const r = await axios.get(QOBUZ_BASE + '/search', {
      params: { q, limit: 10 },
      headers: { 'User-Agent': UA },
      timeout: 12000,
    });
    const data = r.data || null;
    if (!data) return null;
    const items = (data.tracks && data.tracks.items) ? data.tracks.items : [];
    if (!items.length) return null;
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const wantTitle  = norm(title);
    const wantArtist = norm(artist || '');
    const ranked = items.slice().sort((a, b) => {
      const score = item => {
        const t  = norm(item.title || '');
        const ar = norm((item.performer && item.performer.name) || (item.artist && item.artist.name) || '');
        let s = 0;
        if (t === wantTitle)   s += 5;
        if (wantArtist && ar === wantArtist) s += 5;
        if (wantTitle  && t.includes(wantTitle))   s += 2;
        if (wantArtist && ar.includes(wantArtist)) s += 2;
        return s;
      };
      return score(b) - score(a);
    });
    const best = ranked[0];
    if (!best) return null;
    const bestTitle  = norm(best.title || '');
    const bestArtist = norm((best.performer && best.performer.name) || (best.artist && best.artist.name) || '');
    const titleGood  = wantTitle && (bestTitle === wantTitle || bestTitle.includes(wantTitle) || wantTitle.includes(bestTitle));
    const artistGood = !wantArtist || (bestArtist && (bestArtist === wantArtist || bestArtist.includes(wantArtist) || wantArtist.includes(bestArtist)));
    if (wantArtist ? (titleGood && artistGood) : titleGood) return best;
    return null;
  } catch(e) { return null; }
}

async function hifiSearch(query, instances) {
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const cacheKey = `hifi:search:all:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  // Race all instances — first to respond wins for main search
  // Artist searches run in parallel and we collect ALL results
  const HIFI_TIMEOUT = 5000;
  const mainSearches = list.map(inst =>
    axios.get(`${inst}/search/`, { params: { s: query, limit: 50 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
      .then(r => { if (!r?.data) throw new Error('empty'); return { r, inst }; })
  );
  const artistSearches = list.map(inst =>
    axios.get(`${inst}/search/`, { params: { s: query, type: 'ARTISTS', limit: 10 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
      .then(r => ({ r, inst, type: 'artists' })).catch(() => null)
  );

  // Get fastest main result + all artist results simultaneously
  let mainHit = null;
  try {
    mainHit = await Promise.any(mainSearches);
  } catch { /* all failed */ }

  const artistSettled = await Promise.allSettled(artistSearches);
  const inst = mainHit?.inst || list[0];
  const artistHits = artistSettled
    .filter(x => x.status === 'fulfilled' && x.value?.r?.data)
    .map(x => x.value);

  if (!mainHit) return { tracks: [], albums: [], artists: [] };
  try {
    const mainRes  = { status: 'fulfilled', value: mainHit.r };
    // Merge all artist responses into one synthetic result
    const mergedArtistData = artistHits.flatMap(x => {
      const d = x.r.data;
      return d?.data?.artists?.items || d?.data?.artists || d?.artists?.items || d?.artists || d?.data?.items || d?.items || [];
    });
    const artistRes = {
      status: 'fulfilled',
      value: { data: { data: { artists: { items: mergedArtistData } } } },
    };

    const items = mainRes.status === 'fulfilled'
      ? (mainRes.value.data?.data?.items || mainRes.value.data?.items || mainRes.value.data?.tracks || [])
      : [];
    const instB64 = encodeBase64Url(inst);
    const tracks = [], albumMap = {}, artistMap = {};

    for (const t of items) {
      if (!t?.id) continue;

      // Build artist map from ALL items (not just streamable) so geo-restricted
      // artists like Travis Scott still appear in search results
      for (const a of (t.artists || (t.artist ? [t.artist] : []))) {
        if (a?.id && !artistMap[String(a.id)]) {
          artistMap[String(a.id)] = {
            id: `hifi_artist_${instB64}_${a.id}`,
            name: a.name || 'Unknown',
            artworkURL: a.picture
              ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
              : undefined,
            _source: 'hifi',
            _hits: 0,
          };
        }
        if (a?.id) artistMap[String(a.id)]._hits = (artistMap[String(a.id)]._hits || 0) + 1;
      }

      // Only streamable tracks go into track/album results
      if (t.streamReady === false) continue;

      const origId = String(t.id);
      const artworkURL = t.album?.cover
        ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/1280x1280.jpg`
        : undefined;
      // Artist resolution: MAIN/FEATURED first, then strip known label/distributor names
      const _LABEL_RE = /\b(octobersveryown|ovo|republic|island|atlantic|columbia|interscope|universal|sony|warner|capitol|def jam|rca|epic|polydor|parlophone|elektra|geffen|virgin|motown|label|records|music group|entertainment|distribution|publishing|llc|inc\.?)\b/i;
      const mainArtists = (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED');
      const nonLabelArtists = (t.artists || []).filter(a => a.name && !_LABEL_RE.test(a.name));
      const artistNames = mainArtists.length
        ? mainArtists.map(a => a.name).join(', ')
        : nonLabelArtists.length
          ? nonLabelArtists.map(a => a.name).join(', ')
          : (t.artist?.name || (t.artists || []).map(a => a.name).join(', ') || 'Unknown');
      tracks.push({
        id: `hifi_${instB64}_${origId}`,
        title: t.title || 'Unknown',
        artist: artistNames,
        album: t.album?.title || '',
        duration: t.duration ? Math.floor(t.duration) : undefined,
        artworkURL,
        format: 'flac',
        _source: 'hifi',
        _inst: inst,
        _instB64: instB64,
        _origId: origId,
      });
      // Cache track metadata so stream handler can fall back to SC if HiFi fails
      cacheSet(`hifi:track:meta:${instB64}_${origId}`, { title: t.title || 'Unknown', artist: artistNames }, 3600);
      if (t.album?.id) {
        const aid = String(t.album.id);
        if (!albumMap[aid]) albumMap[aid] = {
          id: `hifi_album_${instB64}_${aid}`,
          title: t.album.title || 'Unknown Album',
          artist: artistNames,
          artworkURL,
          year: safeYear(t.album.releaseDate),
          _source: 'hifi',
        };
      }
    }

    // Merge dedicated artist search results — these return artists even when
    // their tracks are geo-restricted (fixes Travis Scott / Drake / etc.)
    if (artistRes.status === 'fulfilled') {
      const arData = artistRes.value.data;
      const arItems = arData?.data?.artists?.items || arData?.data?.artists
        || arData?.artists?.items || arData?.artists
        || arData?.data?.items || arData?.items || [];
      for (const a of arItems) {
        if (!a?.id || !a?.name) continue;
        const key = String(a.id);
        if (!artistMap[key]) {
          artistMap[key] = {
            id: `hifi_artist_${instB64}_${a.id}`,
            name: a.name,
            artworkURL: a.picture
              ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
              : undefined,
            _source: 'hifi',
            _hits: 10, // boost dedicated artist results to top
          };
        } else {
          artistMap[key]._hits = (artistMap[key]._hits || 0) + 10;
          if (!artistMap[key].artworkURL && a.picture) {
            artistMap[key].artworkURL = `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`;
          }
        }
      }
    }

    // Sort artists: most hits first (dedicated results float to top)
    const artistList = Object.values(artistMap)
      .sort((a, b) => (b._hits || 0) - (a._hits || 0))
      .slice(0, 5)
      .map(({ _hits, ...a }) => a);

    const result = {
      tracks,
      albums: Object.values(albumMap).slice(0, 8),
      artists: artistList,
    };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('[HiFi] search error:', e.message);
    return { tracks: [], albums: [], artists: [] };
  }
}

async function hifiStream(id, extraInstances, preferredQuality) {
  const withoutPrefix = id.slice(5);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64   = withoutPrefix.slice(0, firstUnderscore);
  const origId    = withoutPrefix.slice(firstUnderscore + 1);
  const preferred = decodeBase64Url(instB64);

  // Preferred instance first, then any user-configured instances, then all defaults
  const allInstances = [...new Set([preferred, ...(extraInstances || []), ...DEFAULT_HIFI_INSTANCES])];
  const instanceOrder = allInstances;

  function parseTrackResponse(data) {
    const payload = data?.data || data;
    if (payload?.manifest) {
      try {
        const decoded = JSON.parse(atob(payload.manifest));
        const url = decoded.urls?.[0];
        if (url) {
          const codec = (decoded.codecs || decoded.mimeType || '').toLowerCase();
          const isFlac = codec.includes('flac') || codec.includes('audio/flac');
          return { url, format: isFlac ? 'flac' : 'aac' };
        }
        // manifest decoded but no url — log the structure
        console.warn('[HiFi stream] manifest decoded but no url, keys:', Object.keys(decoded));
      } catch (e) {
        console.warn('[HiFi stream] manifest decode error:', e.message);
      }
    }
    if (payload?.url) return { url: payload.url, format: 'aac' };
    // Log what we actually got back
    if (payload) console.warn('[HiFi stream] no manifest/url in payload, keys:', Object.keys(payload).slice(0,10).join(','));
    return null;
  }

  // Try quality tiers in preferred order — race ALL instances per tier in parallel.
  // Each tier is tried fully before falling to the next, so LOSSLESS is always
  // attempted before HIGH or LOW (fixes the bug where LOW won the race).
  async function tryInstance(inst, ql) {
    try {
      const r = await axios.get(`${inst}/track/`, {
        params: { id: origId, quality: ql },
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
        },
        timeout: 4000,
      });
      const parsed = parseTrackResponse(r.data);
      if (parsed) {
        return { ...parsed, quality: ql };
      }
    } catch (e) {
      const status = e.response?.status;
      // Suppress 403/404 per-instance noise — expected when geo-restricted or instance is down
      if (status !== 403 && status !== 404 && status !== 401) {
        const msg = e.response?.data?.userMessage || e.response?.data?.error || e.message;
        console.warn(`[HiFi stream] ${inst}/track/ ql=${ql} -> ${status || 'ERR'}: ${msg}`);
      }
    }
    return null;
  }

  // Build quality order: preferred first, then remaining tiers highest→lowest
  const ALL_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  const pref = preferredQuality && ALL_QUALITIES.includes(preferredQuality) ? preferredQuality : 'LOSSLESS';
  const qualityOrder = [pref, ...ALL_QUALITIES.filter(q => q !== pref)];

  // For each quality tier, race ALL instances in parallel — move to next tier only if ALL fail
  for (const ql of qualityOrder) {
    try {
      const winner = await Promise.any(
        instanceOrder.map(inst =>
          tryInstance(inst, ql).then(r => {
            if (!r) throw new Error('no result');
            return r;
          })
        )
      );
      console.log(`[HiFi stream] winner quality=${ql} trackId=${origId}`);
      return winner;
    } catch {
      // All instances failed this tier — try next tier
      console.log(`[HiFi stream] tier ${ql} failed for trackId=${origId}, trying next tier`);
    }
  }

  // Legacy /stream/ path fallback — parallel across all instances
  const legacyResults = await Promise.all(instanceOrder.map(async inst => {
    try {
      const r = await axios.get(`${inst}/stream/${origId}`, {
        headers: { 'User-Agent': UA },
        timeout: 5000,
      });
      if (r.data?.url) {
        console.log(`[HiFi stream] legacy /stream/ success: ${inst} trackId=${origId}`);
        return { url: r.data.url, format: r.data.format || 'aac', quality: r.data.quality || 'unknown' };
      }
    } catch (e) {
      // Only log non-routine errors (not 403/404 geo/auth)
      if (e.response?.status !== 403 && e.response?.status !== 404 && e.response?.status !== 401) {
        console.warn(`[HiFi stream] legacy ${inst}/stream/${origId} -> ${e.response?.status || 'ERR'}: ${e.message}`);
      }
    }
    return null;
  }));
  const legacyWinner = legacyResults.find(r => r !== null);
  if (legacyWinner) return legacyWinner;

  console.error(`[HiFi stream] ALL instances failed for trackId=${origId}`);
  return null;
}

async function hifiAlbum(id) {
  const withoutPrefix = id.slice(11);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64 = withoutPrefix.slice(0, firstUnderscore);
  const albumId = withoutPrefix.slice(firstUnderscore + 1);
  const inst = decodeBase64Url(instB64);
  const cacheKey = `hifi:album:${instB64}:${albumId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const r = await axios.get(`${inst}/album/`, {
      params: { id: albumId, limit: 100 },
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const album = r.data?.data || r.data;
    const rawItems = album?.items || [];
    const _mainAlbumArtists = (album?.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED');
    const artistName = _mainAlbumArtists.length
      ? _mainAlbumArtists.map(a => a.name).join(', ')
      : (album?.artist?.name || (album?.artists || []).map(a => a.name).join(', ') || 'Unknown');
    const cover = album?.cover
      ? `https://resources.tidal.com/images/${album.cover.replace(/-/g, '/')}/1280x1280.jpg`
      : undefined;
    const tracks = rawItems
      .map(i => i.item || i)
      .filter(t => t?.id && t.streamReady !== false)
      .map(t => ({
        id: `hifi_${instB64}_${t.id}`,
        title: t.title || 'Unknown',
        artist: ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
        duration: t.duration ? Math.floor(t.duration) : undefined,
        trackNumber: t.trackNumber,
        artworkURL: cover,
        format: 'flac',
      }));
    const result = {
      id,
      title: album?.title || 'Unknown Album',
      artist: artistName,
      artworkURL: cover,
      year: safeYear(album?.releaseDate),
      trackCount: tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('[HiFi] album error:', e.message);
    return null;
  }
}


async function scSearch(query, clientId) {
  const cid = await getSCClientId(clientId);
  if (!cid) return { tracks: [], playlists: [] };
  const cacheKey = `sc:search:${cid.slice(0,8)}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [tracksRes, plRes] = await Promise.allSettled([
      axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: query, client_id: cid, limit: 20 },
        timeout: 8000,
      }),
      axios.get('https://api-v2.soundcloud.com/search/playlists', {
        params: { q: query, client_id: cid, limit: 5 },
        timeout: 8000,
      }),
    ]);
    const tracks = (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])
      .filter(t => {
        // Drop snipped/blocked/sub-only tracks from search results entirely
        const _p = (t.policy || '').toUpperCase();
        if (_p === 'SNIP' || _p === 'BLOCK') return false;
        // Drop if full_duration is much longer than duration (preview snippet)
        if (t.full_duration && t.duration && t.full_duration > t.duration + 5000) return false;
        return true;
      })
      .map(t => ({
      id: `sc_${t.id}`,
      title: t.title,
      artist: t.user?.username || 'Unknown',
      album: '',
      duration: Math.floor((t.full_duration || t.duration || 0) / 1000),
      artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
      format: 'mp3',
      _source: 'sc',
      _origId: String(t.id),
      _streamUrl: t.media?.transcodings?.find(x => x.format?.mime_type?.includes('mpeg'))?.url || null,
    }));
    // Cache individual track transcoding URLs + policy so fallback can detect snips/previews
    for (const t of (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])) {
      const turl = t.media?.transcodings?.find(x => x.format?.protocol === 'progressive' && x.format?.mime_type?.includes('mpeg'))?.url
                || t.media?.transcodings?.find(x => x.format?.protocol === 'progressive')?.url
                || t.media?.transcodings?.[0]?.url;
      if (turl) await cacheSet(`sc:transcodings:${t.id}`, turl, 3600);
      // Cache title/artist for fallback lookup when track turns out to be snipped
      if (t.title) await cacheSet(`sc:meta:${t.id}`, { title: t.title, artist: t.user?.username || '' }, 3600);
      // Cache policy so stream handler can detect snipped/blocked tracks
      if (t.policy || t.monetization_model) {
        await cacheSet(`sc:policy:${t.id}`, {
          policy: t.policy || '',
          monetization: t.monetization_model || '',
          snipped: !!(t.policy && ['SNIP', 'BLOCK'].includes(t.policy.toUpperCase())),
        }, 3600);
      }
    }
    const playlists = (plRes.status === 'fulfilled' ? plRes.value.data?.collection || [] : []).map(p => ({
      id: `sc_pl_${p.id}`,
      title: p.title,
      creator: p.user?.username || 'Unknown',
      artworkURL: (p.artwork_url || '').replace('-large', '-t500x500'),
      trackCount: p.track_count || 0,
      _source: 'sc',
      _origId: String(p.id),
    }));
    const result = { tracks, playlists };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('[SC] search error:', e.message);
    return { tracks: [], playlists: [] };
  }
}


async function scStream(origId, clientId) {
  const cid = await getSCClientId(clientId);
  // Even without a client_id, try using a cached transcoding URL from search
  const cachedTranscodingUrl = await cacheGet(`sc:transcodings:${origId}`);
  if (!cid && !cachedTranscodingUrl) return null;
  if (!cid && cachedTranscodingUrl) {
    // Can't resolve the transcoding URL without client_id, nothing we can do
    console.warn('[SC] no client_id, cannot resolve transcoding URL for', origId);
    return null;
  }
  try {
    const res = await axios.get(`https://api-v2.soundcloud.com/tracks/${origId}`, {
      params: { client_id: cid },
      timeout: 8000,
    });
    const transcodings = res.data?.media?.transcodings || [];
    const transcoding =
      transcodings.find(t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg')) ||
      transcodings.find(t => t.format?.protocol === 'progressive') ||
      transcodings.find(t => t.format?.mime_type?.includes('mpeg')) ||
      transcodings[0];
    if (!transcoding?.url) return null;
    const streamRes = await axios.get(transcoding.url, {
      params: { client_id: cid },
      timeout: 8000,
    });
    const url = streamRes.data?.url;
    if (!url) return null;
    const isHls = transcoding.format?.protocol === 'hls' || url.includes('.m3u8');
    // Detect snipped/preview tracks: SC returns short URLs or policy says SNIP/BLOCK
    const trackData = res.data;
    const policy = (trackData?.policy || '').toUpperCase();
    const isSnipped = policy === 'SNIP' || policy === 'BLOCK'
      || trackData?.monetization_model === 'SUB_HIGH_TIER'
      || (trackData?.full_duration && trackData?.duration && trackData.full_duration > trackData.duration + 5000);
    // Never serve a snippet — return null so caller gets a 404 or tries HiFi
    if (isSnipped) {
      console.warn(`[SC stream] ${origId} is snipped/sub-only, refusing to serve preview`);
      return null;
    }
    return { url, format: isHls ? 'hls' : 'mp3', quality: '128kbps', _scSnipped: false };
  } catch (e) {
    console.warn('[SC] stream error:', e.message);
    // Fallback: try cached transcoding URL directly
    if (cachedTranscodingUrl) {
      try {
        const fallbackRes = await axios.get(cachedTranscodingUrl, { params: { client_id: cid }, timeout: 6000 });
        const fallbackUrl = fallbackRes.data?.url;
        if (fallbackUrl) return { url: fallbackUrl, format: 'mp3', quality: '128kbps' };
      } catch {}
    }
    return null;
  }
}

// ─── Internet Archive Search (Music) ─────────────────────────────────────────
async function iaSearchMusic(query) {
  const cacheKey = `ia:music:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND mediatype:audio AND -mediatype:collection`,
        fl: 'identifier,title,creator,date,description',
        rows: 10,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const tracks = docs.map(d => ({
      id: `ia_music_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown'),
      album: '',
      duration: 0,
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      format: 'mp3',
      _source: 'ia_music',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, tracks, 600);
    return tracks;
  } catch (e) {
    console.warn('[IA Music] search error:', e.message);
    return [];
  }
}

async function iaGetBestAudioFile(identifier) {
  const cacheKey = `ia:files:${identifier}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 6000 });
    const files = res.data?.files || [];
    // Prefer mp3, then ogg, then flac
    const ranked = ['mp3', 'ogg', 'flac', 'wav'];
    for (const ext of ranked) {
      const f = files.find(f => f.name?.toLowerCase().endsWith(`.${ext}`) && f.source !== 'metadata');
      if (f) {
        const url = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
        await cacheSet(cacheKey, url, 3600);
        return url;
      }
    }
    return null;
  } catch { return null; }
}

// ─── Internet Archive Audiobooks ──────────────────────────────────────────────
async function iaSearchAudiobooks(query) {
  const cacheKey = `ia:audiobooks:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND (collection:librivoxaudio OR subject:audiobook OR subject:"audio book") AND mediatype:audio`,
        fl: 'identifier,title,creator,date,description,subject',
        rows: 8,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const albums = docs.map(d => ({
      id: `ia_book_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown Author'),
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      trackCount: 0,
      year: safeYear(d.date),
      _source: 'ia_book',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[IA Audiobooks] search error:', e.message);
    return [];
  }
}

// ─── LibriVox Audiobooks ──────────────────────────────────────────────────────
async function librivoxSearch(query) {
  const cacheKey = `librivox:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // LibriVox API: title search with caret prefix for broader matches
    const res = await axios.get('https://librivox.org/api/feed/audiobooks', {
      params: { title: `%5E${query}`, format: 'json', extended: 1, limit: 6 },
      timeout: 6000,
    }).catch(async () =>
      axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { title: query, format: 'json', extended: 1, limit: 6 },
        timeout: 6000,
      })
    );
    const books = Array.isArray(res.data?.books) ? res.data.books : [];
    const albums = books.map(b => ({
      id: `lvox_${b.id}`,
      title: b.title || 'Unknown',
      artist: (b.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author',
      artworkURL: b.url_zip_file ? '' : '',
      trackCount: parseInt(b.num_sections) || 0,
      year: safeYear(b.copyright_year),
      _source: 'librivox',
      _bookId: b.id,
      _rssUrl: b.url_rss,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[LibriVox] search error:', e.message);
    return [];
  }
}

async function librivoxGetChapters(bookId, rssUrl) {
  const cacheKey = `lvox:chapters:${bookId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const feedUrl = rssUrl || `https://librivox.org/rss/${bookId}`;
    const res = await axios.get(feedUrl, { timeout: 8000, responseType: 'text' });
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    let i = 0;
    while ((m = itemRe.exec(res.data)) !== null) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[([^\]]+)\]\]>/) || item.match(/<title>([^<]+)/))?.[1]?.trim() || `Chapter ${++i}`;
      const url = item.match(/url="([^"]+\.mp3)"/)?.[1] || item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || '';
      const duration = item.match(/<itunes:duration>([^<]+)/)?.[1] || '';
      const durSecs = duration.split(':').reduce((acc, t) => acc * 60 + parseInt(t || 0), 0);
      if (url) items.push({ title, url, duration: durSecs });
    }
    await cacheSet(cacheKey, items, 3600);
    return items;
  } catch (e) {
    console.warn('[LibriVox] chapter fetch error:', e.message);
    return [];
  }
}

// ─── Podcast Index ────────────────────────────────────────────────────────────
async function podcastIndexHeaders(key, secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const msgBuffer = new TextEncoder().encode(key + secret + ts);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    Authorization: hash,
    'User-Agent': 'EclipseUniversalAddon/1.0',
  };
}

async function piSearchEpisodes(query, key, secret) {
  if (!key || !secret) return { playlists: [], albums: [], episodes: [] };
  const cacheKey = `pi:episodes:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // Run both PI calls in parallel to cut search latency in half
    const [feedsRes, epRes] = await Promise.allSettled([
      axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
        params: { q: query, max: 10, fulltext: true },
        headers: podcastIndexHeaders(key, secret),
        timeout: 6000,
      }),
      axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
        params: { q: query, max: 10, fulltext: true, type: 'episode' },
        headers: podcastIndexHeaders(key, secret),
        timeout: 6000,
      }),
    ]);
    const feeds = feedsRes.status === 'fulfilled' ? (feedsRes.value.data?.feeds || []) : [];
    // Return as playlists (podcast series)
    const playlists = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      description: f.description || '',
      artworkURL: f.artwork || f.image || '',
      creator: f.author || '',
      trackCount: f.episodeCount || 0,
      _source: 'pi',
      _feedId: f.id,
      _feedUrl: f.url,
    }));
    const episodes = (epRes.status === 'fulfilled' ? (epRes.value.data?.items || epRes.value.data?.episodes || []) : []).map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Unknown Episode',
      artist: e.feedTitle || e.author || 'Unknown Podcast',
      album: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      format: 'mp3',
      streamURL: e.enclosureUrl || e.enclosure?.url || '',
      _source: 'pi',
    }));
    for (const f of feeds) {
      await cacheSet(`pi:series_info:${f.id}`, {
        title: f.title || 'Unknown Podcast',
        artworkURL: f.artwork || f.image || '',
        creator: f.author || '',
        description: f.description || '',
      }, 3600);
    }
    const albums = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      artist: f.author || '',
      artworkURL: f.artwork || f.image || '',
      trackCount: f.episodeCount || 0,
      year: 0,
      _source: 'pi',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[PI] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function piGetEpisodes(feedId, key, secret) {
  if (!key || !secret) return [];
  const cacheKey = `pi:feed:${feedId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
      params: { id: feedId, max: 50 },
      headers: podcastIndexHeaders(key, secret),
      timeout: 8000,
    });
    const items = (res.data?.items || []).map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Episode',
      artist: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      streamURL: e.enclosureUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Taddy GraphQL ────────────────────────────────────────────────────────────
async function taddySearch(query, apiKey, userId) {
  if (!apiKey || !userId) return { playlists: [], episodes: [] };
  const cacheKey = `taddy:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query { search(term: "${query.replace(/[\\'"\`\n\r{}[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}", filterForTypes: [PODCASTSERIES, PODCASTEPISODE], limitPerPage: 8) { searchId podcastSeries { uuid name imageUrl rssUrl episodes(limitPerPage: 5) { uuid name audioUrl duration imageUrl } } podcastEpisodes { uuid name audioUrl duration imageUrl podcastSeries { uuid name imageUrl } } } }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: {
        'Content-Type': 'application/json',
        'X-USER-ID': userId,
        'X-API-KEY': apiKey,
      },
      timeout: 6000,
    });
    const data = res.data?.data?.search;
    const playlists = (data?.podcastSeries || []).map(s => ({
      id: `taddy_series_${s.uuid}`,
      title: s.name || 'Unknown',
      description: s.description || '',
      artworkURL: s.imageUrl || '',
      creator: '',
      trackCount: 0,
      _source: 'taddy',
      _uuid: s.uuid,
      _episodes: s.episodes || [],
    }));
    const episodes = (data?.podcastEpisodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Unknown Episode',
      artist: e.podcastSeries?.name || 'Unknown Podcast',
      album: e.podcastSeries?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || e.podcastSeries?.imageUrl || '',
      format: 'mp3',
      streamURL: e.audioUrl || '',
      _source: 'taddy',
    }));
    for (const s of (data?.podcastSeries || [])) {
      await cacheSet(`taddy:series_info:${s.uuid}`, {
        title: s.name || 'Unknown Podcast',
        artworkURL: s.imageUrl || '',
        creator: '',
      }, 3600);
    }
    const albums = playlists.map(p => ({
      id: p.id,
      title: p.title,
      artist: p.creator || '',
      artworkURL: p.artworkURL || '',
      trackCount: p.trackCount || 0,
      year: 0,
      _source: 'taddy',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Taddy] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function taddyGetEpisodes(seriesUuid, apiKey, userId) {
  if (!apiKey || !userId) return [];
  const cacheKey = `taddy:series:${seriesUuid}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query {
    getPodcastSeries(uuid: "${seriesUuid}") {
      uuid name imageUrl
      episodes(limitPerPage: 50) {
        uuid name description audioUrl duration imageUrl datePublished
      }
    }
  }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: { 'Content-Type': 'application/json', 'X-USER-ID': userId, 'X-API-KEY': apiKey },
      timeout: 8000,
    });
    const series = res.data?.data?.getPodcastSeries;
    const items = (series?.episodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Episode',
      artist: series?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || series?.imageUrl || '',
      streamURL: e.audioUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Apple Podcasts — RSS Feed Parser ─────────────────────────────────────────
async function appleGetFeed(feedUrl, collectionId) {
  const cacheKey = `apple:feed:${collectionId || feedUrl}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(feedUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      timeout: 10000,
      responseType: 'text',
    });
    const xml = res.data;
    const chanTitle  = (xml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
    const chanArtM   = xml.match(/<itunes:image\s+href="([^"]+)"/) || xml.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/);
    const chanArt    = chanArtM ? chanArtM[1].trim() : '';
    const chanAuthor = (xml.match(/<itunes:author>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/itunes:author>/) || [])[1]?.trim() || '';
    const chanDesc   = (xml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.trim().slice(0, 500) || '';
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const episodes = [];
    let m, idx = 0;
    while ((m = itemRe.exec(xml)) !== null) {
      const item    = m[1];
      const title   = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || `Episode ${idx + 1}`;
      const encM    = item.match(/<enclosure[^>]+url="([^"]+)"/) || item.match(/<enclosure[^>]+url='([^']+)'/);
      const audioUrl = encM ? encM[1].trim() : null;
      const durStr  = (item.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/) || [])[1]?.trim() || '';
      const durSecs = durStr.includes(':')
        ? durStr.split(':').reduce((acc, t) => acc * 60 + parseInt(t, 10), 0)
        : (parseInt(durStr, 10) || 0);
      const artM  = item.match(/<itunes:image\s+href="([^"]+)"/);
      const epArt = artM ? artM[1].trim() : chanArt;
      const epId  = `apple_ep_rss_${collectionId || 'feed'}_${idx}`;
      if (audioUrl) await cacheSet(`apple:ep:stream:${epId}`, audioUrl, 3600);
      episodes.push({
        id: epId, title,
        artist: chanAuthor || chanTitle, album: chanTitle,
        duration: durSecs, artworkURL: epArt,
        format: audioUrl && audioUrl.includes('.m4a') ? 'aac' : 'mp3',
        streamURL: audioUrl, source: 'apple',
      });
      idx++;
    }
    const result = {
      id: `apple_feed_${collectionId || 'rss'}`,
      title: chanTitle || 'Podcast', artist: chanAuthor,
      artworkURL: chanArt, description: chanDesc,
      trackCount: episodes.length, tracks: episodes,
    };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] RSS feed parse error:', e.message);
    return null;
  }
}

// ─── Apple Podcasts Search (iTunes API — completely free, no key) ─────────────
async function appleSearch(query) {
  const cacheKey = `apple:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // iTunes API doesn't support entity=podcastAndEpisode — run two parallel calls
    const [showsRes, epsRes] = await Promise.allSettled([
      axios.get('https://itunes.apple.com/search', {
        params: { term: query, media: 'podcast', entity: 'podcast', limit: 10 },
        timeout: 8000,
      }),
      axios.get('https://itunes.apple.com/search', {
        params: { term: query, media: 'podcast', entity: 'podcastEpisode', limit: 10 },
        timeout: 8000,
      }),
    ]);
    const results = [
      ...(showsRes.status === 'fulfilled' ? showsRes.value.data?.results || [] : []),
      ...(epsRes.status === 'fulfilled' ? epsRes.value.data?.results || [] : []),
    ];
    const playlists = [], episodes = [];
    const seenFeed = new Set();
    for (const r of results) {
      if (r.kind === 'podcast' || (r.wrapperType === 'track' && r.collectionType === 'Podcast')) {
        if (!seenFeed.has(r.collectionId)) {
          seenFeed.add(r.collectionId);
          if (r.feedUrl) await cacheSet(`apple:feed_url:${r.collectionId}`, r.feedUrl, 86400);
          playlists.push({
            id: `apple_feed_${r.collectionId}`,
            title: r.collectionName || r.trackName || 'Unknown Podcast',
            description: r.description || '',
            artworkURL: (r.artworkUrl600 || r.artworkUrl100 || '').replace('100x100', '600x600'),
            creator: r.artistName || '', trackCount: r.trackCount || 0,
            source: 'apple', _feedUrl: r.feedUrl || null,
          });
        }
      } else if (r.kind === 'podcast-episode') {
        const epId = `apple_ep_${r.trackId}`;
        if (r.episodeUrl) await cacheSet(`apple:ep:stream:${epId}`, r.episodeUrl, 3600);
        if (r.feedUrl && r.collectionId) await cacheSet(`apple:feed_url:${r.collectionId}`, r.feedUrl, 86400);
        episodes.push({
          id: epId, title: r.trackName || 'Unknown Episode',
          artist: r.artistName || r.collectionName || 'Unknown Podcast',
          album: r.collectionName || '',
          duration: r.trackTimeMillis ? Math.floor(r.trackTimeMillis / 1000) : 0,
          artworkURL: (r.artworkUrl600 || r.artworkUrl100 || '').replace('100x100', '600x600'),
          format: 'mp3', streamURL: r.episodeUrl || null, source: 'apple',
        });
      }
    }
    const albums = playlists.map(p => ({
      id: p.id, title: p.title, artist: p.creator,
      artworkURL: p.artworkURL, trackCount: p.trackCount,
      year: 0, source: 'apple', _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}

// ─── Radio Browser ────────────────────────────────────────────────────────────
const RADIO_BROWSER_HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];

async function getRadioBrowserHost() {
  const cached = await cacheGet('radio:host');
  if (cached) return cached;
  for (const h of RADIO_BROWSER_HOSTS) {
    try {
      await axios.get(`${h}/json/stats`, { timeout: 2000 });
      await cacheSet('radio:host', h, 300);
      return h;
    } catch {}
  }
  return RADIO_BROWSER_HOSTS[0];
}

async function radioSearch(query) {
  const cacheKey = `radio:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const host = await getRadioBrowserHost();
  try {
    const res = await axios.get(`${host}/json/stations/search`, {
      params: { name: query, limit: 10, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 6000,
    });
    const stations = (res.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    // Also search by tag (genre)
    const tagRes = await axios.get(`${host}/json/stations/bytag/${encodeURIComponent(query)}`, {
      params: { limit: 5, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    }).catch(() => ({ data: [] }));
    const tagStations = (tagRes.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    const combined = [...stations, ...tagStations].reduce((acc, s) => {
      if (!acc.find(x => x._stationuuid === s._stationuuid)) acc.push(s);
      return acc;
    }, []).slice(0, 12);
    await cacheSet(cacheKey, combined, 300);
    return combined;
  } catch (e) {
    console.warn('[Radio] search error:', e.message);
    return [];
  }
}


// ─── Routes ──────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// PATCH: Replace the existing buildManifest function + manifest routes block.
//
// FIND this in your index.js (search for "// Manifest (with and without token)"):
//
//   // Manifest (with and without token)
//   function buildManifest(token) { ... }
//   app.get('/manifest.json', ...);
//   app.get('/:token/manifest.json', ...);
//
// REPLACE the entire block above with everything below this line:
// ═══════════════════════════════════════════════════════════════════════════

// ── Manifest routes ─────────────────────────────────────────────────────────
// Eclipse uses contentType in the manifest to decide which player UI to show.
// One manifest can only have one contentType, so we expose three manifest routes:
//   /{token}/manifest.json           → music player  (main addon)
//   /{token}/podcast/manifest.json   → podcast player
//   /{token}/audiobook/manifest.json → audiobook player
// All three routes hit the exact same search/stream/catalog endpoints.

function buildManifest(token, type) {
  const prefix = `com.eclipse.universal${token ? '.' + token.slice(0, 8) : ''}`;

  if (type === 'podcast') {
    return {
      id: prefix + '.podcast',
      name: 'Podcasts',
      version: '1.4.0',
      description: 'Podcast episodes and series from Podcast Index, Taddy, and Apple Podcasts',
      icon: 'https://www.jermelpresident.com/wp-content/uploads/2020/10/ApplePodcastHP.jpg',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'playlist'],
      contentType: 'podcast',
    };
  }

  if (type === 'audiobook') {
    return {
      id: prefix + '.audiobook',
      name: 'Audiobooks',
      version: '1.4.0',
      description: 'Public domain audiobooks from LibriVox and Internet Archive',
      icon: 'https://play-lh.googleusercontent.com/-x0uIYaNWONIRefvL7u4pi75rh4fi5441J0EelEpoOaGRZbAPdhRqKxBu-cvvCV5dw',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album'],
      contentType: 'audiobook',
    };
  }

  // Default: music
  return {
    id: prefix,
    name: 'All In One',
    version: '1.4.0',
    description: 'All-in-one: HiFi music, SoundCloud, Internet Archive, Podcasts, Audiobooks, and Live Radio',
    icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTueIUOQATc6lrir4FpwhFl9P656MBFPkvOV03N5P3zlA&s=10',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  };
}

// ── Main manifest (music player) ─────────────────────────────────────────────
app.get('/manifest.json', c => c.json(buildManifest(null, 'music')));
app.get('/:token/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'music')));

// ── Podcast sub-manifest → podcast player UI ─────────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/podcast/manifest.json
app.get('/podcast/manifest.json', c => c.json(buildManifest(null, 'podcast')));
app.get('/:token/podcast/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'podcast')));

// ── Audiobook sub-manifest → audiobook player UI ─────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/audiobook/manifest.json
app.get('/audiobook/manifest.json', c => c.json(buildManifest(null, 'audiobook')));
app.get('/:token/audiobook/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'audiobook')));

// Search (with and without token)
async function handleSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  // ── Tiered search: fast sources (3s) fire first, slow sources fill in after ──
  // Tier 1: music-critical sources — resolve fast or skip
  const FAST_MS  = 7000;
  const TOTAL_MS = 7000;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
  }

  // Fire all sources immediately but cap how long we wait
  const [
    hifiRes, scRes, iaMusicRes,
    piRes, taddyRes, appleRes,
    lvoxRes, iaBookRes, radioRes,
  ] = await Promise.all([
    withTimeout(hifiSearch(query, cfg.hifiInstances),            7000),
    withTimeout(scSearch(query, cfg.scClientId),                 4000),
    withTimeout(iaSearchMusic(query),                            4000),
    withTimeout(piSearchEpisodes(query, cfg.piKey, cfg.piSecret),TOTAL_MS),
    withTimeout(taddySearch(query, cfg.taddyKey, cfg.taddyUid),  TOTAL_MS),
    withTimeout(appleSearch(query),                              TOTAL_MS),
    withTimeout(librivoxSearch(query),                           TOTAL_MS),
    withTimeout(iaSearchAudiobooks(query),                       TOTAL_MS),
    withTimeout(radioSearch(query),                              4000),
  ]);

  const scResult    = scRes    || {};
  const sc          = Array.isArray(scResult) ? scResult : (scResult.tracks    || []);
  const scPlaylists = Array.isArray(scResult) ? []       : (scResult.playlists || []);
  const iaMusic     = iaMusicRes || [];

  const piResult    = piRes    || { playlists: [], episodes: [], albums: [] };
  const taddyResult = taddyRes || { playlists: [], episodes: [], albums: [] };
  const appleResult = appleRes || { playlists: [], episodes: [], albums: [] };
  const lvox        = lvoxRes  || [];
  const iaBooks     = iaBookRes || [];
  const radio       = radioRes || [];
  const piAlbums    = piResult.albums    || [];
  const taddyAlbums = taddyResult.albums || [];
  const appleAlbums = appleResult.albums || [];

  // Merge podcast episodes: PI first, then Taddy (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  for (const ep of [...(piResult.episodes || []), ...(taddyResult.episodes || []), ...(appleResult.episodes || [])]) {
    const key = ep.title?.toLowerCase().slice(0, 40);
    if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
  }

  // Merge podcast series: PI first, then Taddy
  const seriesTitles = new Set();
  const allSeries = [];
  for (const s of [...scPlaylists, ...(piResult.playlists || []), ...(taddyResult.playlists || []), ...(appleResult.playlists || [])]) {
    const key = s.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
  }

  // Merge audiobook albums: LibriVox first, then IA
  const bookTitles = new Set();
  const allBooks = [];
  for (const b of [...lvox, ...iaBooks]) {
    const key = b.title?.toLowerCase().slice(0, 40);
    if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
  }

  // Normalize HiFi result (now returns object)
  const hifiResult     = hifiRes || {};
  const hifiTrackList  = Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks  || []);
  const hifiAlbumList  = Array.isArray(hifiResult) ? []         : (hifiResult.albums  || []);
  const hifiArtistList = Array.isArray(hifiResult) ? []         : (hifiResult.artists || []);

  // Re-encode instB64 for tracks that came back with raw inst
  const hifiTracksNorm = hifiTrackList.map(t => {
    if (t.id && t.id.startsWith('hifi_')) return t;
    const instB64 = encodeBase64Url(t._inst || '');
    return { ...t, id: `hifi_${instB64}_${t._origId || t.id}` };
  });

  // Dedupe podcast albums
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...piAlbums, ...taddyAlbums, ...appleAlbums]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  // Smart query-type detection
  const qLow = query.toLowerCase();
  const isPodcastQuery = /podcast|episode|rogan|lex fridman|serial|npr|radiolab|conan|armchair|smartless|call her daddy|pardon my take|crime junkie|huberman|theo von|apple podcast/i.test(qLow)
    || (allEpisodes.length > 0 && hifiTrackList.length === 0);
  const isRadioQuery    = /\bfm\b|radio|station|lofi|lo-fi|chillhop|chillout|ambient|bbc|rnz/i.test(qLow);
  const isAudiobookQuery = /audiobook|librivox|sherlock|austen|dickens|tolkien|public domain/i.test(qLow);

  let allTracks, allAlbums, allArtists;
  if (isPodcastQuery) {
    allTracks  = [...allEpisodes, ...sc, ...hifiTracksNorm, ...iaMusic, ...radio];
    allAlbums  = [...podcastAlbums, ...allBooks, ...hifiAlbumList];
    allArtists = hifiArtistList;
  } else if (isRadioQuery) {
    allTracks  = [...radio, ...sc, ...hifiTracksNorm, ...iaMusic, ...allEpisodes];
    allAlbums  = [...hifiAlbumList, ...allBooks, ...podcastAlbums];
    allArtists = hifiArtistList;
  } else if (isAudiobookQuery) {
    allTracks  = [...iaMusic, ...allEpisodes, ...sc, ...hifiTracksNorm, ...radio];
    allAlbums  = [...allBooks, ...hifiAlbumList, ...podcastAlbums];
    allArtists = [];
  } else {
    allTracks  = [...hifiTracksNorm, ...sc, ...iaMusic, ...radio, ...allEpisodes];
    allAlbums  = [...hifiAlbumList, ...allBooks, ...podcastAlbums];
    allArtists = hifiArtistList;
  }

  const result = {
    tracks:    allTracks.slice(0, 40),
    albums:    allAlbums.slice(0, 12),
    artists:   allArtists.slice(0, 8),
    playlists: allSeries.slice(0, 10),
  };

  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

app.get('/search', handleSearch);
app.get('/:token/search', handleSearch);

// ─── Podcast-only search (/podcast/search) ───────────────────────────────────
async function handlePodcastSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:podcast:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [podcastData, taddyData, appleData] = await Promise.allSettled([
    piSearchEpisodes(query, cfg.piKey, cfg.piSecret),
    taddySearch(query, cfg.taddyKey, cfg.taddyUid),
    appleSearch(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || {};

  const piResult    = get(podcastData);
  const taddyResult = get(taddyData);
  const appleResult = get(appleData);

  // Merge episodes (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  for (const ep of [...(piResult.episodes||[]), ...(taddyResult.episodes||[]), ...(appleResult.episodes||[])]) {
    const key = ep.title?.toLowerCase().slice(0, 40);
    if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
  }

  // Merge series/playlists (dedupe by title)
  const seriesTitles = new Set();
  const allSeries = [];
  for (const s of [...(piResult.playlists||[]), ...(taddyResult.playlists||[]), ...(appleResult.playlists||[])]) {
    const key = s.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
  }

  // Merge podcast show albums (dedupe by id)
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...(piResult.albums||[]), ...(taddyResult.albums||[]), ...(appleResult.albums||[])]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  const result = {
    tracks:    allEpisodes.slice(0, 40),
    albums:    podcastAlbums.slice(0, 12),
    playlists: allSeries.slice(0, 10),
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Audiobook-only search (/audiobook/search) ───────────────────────────────
async function handleAudiobookSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:audiobook:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [lvoxAlbums, iaBookAlbums] = await Promise.allSettled([
    librivoxSearch(query),
    iaSearchAudiobooks(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || [];

  const lvox    = get(lvoxAlbums);
  const iaBooks = get(iaBookAlbums);

  // Merge audiobook albums (dedupe by title)
  const bookTitles = new Set();
  const allBooks = [];
  for (const b of [...lvox, ...iaBooks]) {
    const key = b.title?.toLowerCase().slice(0, 40);
    if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
  }

  // Build flat track list from book albums so Eclipse shows them as playable items
  const bookTracks = allBooks.map(b => ({
    id:         b.id,
    title:      b.title,
    artist:     b.artist || b.creator || 'Unknown Author',
    album:      b.title,
    duration:   b.duration || null,
    artworkURL: b.artworkURL || null,
  }));

  const result = {
    tracks:    bookTracks.slice(0, 20),
    albums:    allBooks.slice(0, 20),
    playlists: [],
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Sub-routes for podcast manifest base URL ────────────────────────────────
app.get('/podcast/search',              handlePodcastSearch);
app.get('/:token/podcast/search',       handlePodcastSearch);
app.get('/podcast/stream/:id',          handleStream);
app.get('/:token/podcast/stream/:id',   handleStream);
app.get('/podcast/album/:id',           handleAlbumWithHifi);
app.get('/:token/podcast/album/:id',    handleAlbumWithHifi);
app.get('/podcast/playlist/:id',        handlePlaylist);
app.get('/:token/podcast/playlist/:id', handlePlaylist);

// ─── Sub-routes for audiobook manifest base URL ──────────────────────────────
app.get('/audiobook/search',               handleAudiobookSearch);
app.get('/:token/audiobook/search',        handleAudiobookSearch);
app.get('/audiobook/stream/:id',           handleStream);
app.get('/:token/audiobook/stream/:id',    handleStream);
app.get('/audiobook/album/:id',            handleAlbumWithHifi);
app.get('/:token/audiobook/album/:id',     handleAlbumWithHifi);
app.get('/audiobook/playlist/:id',         handlePlaylist);
app.get('/:token/audiobook/playlist/:id',  handlePlaylist);


// Lightweight resolve for playlist import — HiFi only, skips podcast/radio/IA overhead
// Use this endpoint for per-track lookups during CSV/link playlist imports
async function handleResolve(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [] });
  const cfg = getConfig(c);
  const cacheKey = `resolve:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);
  try {
    // HiFi first — fastest and highest quality
    const hifiResult = await hifiSearch(query, cfg.hifiInstances);
    let tracks = (Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks || [])).slice(0, 5);
    // SC fallback only if HiFi came back empty
    if (!tracks.length) {
      const scResult = await scSearch(query, cfg.scClientId);
      tracks = (Array.isArray(scResult) ? scResult : (scResult.tracks || [])).slice(0, 5);
    }
    const result = { tracks };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  } catch (e) {
    console.warn('[resolve] error:', e.message);
    return c.json({ tracks: [] });
  }
}

app.get('/resolve', handleResolve);
app.get('/:token/resolve', handleResolve);

// Stream resolution
async function handleStream(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  if (id.startsWith('hifi_')) {
    // Check stream URL cache first — makes repeat plays instant
    const streamCacheKey = `stream:url:${id}`;
    const cachedStream = await cacheGet(streamCacheKey);
    if (cachedStream) return c.json(cachedStream);

    // ── Qobuz Hi-Res FIRST (exactly like Claudochrome) ────────────────────────
    // Look up title+artist from search cache, search Qobuz proxy, stream best match
    const trackKey = id.slice(5); // strip 'hifi_' -> instB64_origId
    const qMeta = await cacheGet(`hifi:track:meta:${trackKey}`);
    if (qMeta?.title) {
      try {
        const qTrack = await qobuzFindBestTrack(qMeta.title, qMeta.artist);
        if (qTrack && qTrack.id) {
          const qStream = await qobuzStream(qTrack.id);
          if (qStream) {
            console.log(`[Qobuz] HIT "${qMeta.title}" by "${qMeta.artist}" -> id=${qTrack.id} quality=${qStream.quality}`);
            await cacheSet(streamCacheKey, qStream, 280);
            return c.json(qStream);
          }
        }
        console.log(`[Qobuz] no match for "${qMeta.title}" by "${qMeta.artist}" — falling back to HiFi`);
      } catch(e) {
        console.warn('[Qobuz] error:', e.message);
      }
    }
    // ── HiFi fallback ─────────────────────────────────────────────────────────

    const data = await hifiStream(id, cfg.hifiInstances, cfg.preferredQuality);
    if (data) {
      // Cache stream URLs for 5 minutes (short TTL — they expire)
      await cacheSet(streamCacheKey, data, 280);
      return c.json(data);
    }

    // HiFi failed — fallback to SC (trackKey already declared above)
    const meta = await cacheGet(`hifi:track:meta:${trackKey}`);

    if (meta?.title && meta?.artist) {
      // ── Fallback: SoundCloud — search then stream ALL candidates in parallel ──
      console.log(`[stream fallback] HiFi failed, trying SC for "${meta.title}" by "${meta.artist}"`);
      try {
        const cid = await getSCClientId(cfg.scClientId);
        if (cid) {
          const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: `${meta.artist} ${meta.title}`, client_id: cid, limit: 8 },
            timeout: 6000,
          });
          const scTracks = scRes.data?.collection || [];
          // Attempt all SC candidates simultaneously — first non-snipped stream wins
          const scStreamResults = await Promise.all(
            scTracks.map(st => scStream(String(st.id), cid).then(r => ({ r, st })).catch(() => ({ r: null, st })))
          );
          for (const { r: scStreamResult, st } of scStreamResults) {
            if (scStreamResult && !scStreamResult._scSnipped) {
              console.log(`[stream fallback] SC found: "${st.title}" by "${st.user?.username}"`);
              const { _scSnipped, ...cleanResult } = scStreamResult;
              const fallbackResult = { ...cleanResult, fallback: 'sc' };
              await cacheSet(`stream:url:${id}`, fallbackResult, 280);
              return c.json(fallbackResult);
            }
          }
        }
      } catch (e) {
        console.warn('[stream fallback] SC fallback error:', e.message);
      }
    }
    return c.json({ error: 'HiFi stream not found — SC fallback also failed' });
  }

  if (id.startsWith('sc_')) {
    const origId = id.slice(3);
    const scStreamCacheKey = `stream:url:${id}`;
    const cachedScStream = await cacheGet(scStreamCacheKey);
    if (cachedScStream) return c.json(cachedScStream);
    const data = await scStream(origId, cfg.scClientId);
    if (data) {
      const { _scSnipped, ...cleanData } = data;
      await cacheSet(scStreamCacheKey, cleanData, 280);
      return c.json(cleanData);
    }
    // SC returned null (snipped/blocked) — try HiFi then DAB as fallback
    const scMeta = await cacheGet(`sc:meta:${origId}`);
    if (scMeta?.title && scMeta?.artist) {
      console.log(`[SC fallback] ${origId} snipped, trying HiFi for ${scMeta.title}`);
      try {
        const hifiRes = await hifiSearch(`${scMeta.artist} ${scMeta.title}`, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
        for (const ht of hifiTracks.slice(0, 3)) {
          const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hifiStreamResult) return c.json({ ...hifiStreamResult, fallback: 'hifi' });
        }
      } catch (e) { console.warn('[SC fallback] HiFi error:', e.message); }

    }
    return c.json({ error: 'SoundCloud stream not found or restricted' });
  }

  if (id.startsWith('ia_music_')) {
    const identifier = id.slice(9);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA stream not found' });
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA audiobook stream not found' });
  }

  if (id.startsWith('radio_')) {
    // Radio stream URLs are stored directly in search results as streamURL
    // If we get here, try to find from cache
    return c.json({ error: 'Radio stream: use streamURL from search result' });
  }

  // Podcast episodes (pi_ep_, taddy_ep_) have streamURL in search results
  if (id.startsWith('pi_ep_') || id.startsWith('taddy_ep_')) {
    return c.json({ error: 'Podcast stream: use streamURL from search result' });
  }

  // ── Apple Podcast episode stream ────────────────────────────────────────────
  if (id.startsWith('apple_ep_')) {
    const cachedUrl = await cacheGet(`apple:ep:stream:${id}`);
    if (cachedUrl) {
      return c.json({ url: cachedUrl, format: cachedUrl.includes('.m4a') ? 'aac' : 'mp3', quality: 'variable' });
    }
    const trackId = id.startsWith('apple_ep_rss_') ? null : id.slice('apple_ep_'.length);
    if (trackId && /^[0-9]+$/.test(trackId)) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: trackId, media: 'podcast', entity: 'podcastEpisode', limit: 1 },
          timeout: 6000,
        });
        const ep = (lu.data?.results || []).find(r => r.kind === 'podcast-episode' || r.wrapperType === 'track');
        const url = ep?.episodeUrl;
        if (url) {
          await cacheSet(`apple:ep:stream:${id}`, url, 3600);
          return c.json({ url, format: 'mp3', quality: 'variable' });
        }
      } catch (e) {
        console.warn('[Apple] episode stream lookup error:', e.message);
      }
    }
    return c.json({ error: 'Apple Podcast episode stream URL not found' });
  }

  if (id.startsWith('lvox_')) {
    return c.json({ error: 'LibriVox: use /album/{id} and browse chapters' });
  }

  // ── Social/Community Tab & Cross-Addon Track Fallback ───────────────────────
  // Tracks from Social/Community tab or other addons (Apple Music, Tidal, Deezer,
  // Spotify, etc.) arrive with foreign ID prefixes this addon doesn't own.
  // Eclipse passes ?title=&artist= query params alongside the foreign ID —
  // we use those to search our own sources for the best match.
  //
  // Strategy:
  //   0. Extract search query: prefer ?title+artist params, fall back to raw ID.
  //   1. Bare numeric ID → try HiFi directly (likely a Tidal track ID).
  //   2. HiFi search using title+artist — best quality.
  //   3. SC search using title+artist — broad availability.
  //   4. Last resort: HiFi search using raw ID string.
  {
    const rawId = id;
    const decodedId = (() => { try { return decodeURIComponent(rawId); } catch (e) { return rawId; } })();

    // Eclipse passes title/artist as query params for cross-addon tracks
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || decodedId);

    console.log(`[Social fallback] id="${decodedId}" title="${qTitle}" artist="${qArtist}" → query="${searchQuery}"`);

    const cid = await getSCClientId(cfg.scClientId);
    const _socialInstances = (cfg.hifiInstances && cfg.hifiInstances.length) ? cfg.hifiInstances : DEFAULT_HIFI_INSTANCES;

    // 1. Bare numeric ID → try HiFi directly as a Tidal track ID
    if (/^\d+$/.test(decodedId)) {
      let hifiDirectResult = null;
      for (const _inst of _socialInstances) {
        const instB64 = encodeBase64Url(_inst);
        const syntheticHifiId = `hifi_${instB64}_${decodedId}`;
        hifiDirectResult = await hifiStream(syntheticHifiId, cfg.hifiInstances, cfg.preferredQuality);
        if (hifiDirectResult) break;
      }
      if (hifiDirectResult) {
        console.log(`[Social fallback] HiFi direct stream success for numeric ID ${decodedId}`);
        return c.json({ ...hifiDirectResult, fallback: 'social_hifi_direct' });
      }
    }

    // 2. HiFi search using title+artist (or raw ID as fallback query)
    if (searchQuery.length > 1) {
      try {
        console.log(`[Social fallback] HiFi search: "${searchQuery}"`);
        const hifiSearchResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiSearchResult) ? hifiSearchResult : (hifiSearchResult?.tracks || []);
        for (const ht of hifiTracks.slice(0, 5)) {
          const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hifiStreamResult) {
            console.log(`[Social fallback] HiFi matched: "${ht.title}" by "${ht.artist}"`);
            return c.json({ ...hifiStreamResult, fallback: 'social_hifi_search' });
          }
        }
      } catch (e) {
        console.warn('[Social fallback] HiFi search failed:', e.message);
      }

      // 3. SoundCloud search using title+artist
      if (cid) {
        try {
          console.log(`[Social fallback] SC search: "${searchQuery}"`);
          const scSearchRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: searchQuery, client_id: cid, limit: 5 },
            timeout: 8000,
          });
          const candidates = scSearchRes.data?.collection || [];
          const streamAttempts = await Promise.all(
            candidates.map(t => scStream(String(t.id), cid).then(r => ({ r, t })).catch(() => ({ r: null, t })))
          );
          for (const { r, t } of streamAttempts) {
            if (r && !r._scSnipped) {
              console.log(`[Social fallback] SC matched: "${t.title}" by "${t.user?.username}"`);
              const { _scSnipped, ...clean } = r;
              return c.json({ ...clean, fallback: 'social_sc' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] SC search failed:', e.message);
        }
      }

      // 4. Last resort: if no title/artist params, try HiFi with raw ID as query
      if (!qTitle && !qArtist) {
        try {
          console.log(`[Social fallback] last resort HiFi for raw id: "${decodedId}"`);
          const hifiSearchResult2 = await hifiSearch(decodedId, cfg.hifiInstances);
          const hifiTracks2 = Array.isArray(hifiSearchResult2) ? hifiSearchResult2 : (hifiSearchResult2?.tracks || []);
          for (const ht of hifiTracks2.slice(0, 3)) {
            const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (hifiStreamResult) {
              console.log(`[Social fallback] last resort HiFi matched: "${ht.title}"`);
              return c.json({ ...hifiStreamResult, fallback: 'social_hifi_lastresort' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] last resort HiFi failed:', e.message);
        }
      }
    }
  }

  c.json({ error: 'Unknown stream ID — could not resolve via any source' }, 404);
}

app.get('/stream/:id', handleStream);
app.get('/:token/stream/:id', handleStream);

// Album detail (audiobooks)
async function handleAlbum(c) {
  const id = c.req.param('id');

  if (id.startsWith('lvox_')) {
    const bookId = id.slice(5);
    const cacheKey = `album:lvox:${bookId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    // Look up book info
    try {
      const infoRes = await axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { id: bookId, format: 'json', extended: 1 },
        timeout: 6000,
      });
      const book = infoRes.data?.books?.[0] || {};
      const rssUrl = book.url_rss || `https://librivox.org/rss/${bookId}`;
      const author = (book.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author';
      const chapters = await librivoxGetChapters(bookId, rssUrl);
      const albumData = {
        id,
        title: book.title || `LibriVox Book ${bookId}`,
        artist: author,
        artworkURL: '',
        year: safeYear(book.copyright_year),
        description: book.description || '',
        trackCount: chapters.length,
        tracks: chapters.map((c, i) => ({
          id: `lvox_ch_${bookId}_${i}`,
          title: c.title,
          artist: author,
          duration: c.duration,
          streamURL: c.url,
          format: 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch (e) {
      return c.json({ error: 'LibriVox album fetch failed' });
    }
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const cacheKey = `album:ia_book:${identifier}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const meta = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 6000 });
      const m = meta.data?.metadata || {};
      const files = (meta.data?.files || [])
        .filter(f => ['mp3','ogg','flac'].some(ext => f.name?.toLowerCase().endsWith(`.${ext}`)) && f.source !== 'metadata')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const albumData = {
        id,
        title: Array.isArray(m.title) ? m.title[0] : (m.title || identifier),
        artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
        artworkURL: `https://archive.org/services/img/${identifier}`,
        year: safeYear(m.date),
        description: Array.isArray(m.description) ? m.description[0] : (m.description || ''),
        trackCount: files.length,
        tracks: files.map((f, i) => ({
          id: `ia_book_file_${identifier}_${i}`,
          title: f.title || f.name?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || `Track ${i + 1}`,
          artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
          duration: f.length ? parseInt(f.length) : 0,
          streamURL: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
          format: f.name?.split('.').pop()?.toLowerCase() || 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch {
      return c.json({ error: 'IA audiobook album fetch failed' });
    }
  }

  c.json({ error: 'Album not found' }, 404);
}

async function handleAlbumWithHifi(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // ── HiFi album ──────────────────────────────────────────────────────────
  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  // ── Podcast Index feed album ─────────────────────────────────────────────
  if (id.startsWith('pi_feed_')) {
    const feedId   = id.slice(8);
    const cacheKey = `album:pi_feed:${feedId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [feedRes, epRes] = await Promise.allSettled([
      cfg.piKey && cfg.piSecret
        ? axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
            params: { id: feedId },
            headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
            timeout: 8000,
          })
        : Promise.resolve(null),
      cfg.piKey && cfg.piSecret
        ? axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
            params: { id: feedId, max: 200, fulltext: true },
            headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
            timeout: 10000,
          })
        : Promise.resolve(null),
    ]);

    const feed = feedRes.status === 'fulfilled' && feedRes.value
      ? (feedRes.value.data?.feed || {})
      : {};
    const episodes = epRes.status === 'fulfilled' && epRes.value
      ? (epRes.value.data?.items || [])
      : [];

    // Fallback: use cached series info if feed API call failed
    if (!feed.title) {
      const cached_info = await cacheGet(`pi:series_info:${feedId}`);
      if (cached_info) { feed.title = cached_info.title; feed.image = cached_info.artworkURL; feed.author = cached_info.creator; }
    }

    const tracks = episodes.map(ep => ({
      id: `pi_ep_${ep.id}`,
      title: ep.title || 'Episode',
      artist: ep.feedAuthor || ep.feedTitle || feed.title || '',
      album:  ep.feedTitle  || feed.title  || '',
      duration:   typeof ep.duration === 'number' ? ep.duration : null,
      artworkURL: ep.image || ep.feedImage || feed.image || feed.artwork || null,
      streamURL:  ep.enclosureUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       feed.title       || 'Podcast',
      artist:      feed.author      || feed.ownerName || '',
      artworkURL:  feed.image       || feed.artwork   || null,
      year:        feed.newestItemPublishTime ? safeYear(new Date(feed.newestItemPublishTime * 1000).getFullYear()) : 0,
      description: (feed.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }

  // ── Taddy series album ───────────────────────────────────────────────────
  if (id.startsWith('taddy_series_')) {
    const uuid     = id.slice(13);
    const cacheKey = `album:taddy_series:${uuid}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    if (!cfg.taddyKey || !cfg.taddyUid) {
      return c.json({ error: 'No Taddy credentials configured.' });
    }

    let pod = {};
    try {
      const gql = `query {
        getPodcastSeries(uuid: "${uuid}") {
          uuid name description imageUrl authorName
          episodes(limitPerPage: 200) {
            uuid name audioUrl duration imageUrl
          }
        }
      }`;
      const r = await axios.post('https://api.taddy.org', { query: gql }, {
        headers: {
          'Content-Type': 'application/json',
          'X-USER-ID': cfg.taddyUid,
          'X-API-KEY': cfg.taddyKey,
        },
        timeout: 10000,
      });
      pod = r.data?.data?.getPodcastSeries || {};
    } catch (e) {
      console.warn('[Taddy] album fetch error:', e.message);
    }

    // Fallback: use cached series info if Taddy call failed
    if (!pod.name) {
      const cached_info = await cacheGet(`taddy:series_info:${uuid}`);
      if (cached_info) { pod.name = cached_info.title; pod.imageUrl = cached_info.artworkURL; }
    }

    const tracks = (pod.episodes || []).map(ep => ({
      id: `taddy_ep_${ep.uuid}`,
      title:      ep.name    || 'Episode',
      artist:     pod.authorName || pod.name || '',
      album:      pod.name   || '',
      duration:   ep.duration || null,
      artworkURL: ep.imageUrl || pod.imageUrl || null,
      streamURL:  ep.audioUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       pod.name        || 'Podcast',
      artist:      pod.authorName  || '',
      artworkURL:  pod.imageUrl    || null,
      year:        0,
      description: (pod.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }


  // ── Apple Podcast feed album ──────────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `album:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 6000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] album feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) { await cacheSet(cacheKey, feedData, 600); return c.json(feedData); }
    }
    try {
      const lu = await axios.get('https://itunes.apple.com/lookup', {
        params: { id: collectionId, media: 'podcast', entity: 'podcastEpisode', limit: 200 },
        timeout: 10000,
      });
      const results = lu.data?.results || [];
      const show = results.find(r => r.wrapperType === 'collection' || r.collectionType === 'Podcast');
      const eps  = results.filter(r => r.kind === 'podcast-episode');
      const tracks = eps.map((r, i) => {
        const epId = `apple_ep_${r.trackId}`;
        if (r.episodeUrl) cacheSet(`apple:ep:stream:${epId}`, r.episodeUrl, 3600);
        return {
          id: epId, title: r.trackName || `Episode ${i + 1}`,
          artist: r.artistName || show?.collectionName || '',
          album: r.collectionName || show?.collectionName || '',
          duration: r.trackTimeMillis ? Math.floor(r.trackTimeMillis / 1000) : 0,
          artworkURL: (r.artworkUrl600 || r.artworkUrl100 || show?.artworkUrl600 || '').replace('100x100', '600x600'),
          format: 'mp3', streamURL: r.episodeUrl || null, source: 'apple',
        };
      });
      const albumData = {
        id, title: show?.collectionName || 'Apple Podcast',
        artist: show?.artistName || '',
        artworkURL: (show?.artworkUrl600 || '').replace('100x100', '600x600'),
        year: 0, description: show?.description || '',
        trackCount: tracks.length, tracks,
      };
      await cacheSet(cacheKey, albumData, 600);
      return c.json(albumData);
    } catch (e) { console.warn('[Apple] album fallback lookup error:', e.message); }
    return c.json({ error: 'Apple Podcast feed not found' });
  }

  // ── Social/Cross-Addon Album Fallback ───────────────────────────────────────
  // Album IDs from other addons (Apple Music, Tidal, Deezer, Spotify, etc.)
  // won't match any known prefix. Eclipse passes ?title=&artist= params.
  // Use those to search HiFi for the best matching album.
  {
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const decodedAlbumId = (() => { try { return decodeURIComponent(id); } catch (e) { return id; } })();
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || '');

    if (searchQuery.length > 1) {
      console.log(`[Album social fallback] id="${decodedAlbumId}" query="${searchQuery}" — searching HiFi`);
      try {
        const hifiResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const albums = Array.isArray(hifiResult) ? [] : (hifiResult?.albums || []);
        if (albums.length) {
          const albumData = await hifiAlbum(albums[0].id);
          if (albumData) {
            console.log(`[Album social fallback] HiFi album matched: "${albumData.title}"`);
            return c.json(albumData);
          }
        }
        // No album objects — build a synthetic album from track results
        const tracks = Array.isArray(hifiResult) ? hifiResult : (hifiResult?.tracks || []);
        if (tracks.length) {
          console.log(`[Album social fallback] building synthetic album from tracks for "${searchQuery}"`);
          const syntheticAlbum = {
            id,
            title: qTitle || tracks[0]?.album || searchQuery,
            artist: qArtist || tracks[0]?.artist || '',
            artworkURL: tracks[0]?.artworkURL || null,
            trackCount: tracks.length,
            tracks: tracks.slice(0, 50),
          };
          return c.json(syntheticAlbum);
        }
      } catch (e) {
        console.warn('[Album social fallback] HiFi search error:', e.message);
      }
    }
  }

  return handleAlbum(c);
}
app.get('/album/:id', handleAlbumWithHifi);
app.get('/:token/album/:id', handleAlbumWithHifi);

// ─── Artist detail ────────────────────────────────────────────────────────────
async function handleArtist(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_artist_')) {
    const withoutPrefix = id.slice(12);
    const firstUnderscore = withoutPrefix.indexOf('_');
    const instB64  = withoutPrefix.slice(0, firstUnderscore);
    const artistId = withoutPrefix.slice(firstUnderscore + 1);
    const inst     = decodeBase64Url(instB64);
    const cacheKey = `hifi:artist:${instB64}:${artistId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const coverUrl = (uuid, size = 1280) => uuid
        ? `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg`
        : undefined;

      // Fire ALL endpoints in parallel across multiple param variations
      // Covers all known HiFi API v2.x instance response shapes
      const [infoRes, discRes, albumsRes, topTracksRes, albumsRes2, discRes2] = await Promise.allSettled([
        axios.get(`${inst}/artist/`, { params: { id: artistId }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        axios.get(`${inst}/artist/`, { params: { f: artistId, skip_tracks: false }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, limit: 50, offset: 0 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        axios.get(`${inst}/artist/toptracks/`, { params: { id: artistId, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        axios.get(`${inst}/artist/albums/`, { params: { artistId, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        axios.get(`${inst}/artist/discography/`, { params: { id: artistId, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      ]);

      // ── Artist info ──────────────────────────────────────────────────────────
      let artistInfo = {};
      if (infoRes.status === 'fulfilled') {
        const d = infoRes.value.data?.data || infoRes.value.data || {};
        if      (d.artist?.id)   artistInfo = d.artist;
        else if (d.id && d.name) artistInfo = d;
      }
      // Fallback: discography response often embeds artist info too
      if (!artistInfo.name && discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        if      (dd.artist?.id)   artistInfo = dd.artist;
        else if (dd.id && dd.name) artistInfo = dd;
      }

      // ── Albums — merge all sources, dedupe by album id ───────────────────────
      const albumMap = {};
      const addAlbums = (arr) => {
        for (const a of (Array.isArray(arr) ? arr : [])) {
          if (!a?.id) continue;
          if (!albumMap[String(a.id)]) albumMap[String(a.id)] = a;
        }
      };
      // Helper to extract array from any known response shape
      const extractList = (res, keys = ['items', 'tracks', 'albums']) => {
        if (res.status !== 'fulfilled' || !res.value) return [];
        const d = res.value.data?.data || res.value.data || {};
        for (const k of keys) {
          if (Array.isArray(d[k])) return d[k];
          if (Array.isArray(d[k]?.items)) return d[k].items;
        }
        if (Array.isArray(d)) return d;
        return [];
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addAlbums(Array.isArray(dd.albums) ? dd.albums : (dd.albums?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addAlbums(Array.isArray(dd2.albums) ? dd2.albums : (dd2.albums?.items || []));
        addAlbums(Array.isArray(dd2.items) ? dd2.items : []);
      }
      for (const aRes of [albumsRes, albumsRes2]) {
        if (aRes.status === 'fulfilled') {
          const ad = aRes.value.data?.data || aRes.value.data;
          addAlbums(Array.isArray(ad) ? ad : (ad?.items || []));
        }
      }
      // Also extract albums from info response (some instances nest them there)
      if (infoRes.status === 'fulfilled') {
        const id2 = infoRes.value.data?.data || infoRes.value.data || {};
        addAlbums(Array.isArray(id2.albums) ? id2.albums : (id2.albums?.items || []));
      }

      // ── Tracks — merge discography + toptracks ───────────────────────────────
      const trackMap = {};
      const addTracks = (arr) => {
        for (const t of (Array.isArray(arr) ? arr : [])) {
          if (!t?.id) continue;
          if (!trackMap[String(t.id)]) trackMap[String(t.id)] = t;
        }
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addTracks(Array.isArray(dd.tracks) ? dd.tracks : (dd.tracks?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addTracks(Array.isArray(dd2.tracks) ? dd2.tracks : (dd2.tracks?.items || []));
      }
      if (topTracksRes.status === 'fulfilled') {
        const td = topTracksRes.value.data?.data || topTracksRes.value.data || {};
        addTracks(td.items || td.tracks || (Array.isArray(td) ? td : []));
      }

      // ── Search fallback if both album sources came back empty ─────────────────
      if (!Object.keys(albumMap).length && artistInfo.name) {
        try {
          const sData = await axios.get(`${inst}/search/`, { params: { s: artistInfo.name, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 8000 });
          const sItems = sData.data?.data?.items || sData.data?.items || [];
          const wantName = artistInfo.name.toLowerCase();
          for (const t of sItems) {
            if (!t?.album?.id) continue;
            const tArtist = ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED') : (t.artists || [])).map(a => a.name).join(', ').toLowerCase();
            if (!tArtist.includes(wantName) && !wantName.includes(tArtist)) continue;
            const alId = String(t.album.id);
            if (!albumMap[alId]) albumMap[alId] = { id: t.album.id, title: t.album.title, cover: t.album.cover, releaseDate: t.album.releaseDate, source: 'hifi' };
            if (!trackMap[String(t.id)] && t.streamReady !== false) trackMap[String(t.id)] = t;
          }
        } catch (e6) { console.log('[HiFi] search fallback failed:', e6.message); }
      }

      const artistName = artistInfo.name || 'Unknown Artist';
      const artworkURL = artistInfo.picture ? coverUrl(artistInfo.picture, 480) : undefined;

      const topTracks = Object.values(trackMap)
        .filter(t => t.streamReady !== false)
        .slice(0, 20)
        .map(t => ({
          id:         `hifi_${instB64}_${t.id}`,
          title:      t.title || 'Unknown',
          artist:     ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
          album:      t.album?.title || '',
          duration:   t.duration ? Math.floor(t.duration) : undefined,
          artworkURL: t.album?.cover ? coverUrl(t.album.cover, 320) : artworkURL,
          format:     'flac',
        }));

      const albums = Object.values(albumMap)
        .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
        .slice(0, 60)
        .map(a => ({
          id:         `hifi_album_${instB64}_${a.id}`,
          title:      a.title || 'Unknown Album',
          artist:     artistName,
          artworkURL: a.cover ? coverUrl(a.cover, 320) : undefined,
          year:       safeYear(a.releaseDate),
          source:     'hifi',
        }));

      const result = { id, name: artistName, artworkURL, topTracks, albums };
      await cacheSet(cacheKey, result, 3600);
      return c.json(result);
    } catch (e) {
      console.warn('[HiFi] artist error:', e.message);
      return c.json({ error: 'Artist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('sc_artist_')) {
    const artistName = decodeURIComponent(id.slice(10));
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    try {
      const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: artistName, client_id: cid, limit: 20 }, timeout: 8000,
      });
      const topTracks = (r.data?.collection || []).map(t => ({
        id:        `sc_${t.id}`,
        title:     t.title || 'Unknown',
        artist:    t.user?.username || 'Unknown',
        duration:  Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _origId: String(t.id),
      }));
      return c.json({ id, name: artistName, topTracks, albums: [] });
    } catch (e) {
      return c.json({ error: 'SC artist fetch failed' });
    }
  }

  return c.json({ error: 'Artist not found' });
}
app.get('/artist/:id', handleArtist);
app.get('/:token/artist/:id', handleArtist);

// Playlist detail (podcast series)
async function handlePlaylist(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // SoundCloud playlist
  if (id.startsWith('sc_pl_')) {
    const origId = id.slice(6);
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    const cacheKey = `sc:playlist:${origId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const r = await axios.get(`https://api-v2.soundcloud.com/playlists/${origId}`, {
        params: { client_id: cid },
        timeout: 10000,
      });
      const pl = r.data;
      const tracks = (pl.tracks || []).map(t => ({
        id: `sc_${t.id}`,
        title: t.title || 'Unknown',
        artist: t.user?.username || 'Unknown',
        duration: Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _source: 'sc',
        _origId: String(t.id),
      }));
      const result = {
        id,
        title: pl.title || 'SoundCloud Playlist',
        creator: pl.user?.username || 'Unknown',
        artworkURL: (pl.artwork_url || '').replace('-large', '-t500x500'),
        trackCount: tracks.length,
        tracks,
      };
      await cacheSet(cacheKey, result, 600);
      return c.json(result);
    } catch (e) {
      return c.json({ error: 'SC playlist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('pi_feed_')) {
    const feedId = id.slice(8);
    const cacheKey = `playlist:pi_feed:${feedId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const episodes = await piGetEpisodes(feedId, cfg.piKey, cfg.piSecret);
    // Get series info from cache; re-fetch from PI if cache has expired
    let seriesInfo = await cacheGet(`pi:series_info:${feedId}`);
    if (!seriesInfo && cfg.piKey && cfg.piSecret) {
      try {
        const infoRes = await axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
          params: { id: feedId },
          headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
          timeout: 6000,
        });
        const f = infoRes.data?.feed;
        if (f) {
          seriesInfo = {
            title: f.title || 'Podcast',
            artworkURL: f.artwork || f.image || '',
            creator: f.author || '',
            description: f.description || '',
          };
          await cacheSet(`pi:series_info:${feedId}`, seriesInfo, 3600);
        }
      } catch {}
    }
    if (!seriesInfo) seriesInfo = { title: 'Podcast', artworkURL: '', creator: '', description: '' };
    const playlistData = {
      id,
      title: seriesInfo.title,
      description: seriesInfo.description || '',
      artworkURL: seriesInfo.artworkURL || '',
      creator: seriesInfo.creator || '',
      tracks: episodes,
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }

  if (id.startsWith('taddy_series_')) {
    const uuid = id.slice(13);
    const cacheKey = `playlist:taddy:${uuid}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const [episodes, seriesInfo] = await Promise.all([
      taddyGetEpisodes(uuid, cfg.taddyKey, cfg.taddyUid),
      cacheGet(`taddy:series_info:${uuid}`),
    ]);
    const info = seriesInfo
      || (episodes && episodes[0]
        ? { title: episodes[0].artist || 'Podcast', artworkURL: episodes[0].artworkURL || '', creator: episodes[0].artist || '' }
        : { title: 'Podcast', artworkURL: '', creator: '' });
    const playlistData = {
      id,
      title: info.title || 'Podcast',
      description: '',
      artworkURL: info.artworkURL || '',
      creator: info.creator || '',
      tracks: episodes || [],
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }


  // ── Apple Podcast feed playlist ───────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `playlist:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 6000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] playlist feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) {
        const playlistData = {
          id, title: feedData.title, description: feedData.description || '',
          artworkURL: feedData.artworkURL || '', creator: feedData.artist || '',
          tracks: feedData.tracks,
        };
        await cacheSet(cacheKey, playlistData, 600);
        return c.json(playlistData);
      }
    }
    return c.json({ error: 'Apple Podcast feed not found — no RSS feed URL available' });
  }

  c.json({ error: 'Playlist not found' }, 404);
}

app.get('/playlist/:id', handlePlaylist);
app.get('/:token/playlist/:id', handlePlaylist);

// Health check
app.get('/health', async (c) => {
  const hifiInst = await getWorkingHiFiInstance([]);
  const scId = await getSCClientId(null);
  return c.json({
    status: 'ok',
    cache: null ? 'redis' : 'memory',
    hifi_instance: hifiInst || 'none found',
    sc_client_id: scId ? scId.slice(0, 8) + '...' : 'not discovered',
    timestamp: new Date().toISOString(),
  });
});

// ─── Config / Generator Page ─────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  var h = '';
  h += '<!DOCTYPE html><html lang="en"><head>';
  h += '<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>';
  h += '<title>Eclipse Universal Addon - Link Generator</title>';
  h += '<link rel="preconnect" href="https://fonts.googleapis.com">';
  h += '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
  h += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">';
  h += '<style>';
  h += '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0a0a0c;color:#e4e2f0;font-family:\'Inter\',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.card{background:#111013;border:1px solid #1e1c28;border-radius:18px;padding:32px;max-width:560px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h1{font-size:20px;font-weight:700;margin-bottom:6px;color:#fff}';
  h += 'h2{font-size:15px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:13px;color:#666;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0d0b14;border:1px solid #1e1c28;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}.tip b{color:#ccc}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#3a3850;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0d0b14;border:1px solid #1e1c28;border-radius:10px;color:#e4e2f0;font-size:14px;padding:11px 14px;margin-bottom:6px;outline:none;transition:border-color .15s;font-family:\'Inter\',sans-serif}';
  h += 'input:focus{border-color:#7c6af5}input::placeholder{color:#2a2840}';
  h += '.hint{font-size:12px;color:#333050;margin-bottom:12px;line-height:1.7}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:8px;transition:background .15s;font-family:\'Inter\',sans-serif}';
  h += '.bprimary{background:#7c6af5;color:#fff}.bprimary:hover{background:#9083f8}.bprimary:disabled{background:#1e1c28;color:#333;cursor:not-allowed}';
  h += '.bsecondary{background:#111013;color:#9087b8;border:1px solid #1e1c28}.bsecondary:hover{background:#1a1820;color:#e4e2f0}';
  h += '.bsmall{background:#0d0b14;color:#666;border:1px solid #1a1830;font-size:13px;padding:9px}.bsmall:hover{background:#1a1820;color:#fff}';
  h += '.box{display:none;background:#0a0a0c;border:1px solid #1a1830;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#3a3850;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#a09aff;word-break:break-all;font-family:\'JetBrains Mono\',monospace;margin-bottom:14px;line-height:1.6}';
  h += 'hr{border:none;border-top:1px solid #141220;margin:22px 0}';
  h += '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}';
  h += '@media(max-width:500px){.grid2{grid-template-columns:1fr}}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}';
  h += '.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#141220;border:1px solid #1e1c28;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#7c6af5}';
  h += '.st{font-size:13px;color:#555370;line-height:1.6}.st b{color:#9087b8}';
  h += '.sources{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:6px}';
  h += '.sources th{text-align:left;padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#3a3850;border-bottom:1px solid #141220}';
  h += '.sources td{padding:9px 10px;border-bottom:1px solid #0f0e18;color:#666;vertical-align:top}';
  h += '.sources tr:last-child td{border-bottom:none}';
  h += '.sources td:first-child{color:#c8c4f0;font-weight:600}';
  h += '.pill{display:inline-flex;font-size:10px;padding:2px 8px;border-radius:100px;font-weight:700}';
  h += '.ql-btn{flex:1;background:#0d0b14;border:1px solid #1e1c28;border-radius:10px;padding:11px 8px;text-align:center;cursor:pointer;color:#555370;transition:border-color .15s,color .15s,background .15s;line-height:1.4}';
  h += '.ql-btn:hover{background:#1a1820;color:#9087b8;border-color:#3a3850}';
  h += '.ql-btn.active{background:#1a1433;border-color:#7c6af5;color:#c4bcff}';
  h += '.pg{background:#0d2018;color:#4ade80;border:1px solid #1a3a28}';
  h += '.py{background:#1a1400;color:#fbbf24;border:1px solid #2a2200}';
  h += 'footer{margin-top:32px;font-size:11px;color:#1e1c28;text-align:center;line-height:1.8}';
  h += '</style></head><body>';

  // Logo
  h += '<svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom:20px"><circle cx="24" cy="24" r="24" fill="#7c6af5"/><circle cx="24" cy="24" r="10" stroke="#fff" stroke-width="2.5" fill="none"/><circle cx="24" cy="24" r="3" fill="#fff"/><line x1="24" y1="4" x2="24" y2="14" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="24" y1="34" x2="24" y2="44" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="4" y1="24" x2="14" y2="24" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="34" y1="24" x2="44" y2="24" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>';

  h += '<div class="card">';
  h += '<h1>Eclipse Universal Addon</h1>';
  h += '<p class="sub">HiFi music, SoundCloud, Podcasts, Audiobooks &amp; Live Radio in one Eclipse addon. All keys are optional.</p>';
  h += '<div class="tip"><b>How it works:</b> Your API keys are encoded into your personal URL and read server-side on every request. Nothing is stored.</div>';

  // Sources table
  h += '<div class="lbl">What\'s included</div>';
  h += '<table class="sources"><thead><tr><th>Source</th><th>Content</th><th>Auth</th></tr></thead><tbody>';
  h += '<tr><td>HiFi Instances</td><td>Lossless / high-quality music</td><td><span class="pill py">Your URL(s)</span></td></tr>';
  h += '<tr><td>SoundCloud</td><td>Tracks, artists, playlists</td><td><span class="pill pg">Auto</span></td></tr>';
  h += '<tr><td>Internet Archive</td><td>Music, recordings, audiobooks</td><td><span class="pill pg">Free</span></td></tr>';
  h += '<tr><td>Podcast Index</td><td>Podcasts + episodes</td><td><span class="pill py">Key+Secret</span></td></tr>';
  h += '<tr><td>Taddy</td><td>Podcasts + episodes (fallback)</td><td><span class="pill py">Key+UID</span></td></tr>';
  h += '<tr><td>Apple Podcasts</td><td>Podcasts + episodes (iTunes)</td><td><span class="pill pg">Free</span></td></tr>';
  h += '<tr><td>LibriVox</td><td>Public domain audiobooks</td><td><span class="pill pg">Free</span></td></tr>';
  h += '<tr><td>Radio Browser</td><td>50k+ live radio stations</td><td><span class="pill pg">Free</span></td></tr>';
  h += '</tbody></table>';

  h += '<hr>';

  // Base URL field
  h += '<div class="lbl">Your Vercel Deployment URL <span style="color:#3a3850;font-weight:400">(optional — pre-filled with this deployment)</span></div>';
  h += '<input type="text" id="vercelUrl" value="' + baseUrl + '" placeholder="https://your-addon.vercel.app"/>';
  h += '<div class="hint">Pre-filled with this deployment. Only change if you host on a different URL.</div>';

  // HiFi
  h += '<div class="lbl">HiFi Instance URL(s) <span style="color:#3a3850;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="hifiInst" placeholder="https://hifi.yourdomain.com"/>';
  h += '<div class="hint">Comma-separated. Leave blank to use the built-in public instance pool.</div>';

  // SoundCloud
  h += '<div class="lbl">SoundCloud Client ID <span style="color:#3a3850;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="scId" placeholder="Leave blank for auto-discovery"/>';
  h += '<div class="hint">Auto-discovered from SoundCloud on first use if left blank.</div>';

  h += '<hr>';

  // Podcast Index
  h += '<div class="lbl">Podcast Index <span style="color:#3a3850;font-weight:400;text-transform:none">(optional — podcastindex.org/login)</span></div>';
  h += '<div class="grid2">';
  h += '<div><input type="text" id="piKey" placeholder="API Key"/></div>';
  h += '<div><input type="password" id="piSecret" placeholder="API Secret"/></div>';
  h += '</div>';
  h += '<div class="hint">Without these, podcast search falls back to Taddy only.</div>';

  // Taddy
  h += '<div class="lbl">Taddy <span style="color:#3a3850;font-weight:400;text-transform:none">(optional — taddy.org/developers)</span></div>';
  h += '<div class="grid2">';
  h += '<div><input type="text" id="taddyKey" placeholder="API Key"/></div>';
  h += '<div><input type="text" id="taddyUid" placeholder="User ID"/></div>';
  h += '</div>';
  h += '<div class="hint">Without these, podcast search uses Podcast Index only.</div>';

  h += '<hr>';

  // Audio quality selector
  h += '<div class="lbl">Preferred Audio Quality <span style="color:#3a3850;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<div style="display:flex;gap:10px;margin-bottom:8px">';
  h += '<div class="ql-btn" id="ql-LOSSLESS" onclick="selectQuality(\'LOSSLESS\')"><span style="font-size:13px;font-weight:700">LOSSLESS</span><br><span style="font-size:10px;font-weight:400;opacity:.6">FLAC / HiRes</span></div>';
  h += '<div class="ql-btn" id="ql-HIGH"     onclick="selectQuality(\'HIGH\')"    ><span style="font-size:13px;font-weight:700">HIGH</span><br><span style="font-size:10px;font-weight:400;opacity:.6">AAC 320 kbps</span></div>';
  h += '<div class="ql-btn" id="ql-LOW"      onclick="selectQuality(\'LOW\')"     ><span style="font-size:13px;font-weight:700">LOW</span><br><span style="font-size:10px;font-weight:400;opacity:.6">AAC 128 kbps</span></div>';
  h += '</div>';
  h += '<div class="hint" id="qlHint">No preference &mdash; addon tries LOSSLESS &rarr; HIGH &rarr; LOW automatically.</div>';

  h += '<hr>';

  // Generate button
  h += '<button class="bprimary" id="genBtn" onclick="doGenerate()">Generate My Addon URL</button>';

  // Output box — all 3 manifest URLs
  h += '<div class="box" id="genBox">';
  h += '<div class="blbl">🎵 Music &mdash; paste into Eclipse for the standard player</div>';
  h += '<div class="burl" id="genManifest"></div>';
  h += '<button class="bsmall" id="copyManifest" onclick="copyIt(\'manifest\')">Copy</button>';
  h += '<div class="blbl" style="margin-top:12px">🎤 Podcasts &mdash; install separately for podcast player (±15s skip, speed control)</div>';
  h += '<div class="burl" id="genPodcast"></div>';
  h += '<button class="bsmall" id="copyPodcast" onclick="copyIt(\'podcast\')">Copy</button>';
  h += '<div class="blbl" style="margin-top:12px">📚 Audiobooks &mdash; install separately for audiobook player (±30s skip, speed control)</div>';
  h += '<div class="burl" id="genAudiobook"></div>';
  h += '<button class="bsmall" id="copyAudiobook" onclick="copyIt(\'audiobook\')">Copy</button>';
  h += '</div>';

  h += '<hr>';

  // Refresh existing
  h += '<div class="lbl">Already have a URL? Refresh it</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL"/>';
  h += '<button class="bsecondary" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
  h += '<div class="box" id="refBox">';
  h += '<div class="blbl">Refreshed Manifest URL</div>';
  h += '<div class="burl" id="refManifest"></div>';
  h += '<button class="bsmall" id="copyRef" onclick="copyIt(\'ref\')">Copy</button>';
  h += '</div>';

  h += '<hr>';

  // Steps
  h += '<div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Enter your Vercel URL and any optional API keys above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Click <b>Generate</b> and copy your Manifest URL</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Paste your Manifest URL and tap <b>Install</b></div></div>';
  h += '</div>';
  h += '</div>'; // .card

  h += '<footer>Eclipse Universal Addon &bull; Keys encoded in URL &bull; Never stored server-side</footer>';

  // Script — all fetch-based, identical pattern to Claudochrome
  h += '<script>';
  h += 'var _manifest="",_base="",_podcast="",_audiobook="",_ref="",_selQ="";';
  h += 'function selectQuality(q){';
  h += '  if(_selQ===q){_selQ="";["LOSSLESS","HIGH","LOW"].forEach(function(k){var el=document.getElementById("ql-"+k);if(el)el.classList.remove("active");});';
  h += '  document.getElementById("qlHint").textContent="No preference \u2014 addon tries LOSSLESS \u2192 HIGH \u2192 LOW automatically.";return;}';
  h += '  _selQ=q;["LOSSLESS","HIGH","LOW"].forEach(function(k){var el=document.getElementById("ql-"+k);if(el)el.classList.toggle("active",k===q);});';
  h += '  var labels={LOSSLESS:"LOSSLESS selected \u2014 always tries FLAC/HiRes first",HIGH:"HIGH selected \u2014 always tries AAC 320 kbps first",LOW:"LOW selected \u2014 always tries AAC 128 kbps first"};';
  h += '  document.getElementById("qlHint").textContent=labels[q];';
  h += '}';

  h += 'function doGenerate(){';
  h += '  var btn=document.getElementById("genBtn");';
  h += '  var vercel=document.getElementById("vercelUrl").value.trim().replace(/\\/+$/,"");';
  h += '  if(!vercel)vercel=window.location.origin;';
  h += '  if(vercel.indexOf("http")!==0)vercel="https://"+vercel;';
  h += '  btn.disabled=true;btn.textContent="Generating...";';
  h += '  var body={';
  h += '    vercelUrl:vercel,';
  h += '    hifi:document.getElementById("hifiInst").value.trim(),';
  h += '    sc:document.getElementById("scId").value.trim(),';
  h += '    pi_key:document.getElementById("piKey").value.trim(),';
  h += '    pi_secret:document.getElementById("piSecret").value.trim(),';
  h += '    taddy_key:document.getElementById("taddyKey").value.trim(),';
  h += '    taddy_uid:document.getElementById("taddyUid").value.trim(),';
  h += '    q:_selQ';
  h += '  };';
  h += '  fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})';
  h += '    .then(function(r){return r.json();})';
  h += '    .then(function(d){';
  h += '      btn.disabled=false;btn.textContent="Regenerate URL";';
  h += '      if(d.error){alert("Error: "+d.error);return;}';
  h += '      _manifest=d.manifestUrl;_base=d.baseUrl;_podcast=d.podcastManifestUrl;_audiobook=d.audiobookManifestUrl;';
  h += '      document.getElementById("genManifest").textContent=d.manifestUrl;';
  h += '      document.getElementById("genPodcast").textContent=d.podcastManifestUrl||"";';
  h += '      document.getElementById("genAudiobook").textContent=d.audiobookManifestUrl||"";';
  h += '      document.getElementById("genBox").style.display="block";';
  h += '      document.getElementById("genBox").scrollIntoView({behavior:"smooth",block:"nearest"});';
  h += '    })';
  h += '    .catch(function(e){btn.disabled=false;btn.textContent="Generate My Addon URL";alert("Failed: "+e.message);});';
  h += '}';

  h += 'function doRefresh(){';
  h += '  var btn=document.getElementById("refBtn");';
  h += '  var eu=document.getElementById("existingUrl").value.trim();';
  h += '  if(!eu){alert("Paste your existing addon URL first.");return;}';
  h += '  btn.disabled=true;btn.textContent="Refreshing...";';
  h += '  fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})})';
  h += '    .then(function(r){return r.json();})';
  h += '    .then(function(d){';
  h += '      btn.disabled=false;btn.textContent="Refresh Existing URL";';
  h += '      if(d.error){alert("Error: "+d.error);return;}';
  h += '      _ref=d.manifestUrl;';
  h += '      document.getElementById("refManifest").textContent=d.manifestUrl;';
  h += '      document.getElementById("refBox").style.display="block";';
  h += '    })';
  h += '    .catch(function(e){btn.disabled=false;btn.textContent="Refresh Existing URL";alert("Failed: "+e.message);});';
  h += '}';

  h += 'function copyIt(which){';
  h += '  var url=which==="manifest"?_manifest:which==="base"?_base:which==="podcast"?_podcast:which==="audiobook"?_audiobook:_ref;';
  h += '  var bid=which==="manifest"?"copyManifest":which==="base"?"copyBase":which==="podcast"?"copyPodcast":which==="audiobook"?"copyAudiobook":"copyRef";';
  h += '  if(!url)return;';
  h += '  navigator.clipboard.writeText(url).then(function(){';
  h += '    var b=document.getElementById(bid);';
  h += '    var orig=b.textContent;b.textContent="Copied!";';
  h += '    setTimeout(function(){b.textContent=orig;},1800);';
  h += '  });';
  h += '}';

  h += '<\/script></body></html>';
  return h;
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function getBaseUrl(c) {
  return (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
}

// ─── POST /generate — server-side token builder ───────────────────────────────
app.post('/generate', async function(c) {
  var b = await c.req.json().catch(() => ({}));
  var vercel = (b.vercelUrl || '').trim().replace(/\/+$/, '');
  if (!vercel) {
    var proto = c.req.header('x-forwarded-proto') || 'https';
    vercel = proto + '://' + c.req.header('host');
  }
  if (!/^https?:\/\/.+/.test(vercel))
    return c.json({ error: 'Vercel URL must start with http:// or https://' });

  var VALID_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  var cfg = {};
  if (b.hifi)      cfg.hifi      = b.hifi;
  if (b.sc)        cfg.sc        = b.sc;
  if (b.pi_key)    cfg.pi_key    = b.pi_key;
  if (b.pi_secret) cfg.pi_secret = b.pi_secret;
  if (b.taddy_key) cfg.taddy_key = b.taddy_key;
  if (b.taddy_uid) cfg.taddy_uid = b.taddy_uid;
  if (b.q && VALID_QUALITIES.includes(b.q)) cfg.q = b.q;

  // Always generate a tokenized URL, even when no optional keys are set.
  // This keeps podcast/audiobook installs on the token-prefixed route shape:
  //   /{token}/podcast/manifest.json
  //   /{token}/audiobook/manifest.json
  // and avoids the bare /podcast/manifest.json path the user reported as unreliable.
  var token = encodeBase64Url(JSON.stringify(cfg));
  if (!token) token = 'e30';

  return c.json({
    manifestUrl:          vercel + '/' + token + '/manifest.json',
    podcastManifestUrl:   vercel + '/' + token + '/podcast/manifest.json',
    audiobookManifestUrl: vercel + '/' + token + '/audiobook/manifest.json',
    baseUrl:              vercel + '/' + token,
  });
});

// ─── POST /refresh ────────────────────────────────────────────────────────────
app.post('/refresh', async function(c) {
  var rb = await c.req.json().catch(() => ({}));
  var raw = (rb && rb.existingUrl) ? String(rb.existingUrl).trim() : '';
  if (!raw) return c.json({ error: 'Paste your full addon URL.' });
  // Extract base (strip /manifest.json or /{token}/manifest.json)
  var clean = raw.replace(/\/manifest\.json$/, '');
  // Validate it looks like a URL
  if (!/^https?:\/\/.+/.test(clean)) return c.json({ error: 'Invalid URL.' });
  return c.json({ manifestUrl: clean + '/manifest.json', refreshed: true });
});

// ─── GET / and /generator — serve config page ─────────────────────────────────
app.get('/', async function(c) {
  return c.html(buildConfigPage(getBaseUrl(c)));
});

app.get('/generator', async function(c) {
  return c.html(buildConfigPage(getBaseUrl(c)));
});

// ─── 8SPINE Module Endpoints ──────────────────────────────────────────────────
const SPINE_MODULE_CODE = "var BASE_URL = 'https://all-in-one-seven-psi.vercel.app';\nvar RB_BASE = 'https://de1.api.radio-browser.info';\n\n// ─── Helpers ──────────────────────────────────────────────────────────────────\n\nfunction eclipseFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(BASE_URL + path + qs, { headers: { 'Accept': 'application/json' } })\n    .then(function(r) {\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    });\n}\n\nfunction rbFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(RB_BASE + path + qs, {\n    headers: { 'Accept': 'application/json', 'User-Agent': 'EclipseAllInOne/1.0' }\n  }).then(function(r) {\n    if (!r.ok) throw new Error('HTTP ' + r.status);\n    return r.json();\n  });\n}\n\nfunction fetchDirect(url) {\n  return fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Monochrome/1.0' } })\n    .then(function(r) {\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    });\n}\n\nfunction base64Decode(str) {\n  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');\n  while (s.length % 4) { s += '='; }\n  return atob(s);\n}\n\nfunction extractManifestUrl(manifest) {\n  if (!manifest) return null;\n  try {\n    if (typeof manifest === 'string' && manifest.indexOf('http') === 0) return manifest;\n    var decoded = atob(manifest);\n    var parsed = JSON.parse(decoded);\n    if (parsed.urls && parsed.urls.length > 0) return parsed.urls[0];\n  } catch (e) {}\n  return null;\n}\n\nfunction cleanText(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }\nfunction safeUrl(u) { return /^https?:\\/\\//i.test(String(u || '')) ? String(u) : null; }\nfunction normalizeQ(s) { return cleanText(s).toLowerCase().replace(/[^a-z0-9 ]/g, ''); }\n\nfunction parseHifiId(id) {\n  if (String(id).indexOf('hifi_') !== 0) return null;\n  var rest = String(id).slice(5);\n  var idx = rest.indexOf('_');\n  if (idx === -1) return null;\n  return { instB64: rest.slice(0, idx), origId: rest.slice(idx + 1) };\n}\n\nfunction qualityFallbacks(q) {\n  if (q === 'LOSSLESS') return ['HIGH', 'LOW'];\n  if (q === 'HIGH') return ['LOSSLESS', 'LOW'];\n  return ['HIGH', 'LOSSLESS'];\n}\n\n// ─── Radio Browser helpers ────────────────────────────────────────────────────\n\nfunction stationArtwork(station) {\n  return safeUrl(station.favicon) || 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png';\n}\n\nfunction stationSubtitle(station) {\n  var bits = [];\n  if (station.country) bits.push(cleanText(station.country));\n  if (station.language) bits.push(cleanText(station.language));\n  if (station.codec) bits.push(cleanText(station.codec));\n  if (station.bitrate) bits.push(station.bitrate + 'k');\n  return bits.join(' \\u2022 ');\n}\n\nfunction detectFormat(url, hls) {\n  var u = String(url || '').toLowerCase().split('?')[0];\n  if (hls === 1 || u.indexOf('.m3u8') >= 0) return 'hls';\n  if (u.indexOf('.aac') >= 0 || u.indexOf('.aacp') >= 0) return 'aac';\n  if (u.indexOf('.ogg') >= 0 || u.indexOf('.opus') >= 0) return 'ogg';\n  if (u.indexOf('.flac') >= 0) return 'flac';\n  return 'mp3';\n}\n\nfunction mapStation(station) {\n  var stream = safeUrl(station.url_resolved || station.urlresolved || station.url);\n  return {\n    id: 'rbst_' + station.stationuuid,\n    title: cleanText(station.name) || 'Radio Station',\n    artist: stationSubtitle(station) || 'Radio Browser',\n    album: cleanText(station.tags || station.country || 'Live Radio'),\n    albumCover: stationArtwork(station),\n    duration: 0,\n    audioQuality: 'HIGH',\n    streamUrl: stream\n  };\n}\n\nfunction isRadioId(id) { return String(id).indexOf('rbst_') === 0; }\n\n// ─── Improved radio scoring ───────────────────────────────────────────────────\n\nfunction scoreStation(station, q) {\n  var needle = normalizeQ(q);\n  var name = normalizeQ(station.name);\n  var tags = normalizeQ(station.tags || '');\n  var country = normalizeQ(station.country || '');\n  var language = normalizeQ(station.language || '');\n  var score = 0;\n\n  if (name === needle) score += 500;\n  else if (name.indexOf(needle) === 0) score += 350;\n  else if (new RegExp('\\\\b' + needle.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '\\\\b').test(name)) score += 250;\n  else if (name.indexOf(needle) >= 0) score += 150;\n\n  if (tags.indexOf(needle) >= 0) score += 60;\n  if (country.indexOf(needle) >= 0) score += 40;\n  if (language.indexOf(needle) >= 0) score += 20;\n\n  if (station.lastcheckok === 1) score += 80;\n  score += Math.min(parseInt(station.clickcount || 0, 10), 60);\n  score += Math.min(parseInt(station.votes || 0, 10), 40);\n  if (parseInt(station.bitrate || 0, 10) >= 128) score += 20;\n\n  if (!safeUrl(station.url_resolved || station.urlresolved || station.url)) score -= 500;\n\n  return score;\n}\n\nfunction dedupeStations(list) {\n  var seen = {};\n  var out = [];\n  for (var i = 0; i < list.length; i++) {\n    var uuid = list[i].stationuuid;\n    if (!seen[uuid]) { seen[uuid] = true; out.push(list[i]); }\n  }\n  return out;\n}\n\n// ─── Eclipse track normaliser ─────────────────────────────────────────────────\n\nfunction normaliseTrack(t) {\n  var rawId = String(t.id || t._origId || '');\n  var directUrl = t.streamURL || t.stream_url || t.url || '';\n  var isDirectOnly = (\n    rawId.indexOf('radio_') === 0 ||\n    rawId.indexOf('pi_ep_') === 0 ||\n    rawId.indexOf('taddy_ep_') === 0 ||\n    rawId.indexOf('apple_ep_') === 0 ||\n    rawId.indexOf('lvox_ch_') === 0 ||\n    rawId.indexOf('ia_book_file_') === 0\n  );\n  var id = (isDirectOnly && directUrl) ? ('direct__' + encodeURIComponent(directUrl)) : rawId;\n  return {\n    id: id,\n    title: t.title || t.name || 'Unknown Title',\n    artist: t.artist || t.creator || (t.user && t.user.username) || 'Unknown Artist',\n    album: t.album || t.albumTitle || '',\n    albumCover: t.artworkURL || t.artwork_url || t.cover || '',\n    duration: typeof t.duration === 'number' ? t.duration : 0,\n    audioQuality: (rawId.indexOf('hifi_') === 0) ? 'LOSSLESS' : 'HIGH',\n    availableQualities: ['LOSSLESS', 'HIGH', 'LOW']\n  };\n}\n\nfunction resolveHifiDirect(trackId, quality) {\n  var parsed = parseHifiId(trackId);\n  if (!parsed) return Promise.reject(new Error('Invalid HiFi ID'));\n  var inst = base64Decode(parsed.instB64);\n  var url = inst + '/track/?id=' + encodeURIComponent(parsed.origId) + '&quality=' + encodeURIComponent(quality);\n  return fetchDirect(url).then(function(data) {\n    var payload = data.data || data || {};\n    var streamUrl = extractManifestUrl(payload.manifest) || payload.url || null;\n    if (!streamUrl) throw new Error('No stream URL from HiFi');\n    return {\n      streamUrl: streamUrl,\n      track: {\n        id: payload.trackId || trackId,\n        audioQuality: payload.audioQuality || quality,\n        bitDepth: payload.bitDepth,\n        sampleRate: payload.sampleRate\n      }\n    };\n  });\n}\n\n// ─── searchTracks ─────────────────────────────────────────────────────────────\n// FIX: use /resolve for single-track lookups (playlist import context) —\n// /resolve skips podcast/radio/audiobook sources and is 5-8x faster.\n// Use /search only for open-ended user searches (no context or context.type !== 'resolve').\n\nfunction searchTracks(query, limit, context) {\n  var lim = limit || 25;\n  var isResolve = context && (context.type === 'resolve' || context.playlistImport === true);\n\n  // Playlist import / resolve context: use the lightweight /resolve endpoint\n  var eclipsePromise = eclipseFetch(isResolve ? '/resolve' : '/search', { q: query })\n    .then(function(data) {\n      return (data.tracks || []).slice(0, lim).map(normaliseTrack);\n    }).catch(function() { return []; });\n\n  // Skip radio search entirely for playlist import — not useful there\n  if (isResolve) {\n    return eclipsePromise.then(function(tracks) {\n      return { tracks: tracks, total: tracks.length };\n    });\n  }\n\n  // Full search: radio + eclipse in parallel\n  var p1 = rbFetch('/json/stations/search', {\n    name: query, limit: 40, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p2 = rbFetch('/json/stations/byname/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p3 = rbFetch('/json/stations/bytag/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var radioPromise = Promise.all([p1, p2, p3]).then(function(results) {\n    var raw = (Array.isArray(results[0]) ? results[0] : [])\n      .concat(Array.isArray(results[1]) ? results[1] : [])\n      .concat(Array.isArray(results[2]) ? results[2] : []);\n\n    return dedupeStations(raw)\n      .filter(function(s) {\n        return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1;\n      })\n      .sort(function(a, b) { return scoreStation(b, query) - scoreStation(a, query); })\n      .slice(0, 15)\n      .map(mapStation);\n  }).catch(function() { return []; });\n\n  return Promise.all([eclipsePromise, radioPromise]).then(function(results) {\n    var combined = results[0].concat(results[1]);\n    return { tracks: combined, total: combined.length };\n  });\n}\n\n// ─── getTrackStreamUrl ────────────────────────────────────────────────────────\n// FIX: for social/unknown IDs, pass ?title=&artist= so the server's social\n// fallback block can search by song name instead of the raw foreign ID string.\n\nfunction getTrackStreamUrl(trackId, preferredQuality, context) {\n  var id = String(trackId);\n  var settings = (context && context.settings) || {};\n  var targetQuality = (settings.quality && settings.quality.value) || preferredQuality || 'LOSSLESS';\n  var fallbackMode = (settings.fallbackMode && settings.fallbackMode.value) || 'flexible';\n\n  // Radio station — direct stream URL from Radio Browser\n  if (isRadioId(id)) {\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      var url = safeUrl(station.url_resolved || station.urlresolved || station.url);\n      if (!url) throw new Error('No stream URL for station');\n      rbFetch('/json/url/' + encodeURIComponent(station.stationuuid), {}).catch(function() {});\n      return {\n        streamUrl: url,\n        track: { id: trackId, audioQuality: 'HIGH', format: detectFormat(url, station.hls) }\n      };\n    });\n  }\n\n  // Direct stream URL (podcasts, audiobook chapters, etc.)\n  if (id.indexOf('direct__') === 0) {\n    var streamUrl = decodeURIComponent(id.slice(8));\n    return Promise.resolve({\n      streamUrl: streamUrl,\n      track: { id: trackId, audioQuality: 'HIGH' }\n    });\n  }\n\n  // HiFi track — try direct instance first, then fall back to server /stream/\n  if (id.indexOf('hifi_') === 0) {\n    var qualitiesToTry = [targetQuality];\n    if (fallbackMode !== 'strict') {\n      var fallbacks = qualityFallbacks(targetQuality);\n      for (var i = 0; i < fallbacks.length; i++) { qualitiesToTry.push(fallbacks[i]); }\n    }\n    function tryQuality(index) {\n      if (index >= qualitiesToTry.length) {\n        return eclipseFetch('/stream/' + encodeURIComponent(id), { quality: targetQuality })\n          .then(function(data) {\n            var url = data.url || data.streamURL || data.stream_url || null;\n            if (!url) throw new Error('No stream URL');\n            return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || targetQuality } };\n          });\n      }\n      return resolveHifiDirect(id, qualitiesToTry[index])\n        .catch(function() { return tryQuality(index + 1); });\n    }\n    return tryQuality(0);\n  }\n\n  // Known non-hifi prefixes that have a proper /stream/ handler — call directly\n  var knownPrefixes = ['sc_', 'ia_music_', 'ia_book_', 'apple_ep_', 'pi_ep_', 'taddy_ep_', 'lvox_'];\n  var isKnown = false;\n  for (var k = 0; k < knownPrefixes.length; k++) {\n    if (id.indexOf(knownPrefixes[k]) === 0) { isKnown = true; break; }\n  }\n  if (isKnown) {\n    return eclipseFetch('/stream/' + encodeURIComponent(id))\n      .then(function(data) {\n        var url = data.url || data.streamURL || data.stream_url || null;\n        if (!url) throw new Error('No stream URL');\n        return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n      });\n  }\n\n  // ── Social / Cross-Addon fallback ─────────────────────────────────────────\n  // Unknown ID prefix = Social tab, Tidal app, Apple Music, Deezer, Spotify, etc.\n  // Pass title+artist from context so the server can search by song name.\n  // context.track is populated by Eclipse when playing from Social/Library tabs.\n  var socialTitle  = (context && context.track && context.track.title)  ? String(context.track.title).trim()  : '';\n  var socialArtist = (context && context.track && context.track.artist) ? String(context.track.artist).trim() : '';\n\n  var socialParams = { quality: targetQuality };\n  if (socialTitle)  socialParams.title  = socialTitle;\n  if (socialArtist) socialParams.artist = socialArtist;\n\n  return eclipseFetch('/stream/' + encodeURIComponent(id), socialParams)\n    .then(function(data) {\n      var url = data.url || data.streamURL || data.stream_url || null;\n      if (!url) throw new Error('No stream URL');\n      return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n    });\n}\n\n// ─── getAlbum ─────────────────────────────────────────────────────────────────\n\nfunction getAlbum(albumId) {\n  var id = String(albumId);\n  if (isRadioId(id)) {\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      return {\n        album: {\n          id: id,\n          title: cleanText(station.name) || 'Radio Station',\n          artist: cleanText(station.country || station.language || 'Radio Browser'),\n          albumCover: stationArtwork(station),\n          year: 0,\n          description: stationSubtitle(station),\n          trackCount: 1\n        },\n        tracks: [mapStation(station)]\n      };\n    });\n  }\n  return eclipseFetch('/album/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      album: {\n        id: data.id || id,\n        title: data.title || 'Unknown Album',\n        artist: data.artist || data.creator || '',\n        albumCover: data.artworkURL || data.artwork || '',\n        year: safeYear(data.year),\n        description: data.description || '',\n        trackCount: data.trackCount || (data.tracks ? data.tracks.length : 0)\n      },\n      tracks: (data.tracks || []).map(normaliseTrack)\n    };\n  });\n}\n\n// ─── getArtist ────────────────────────────────────────────────────────────────\n\nfunction getArtist(artistId) {\n  var id = String(artistId);\n  if (id.indexOf('rbartist_') === 0) {\n    var country = decodeURIComponent(id.slice(9));\n    return rbFetch('/json/stations/bycountryexact/' + encodeURIComponent(country), {\n      hidebroken: true, order: 'clickcount', reverse: true, limit: 30\n    }).then(function(rows) {\n      var stations = Array.isArray(rows)\n        ? rows.filter(function(s) { return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1; })\n        : [];\n      return {\n        artist: { id: id, name: country, artworkURL: stations[0] ? stationArtwork(stations[0]) : null },\n        topTracks: stations.slice(0, 8).map(mapStation),\n        albums: stations.slice(0, 12).map(function(s) {\n          return { id: 'rbst_' + s.stationuuid, title: cleanText(s.name), artist: country, albumCover: stationArtwork(s), year: 0 };\n        })\n      };\n    });\n  }\n  return eclipseFetch('/artist/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      artist: { id: data.id || id, name: data.name || 'Unknown Artist', artworkURL: data.artworkURL || data.picture || '' },\n      topTracks: (data.topTracks || []).map(normaliseTrack),\n      albums: (data.albums || []).map(function(a) {\n        return { id: String(a.id || ''), title: a.title || 'Unknown Album', artist: a.artist || data.name || '', albumCover: a.artworkURL || a.cover || '', year: safeYear(a.year) };\n      })\n    };\n  });\n}\n\n// ─── Module export ────────────────────────────────────────────────────────────\n\nreturn {\n  id: 'ricky-all-in-one',\n  name: 'All-In-One',\n  author: 'Ricky',\n  version: '1.0.6',\n  description: 'HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',\n  labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],\n  settings: {\n    quality: {\n      type: 'selector',\n      label: 'Audio Quality',\n      description: 'Select preferred streaming quality for HiFi tracks',\n      options: [\n        { label: '128kbps',         value: 'LOW'      },\n        { label: '320kbps',         value: 'HIGH'     },\n        { label: 'Lossless (FLAC)', value: 'LOSSLESS' }\n      ],\n      defaultValue: 'LOSSLESS'\n    },\n    fallbackMode: {\n      type: 'selector',\n      label: 'Quality Fallback',\n      description: 'Allow fallback to other qualities if preferred is unavailable',\n      options: [\n        { label: 'Flexible', value: 'flexible' },\n        { label: 'Strict',   value: 'strict'   }\n      ],\n      defaultValue: 'flexible'\n    }\n  },\n  searchTracks: searchTracks,\n  getTrackStreamUrl: getTrackStreamUrl,\n  getAlbum: getAlbum,\n  getArtist: getArtist\n};\n";

app.get('/8spine', async function(c) {
  var base = getBaseUrl(c);
  return c.json({
    id: 'ricky-all-in-one',
    name: 'All-In-One',
    author: 'Ricky',
    version: '1.0.6',
    description: 'HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
    download: base + '/8spine.js'
  });
});

app.get('/8spine.js', async function(c) {
  return c.html(SPINE_MODULE_CODE);
});

app.get('/8spine-source.json', async function(c) {
  var base = getBaseUrl(c);
  return c.json({
    'category:music': [
      {
        id: 'ricky-all-in-one',
        name: 'All-In-One',
        author: 'Ricky',
        version: '1.0.6',
        description: 'HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
        labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],
        download: base + '/8spine.js'
      }
    ]
  });
});

// ─── Catch-all token info ─────────────────────────────────────────────────────
app.get('/:token', function(c) {
  var t = c.req.param('token');
  if (['health','favicon.ico','generate','refresh','search','stream','album','playlist','manifest.json'].includes(t)) return next();
  return c.json({ name: 'Eclipse Universal Addon', version: '1.3.0', token: t, status: 'running' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

export default app;
