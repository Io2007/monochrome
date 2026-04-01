const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const HIFI_INSTANCES = [
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://hifi-one.spotisaver.net',
  'https://monochrome-api.samidy.com'
];
let activeInstance  = HIFI_INSTANCES[0];
let instanceHealthy = false;
const COUNTRY = process.env.TIDAL_COUNTRY || 'US';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function coverUrl(uuid, size) {
  if (!uuid) return undefined;
  var s = String(uuid);
  if (s.startsWith('http')) return s;
  size = size || 320;
  return 'https://resources.tidal.com/images/' + s.replace(/-/g, '/') + '/' + size + 'x' + size + '.jpg';
}
function trackArtist(t) {
  if (!t) return 'Unknown';
  if (t.artists && t.artists.length) return t.artists.map(function(a){ return a.name; }).join(', ');
  if (t.artist  && t.artist.name)    return t.artist.name;
  return 'Unknown';
}
function decodeManifest(manifest) {
  try {
    var d = JSON.parse(Buffer.from(manifest, 'base64').toString('utf8'));
    return { url: (d.urls && d.urls[0]) || null, codec: d.codecs || d.mimeType || '' };
  } catch (e) { return null; }
}
function isPlaylistUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

// ─── Hi-Fi API client ─────────────────────────────────────────────────────────
async function hifiGet(path, params) {
  var errors = [];
  var instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(function(i){ return i !== activeInstance; }))
    : HIFI_INSTANCES.slice();
  for (var inst of instances) {
    try {
      var r = await axios.get(inst + path, {
        params:  params || {},
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 15000
      });
      if (r.status === 200 && r.data) {
        if (inst !== activeInstance) { activeInstance = inst; instanceHealthy = true; console.log('[hifi] switched to ' + inst); }
        return r.data;
      }
    } catch (e) { errors.push(inst + ': ' + e.message); }
  }
  throw new Error('All Hi-Fi instances failed: ' + errors.slice(-2).join(' | '));
}

// Health check uses /search/?s= — lightweight ping all instances respond to
async function checkInstances() {
  for (var inst of HIFI_INSTANCES) {
    try {
      await axios.get(inst + '/search/', {
        params: { s: 'test', limit: 1 },
        headers: { 'User-Agent': UA }, timeout: 8000
      });
      activeInstance = inst; instanceHealthy = true; console.log('[hifi] healthy: ' + inst); return;
    } catch (e) {}
  }
  instanceHealthy = false; console.warn('[hifi] WARNING: no healthy instances.');
}
checkInstances();
setInterval(checkInstances, 15 * 60 * 1000);

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', function(){ console.log('[Redis] connected'); });
  redis.on('error',   function(e){ console.error('[Redis] ' + e.message); });
}
async function redisSave(token, entry) {
  if (!redis) return;
  try { await redis.set('mc:token:' + token, JSON.stringify({ createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount })); } catch (e) {}
}
async function redisLoad(token) {
  if (!redis) return null;
  try { var d = await redis.get('mc:token:' + token); return d ? JSON.parse(d) : null; } catch (e) { return null; }
}

// ─── Token auth ───────────────────────────────────────────────────────────────
const TOKEN_CACHE = new Map(), IP_CREATES = new Map();
const MAX_TOKENS_PER_IP = 10, RATE_MAX = 80, RATE_WINDOW_MS = 60000;
function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function getOrCreateIpBucket(ip) {
  var now = Date.now(), b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}
async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, rateWin: [] };
  TOKEN_CACHE.set(token, entry); return entry;
}
function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t){ return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1; return true;
}
async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry)                 return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}
function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  var h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Claudochrome - TIDAL Addon</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}.tip b{color:#ccc}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}';
  h += '.pill.hi{background:#0d1520;color:#4a9eff;border-color:#1a3050}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
  h += 'input:focus{border-color:#fff}input::placeholder{color:#2e2e2e}';
  h += '.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bw{background:#fff;color:#000}.bw:hover{background:#e0e0e0}.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}';
  h += '.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}.bg:hover{background:#1e1e1e}.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}';
  h += '.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}.bd:hover{background:#1a1a1a;color:#fff}';
  h += '.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#fff;word-break:break-all;font-family:"SF Mono","Fira Code",monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #161616;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}';
  h += '.st{font-size:13px;color:#555;line-height:1.6}.st b{color:#999}';
  h += '.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}';
  h += '.inst-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}';
  h += '.inst{display:flex;align-items:center;gap:8px;font-size:12px;padding:8px 12px;background:#0a0a0a;border:1px solid #161616;border-radius:8px}';
  h += '.dot{width:7px;height:7px;border-radius:50%;background:#333;flex-shrink:0}.dot.ok{background:#4a9a4a}.dot.err{background:#c04040}';
  h += '.inst-url{flex:1;color:#666;font-family:"SF Mono","Fira Code",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
  h += '.inst-ms{color:#444;margin-left:auto;font-size:11px}';
  h += 'footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}</style></head><body>';
  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px"><circle cx="26" cy="26" r="26" fill="#fff"/><rect x="10" y="20" width="4" height="12" rx="2" fill="#000"/><rect x="17" y="14" width="4" height="24" rx="2" fill="#000"/><rect x="24" y="18" width="4" height="16" rx="2" fill="#000"/><rect x="31" y="11" width="4" height="30" rx="2" fill="#000"/><rect x="38" y="17" width="4" height="18" rx="2" fill="#000"/></svg>';
  h += '<div class="card"><h1>Claudochrome for Eclipse</h1>';
  h += '<p class="sub">Full TIDAL catalog — lossless FLAC, HiRes, AAC 320 — no account, no subscription.</p>';
  h += '<div class="tip"><b>Save your URL.</b> Paste it below to refresh without reinstalling.</div>';
  h += '<div class="pills"><span class="pill">Tracks &middot; Albums &middot; Artists &middot; Playlists</span><span class="pill hi">FLAC / HiRes</span><span class="pill hi">AAC 320</span></div>';
  h += '<button class="bw" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL &mdash; paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';
  h += '<hr><div class="lbl">Refresh existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<div class="hint">Keeps the same URL active &mdash; nothing to reinstall.</div>';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Refreshed &mdash; same URL still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap Install</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Search TIDAL\'s full catalog &mdash; FLAC quality auto-selected</div></div>';
  h += '</div><div class="warn">Hi-Fi instances are community-hosted. The addon auto-discovers working instances and fails over automatically.</div></div>';
  h += '<div class="card"><h2>Instance Health</h2>';
  h += '<p class="sub" style="margin-bottom:14px">Live status of all Hi-Fi API v2.7 instances.</p>';
  h += '<div class="inst-list" id="instList"><div style="color:#333;font-size:13px">Checking...</div></div>';
  h += '<button class="bg" style="margin-top:14px" onclick="checkHealth()">Refresh Status</button></div>';
  h += '<footer>Claudochrome Eclipse Addon v2.1.1 &bull; Hi-Fi API v2.7</footer>';
  h += '<script>var _gu="",_ru="";';
  h += 'function generate(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyGen(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function doRefresh(){var btn=document.getElementById("refBtn");var eu=document.getElementById("existingUrl").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";';
  h += 'fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}';
  h += '_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";btn.disabled=false;btn.textContent="Refresh Again";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});}';
  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function checkHealth(){var list=document.getElementById("instList");list.innerHTML="<div style=\\"color:#333;font-size:13px\\">Checking...</div>";';
  h += 'fetch("/instances").then(function(r){return r.json();}).then(function(data){list.innerHTML="";(data.instances||[]).forEach(function(inst){var row=document.createElement("div");row.className="inst";var dot=document.createElement("span");dot.className=inst.ok?"dot ok":"dot err";var urlSpan=document.createElement("span");urlSpan.className="inst-url";urlSpan.textContent=inst.url;row.appendChild(dot);row.appendChild(urlSpan);if(inst.ok){var ms=document.createElement("span");ms.className="inst-ms";ms.textContent=inst.ms+"ms";row.appendChild(ms);}list.appendChild(row);});}).catch(function(){list.innerHTML="<div style=\\"color:#c04040;font-size:13px\\">Could not reach server</div>";});}';
  h += 'checkHealth();<\/script></body></html>';
  return h;
}

// ─── Public routes ─────────────────────────────────────────────────────────────
app.get('/', function(req, res) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(buildConfigPage(getBaseUrl(req))); });

app.post('/generate', async function(req, res) {
  var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  var bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens from this IP today.' });
  var token = generateToken();
  var entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry); await redisSave(token, entry); bucket.count++;
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function(req, res) {
  var raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  var token = raw, m = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) return res.status(400).json({ error: 'Paste your full addon URL.' });
  var entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/instances', async function(_req, res) {
  var results = await Promise.all(HIFI_INSTANCES.map(async function(inst) {
    var start = Date.now();
    try {
      await axios.get(inst + '/search/', {
        params: { s: 'test', limit: 1 },
        headers: { 'User-Agent': UA }, timeout: 6000
      });
      return { url: inst, ok: true, ms: Date.now() - start };
    } catch (e) { return { url: inst, ok: false, ms: null }; }
  }));
  res.json({ instances: results });
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', version: '2.1.1', activeInstance: activeInstance, instanceHealthy: instanceHealthy, activeTokens: TOKEN_CACHE.size, redisConnected: !!(redis && redis.status === 'ready'), timestamp: new Date().toISOString() });
});

// ─── Manifest ──────────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.claudochrome.' + req.params.token.slice(0, 8),
    name:        'Claudochrome (TIDAL)',
    version:     '2.1.1',
    description: 'Full TIDAL catalog via Hi-Fi API v2.7. Lossless FLAC, AAC 320. No account required.',
    icon:        'https://monochrome.tf/favicon.ico',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// ─── Search ────────────────────────────────────────────────────────────────────
// /v1/search returns four separate buckets: tracks, albums, artists, playlists
// /search/ (old) ignores type filters and always returns tracks only
app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q = String(req.query.q || req.query.query || '').trim();
  console.log('[search] q:', JSON.stringify(q));
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  try {
    var r = await hifiGet('/v1/search', {
      query:       q,
      types:       'TRACKS,ALBUMS,ARTISTS,PLAYLISTS',
      limit:       20,
      countryCode: COUNTRY
    });

    // Proxy may wrap in { version, data } or return flat — handle both shapes
    var d = (r && r.data && (r.data.tracks || r.data.albums || r.data.artists || r.data.playlists)) ? r.data : r;
    console.log('[search] response keys:', Object.keys(d));

    var trackItems    = (d.tracks    && d.tracks.items)    || [];
    var albumItems    = (d.albums    && d.albums.items)    || [];
    var artistItems   = (d.artists   && d.artists.items)   || [];
    var playlistItems = (d.playlists && d.playlists.items) || [];

    console.log('[search] raw — tracks:', trackItems.length, 'albums:', albumItems.length, 'artists:', artistItems.length, 'playlists:', playlistItems.length);

    var tracks = trackItems
      .filter(function(t){ return t && t.id && t.streamReady !== false && t.allowStreaming !== false; })
      .map(function(t){
        return {
          id:         String(t.id),
          title:      t.title || 'Unknown',
          artist:     trackArtist(t),
          album:      (t.album && t.album.title) || undefined,
          duration:   t.duration ? Math.floor(t.duration) : undefined,
          artworkURL: coverUrl(t.album && t.album.cover),
          isrc:       t.isrc || undefined,
          format:     'flac'
        };
      });

    var albums = albumItems
      .filter(function(a){ return a && a.id; }).slice(0, 8)
      .map(function(a){
        return {
          id:         String(a.id),
          title:      a.title || 'Unknown',
          artist:     (a.artist && a.artist.name) || (a.artists && a.artists[0] && a.artists[0].name) || 'Unknown',
          artworkURL: coverUrl(a.cover),
          trackCount: a.numberOfTracks || undefined,
          year:       a.releaseDate ? String(a.releaseDate).slice(0, 4) : undefined
        };
      });

    var artists = artistItems
      .filter(function(a){ return a && a.id && a.name; }).slice(0, 5)
      .map(function(a){
        return { id: String(a.id), name: a.name, artworkURL: coverUrl(a.picture, 320) };
      });

    // Real TIDAL playlists have uuid + numberOfTracks but never trackNumber/replayGain/isrc/audioQuality
    var playlists = playlistItems
      .filter(function(p){
        if (!p || !p.title)                return false;
        if (p.trackNumber  !== undefined)  return false;
        if (p.replayGain   !== undefined)  return false;
        if (p.audioQuality !== undefined)  return false;
        if (p.isrc         !== undefined)  return false;
        return !!(p.uuid || p.numberOfTracks !== undefined);
      })
      .slice(0, 5)
      .map(function(p){
        return {
          id:         String(p.uuid || p.id || ''),
          title:      p.title,
          creator:    (p.creator && p.creator.name) || undefined,
          artworkURL: coverUrl(p.squareImage || p.image, 320),
          trackCount: p.numberOfTracks || undefined
        };
      })
      .filter(function(p){ return !!p.id; });

    console.log('[search] returning tracks:', tracks.length, 'albums:', albums.length, 'artists:', artists.length, 'playlists:', playlists.length);
    res.json({ tracks: tracks, albums: albums, artists: artists, playlists: playlists });

  } catch (e) {
    console.error('[search] ERROR:', e.message);
    res.status(502).json({ error: 'Search failed', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

// ─── Stream ────────────────────────────────────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  var tid = req.params.id;
  var qualities = ['LOSSLESS', 'HIGH', 'LOW'];
  for (var qi = 0; qi < qualities.length; qi++) {
    var ql = qualities[qi];
    try {
      var data = await hifiGet('/v1/tracks/' + tid + '/streamUrl', {
        soundQuality: ql,
        countryCode:  COUNTRY
      });
      var payload = (data && data.data) ? data.data : data;
      if (payload && payload.manifest) {
        var decoded = decodeManifest(payload.manifest);
        if (decoded && decoded.url) {
          var isFlac = decoded.codec && (decoded.codec.indexOf('flac') !== -1 || decoded.codec.indexOf('audio/flac') !== -1);
          return res.json({ url: decoded.url, format: isFlac ? 'flac' : 'aac', quality: ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps'), expiresAt: Math.floor(Date.now() / 1000) + 21600 });
        }
      }
      if (payload && payload.url) {
        return res.json({ url: payload.url, format: 'aac', quality: 'lossless', expiresAt: Math.floor(Date.now() / 1000) + 21600 });
      }
    } catch (e) {
      if (qi === qualities.length - 1) { console.error('[stream] all qualities failed for ' + tid + ': ' + e.message); return res.status(502).json({ error: 'Could not get stream URL for track ' + tid }); }
    }
  }
  return res.status(404).json({ error: 'No stream found for track ' + tid });
});

// ─── Album ─────────────────────────────────────────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  var aid = req.params.id;
  try {
    var infoData   = await hifiGet('/v1/albums/' + aid, { countryCode: COUNTRY });
    var tracksData = await hifiGet('/v1/albums/' + aid + '/tracks', { countryCode: COUNTRY, limit: 100 });
    var album      = (infoData.data)   ? infoData.data   : infoData;
    var rawItems   = (tracksData.data && tracksData.data.items) ? tracksData.data.items : (tracksData.items || []);
    var artistName = (album.artist && album.artist.name) || (album.artists && album.artists[0] && album.artists[0].name) || 'Unknown';
    var tracks = rawItems
      .filter(function(t){ return t && t.id && t.streamReady !== false; })
      .map(function(t, i){
        return { id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t) || artistName, duration: t.duration ? Math.floor(t.duration) : undefined, trackNumber: t.trackNumber || (i + 1), artworkURL: coverUrl(album.cover) };
      });
    res.json({ id: String(album.id || aid), title: album.title || 'Unknown', artist: artistName, artworkURL: coverUrl(album.cover, 640), year: (album.releaseDate || '').slice(0, 4) || undefined, trackCount: album.numberOfTracks || tracks.length, tracks: tracks });
  } catch (e) { console.error('[album] ' + e.message); res.status(502).json({ error: 'Album fetch failed: ' + e.message }); }
});

// ─── Artist ────────────────────────────────────────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  var aid = parseInt(req.params.id, 10);
  if (isNaN(aid)) return res.status(400).json({ error: 'Invalid artist ID' });
  try {
    var infoRaw = await hifiGet('/v1/artists/' + aid, { countryCode: COUNTRY });
    var topRaw  = await hifiGet('/v1/artists/' + aid + '/toptracks', { countryCode: COUNTRY, limit: 20 });
    var alRaw   = await hifiGet('/v1/artists/' + aid + '/albums',    { countryCode: COUNTRY, limit: 50 });
    var artist   = (infoRaw.data) ? infoRaw.data : infoRaw;
    var topItems = (topRaw.data && topRaw.data.items) ? topRaw.data.items : (topRaw.items || []);
    var albItems = (alRaw.data  && alRaw.data.items)  ? alRaw.data.items  : (alRaw.items  || []);
    var artistName = artist.name || 'Unknown';
    var topTracks = topItems
      .filter(function(t){ return t && t.id && t.streamReady !== false; })
      .map(function(t){ return { id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t) || artistName, duration: t.duration ? Math.floor(t.duration) : undefined, artworkURL: coverUrl(t.album && t.album.cover) }; });
    var albums = albItems
      .filter(function(a){ return a && a.id; })
      .map(function(a){ return { id: String(a.id), title: a.title || 'Unknown', artist: artistName, artworkURL: coverUrl(a.cover), trackCount: a.numberOfTracks || undefined, year: (a.releaseDate || '').slice(0, 4) || undefined }; });
    console.log('[artist] returning topTracks:', topTracks.length, 'albums:', albums.length);
    res.json({ id: String(artist.id || aid), name: artistName, artworkURL: coverUrl(artist.picture, 480), topTracks: topTracks, albums: albums });
  } catch (e) { console.error('[artist] ' + e.message); res.status(502).json({ error: 'Artist fetch failed: ' + e.message }); }
});

// ─── Playlist ──────────────────────────────────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  var pid = req.params.id;
  if (!isPlaylistUUID(pid)) {
    console.warn('[playlist] rejected non-UUID id:', pid);
    return res.status(404).json({ error: 'Invalid playlist ID — must be a TIDAL UUID.' });
  }
  try {
    var infoRaw   = await hifiGet('/v1/playlists/' + pid, { countryCode: COUNTRY });
    var tracksRaw = await hifiGet('/v1/playlists/' + pid + '/tracks', { countryCode: COUNTRY, limit: 100 });
    var pl       = (infoRaw.data)   ? infoRaw.data   : infoRaw;
    var rawItems = (tracksRaw.data && tracksRaw.data.items) ? tracksRaw.data.items : (tracksRaw.items || []);
    console.log('[playlist] title:', pl.title, '| tracks:', rawItems.length);
    var tracks = rawItems
      .filter(function(t){ var item = t.item || t; return item && item.id && item.streamReady !== false; })
      .map(function(t){ var item = t.item || t; return { id: String(item.id), title: item.title || 'Unknown', artist: trackArtist(item), duration: item.duration ? Math.floor(item.duration) : undefined, artworkURL: coverUrl(item.album && item.album.cover) }; });
    res.json({ id: String(pl.uuid || pl.id || pid), title: pl.title || 'Playlist', description: pl.description || undefined, creator: (pl.creator && pl.creator.name) || undefined, artworkURL: coverUrl(pl.squareImage || pl.image, 480), trackCount: pl.numberOfTracks || tracks.length, tracks: tracks });
  } catch (e) { console.error('[playlist] ' + e.message); res.status(502).json({ error: 'Playlist fetch failed: ' + e.message }); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, function(){ console.log('Claudochrome v2.1.1 (Hi-Fi API v2.7) on port ' + PORT); });
