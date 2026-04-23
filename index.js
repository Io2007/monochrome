import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
import crypto from 'crypto';

const app = new Hono();

app.use('*', cors());

async function parseBody(c) {
  try { return await c.req.json(); } catch(e) { return {}; }
}

function makeRes() {
  let _status = 200;
  let _headers = { 'Content-Type': 'application/json' };
  let _body = null;
  const res = {
    _status, _headers, _body,
    status(s) { res._status = s; return res; },
    setHeader(k, v) { res._headers[k] = v; return res; },
    json(data) { res._body = JSON.stringify(data); res._headers['Content-Type'] = 'application/json'; return res; },
    send(html) { res._body = html; return res; },
    toResponse() { return new Response(res._body, { status: res._status, headers: res._headers }); }
  };
  return res;
}

const HIFI_INSTANCES = [
  'https://hifi-api-pj08.onrender.com',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://vogel.qqdl.site',
  'https://tidal-api.binimum.org',
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
let activeInstance  = HIFI_INSTANCES[0];
let instanceHealthy = false;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function coverUrl(uuid, size) {
  if (!uuid) return undefined;
  var s = String(uuid);
  if (s.startsWith('http')) return s;
  size = size || 320;
  return 'https://resources.tidal.com/images/' + s.replace(/-/g, '/') + '/' + size + 'x' + size + '.jpg';
}
function trackDuration(t) { return (t && t.duration) ? Math.floor(t.duration) : undefined; }
function trackArtist(t) {
  if (!t) return 'Unknown';
  if (t.artists && t.artists.length) return t.artists.map(function(a) { return a.name; }).join(', ');
  if (t.artist  && t.artist.name)   return t.artist.name;
  return 'Unknown';
}
function decodeManifest(manifest) {
  try {
    const raw = Buffer.from(manifest, 'base64').toString('utf8');

    // HI_RES often returns an XML MPEG-DASH manifest — extract the first audio URL
    if (raw.trimStart().startsWith('<')) {
      const urlMatch = raw.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)
                    || raw.match(/<SegmentList[^>]*>[\s\S]*?<SegmentURL\s+media="([^"]+)"/i);
      if (urlMatch && urlMatch[1]) {
        const codec = raw.match(/codecs="([^"]+)"/i)?.[1] || 'flac';
        console.log('[decodeManifest] XML/DASH manifest detected, codec:', codec);
        return { url: urlMatch[1], codec };
      }
      console.warn('[decodeManifest] XML manifest but no BaseURL found');
      return null;
    }

    const decoded = JSON.parse(raw);
    const url = (decoded.urls && decoded.urls[0]) || decoded.url || null;
    const codec = decoded.codecs || decoded.codec || decoded.mimeType || '';
    console.log('[decodeManifest] raw decoded:', JSON.stringify(decoded).slice(0, 200));
    return { url, codec };
  } catch (e) {
    console.error('[decodeManifest] failed:', e.message);
    return null;
  }
}
function isPlaylistUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}
function looksLikePlaylist(p) {
  if (!p || !p.title) return false;
  if (p.trackNumber !== undefined) return false;
  if (p.replayGain  !== undefined) return false;
  if (p.peak        !== undefined) return false;
  if (p.isrc        !== undefined) return false;
  if (p.audioQuality !== undefined) return false;
  return !!(p.uuid || p.creator || p.squareImage || p.numberOfTracks !== undefined);
}
function artistRelevance(name, query) {
  var n = (name  || '').toLowerCase().trim();
  var q = (query || '').toLowerCase().trim();
  if (n === q)                              return 4;
  if (n.startsWith(q) || q.startsWith(n))  return 3;
  if (n.includes(q)   || q.includes(n))    return 2;
  return 0;
}

// ─── Hi-Fi API client (shared pool) ──────────────────────────────────────────
async function hifiGet(path, params) {
  var errors    = [];
  var instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(function(i) { return i !== activeInstance; }))
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
async function hifiGetSafe(path, params) {
  try { return await hifiGet(path, params); } catch (e) { return null; }
}

// ─── Hi-Fi API client (token-bound instance) ─────────────────────────────────
async function hifiGetForToken(instanceUrl, path, params) {
  if (instanceUrl) {
    try {
      var r = await axios.get(instanceUrl + path, {
        params:  params || {},
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 15000
      });
      if (r.status === 200 && r.data) return r.data;
      throw new Error('Non-200 from custom instance: ' + r.status);
    } catch (e) {
      throw new Error('Custom instance failed (' + instanceUrl + '): ' + e.message);
    }
  }
  return hifiGet(path, params);
}
async function hifiGetForTokenSafe(instanceUrl, path, params) {
  try { return await hifiGetForToken(instanceUrl, path, params); } catch (e) { return null; }
}

async function checkInstances() {
  for (var inst of HIFI_INSTANCES) {
    try {
      await axios.get(inst + '/search/', { params: { s: 'test', limit: 1 }, timeout: 8000 });
      activeInstance = inst; instanceHealthy = true; console.log('[hifi] healthy: ' + inst); return;
    } catch (e) {}
  }
  instanceHealthy = false; console.warn('[hifi] WARNING: no healthy instances.');
}
checkInstances();
// setInterval removed — Workers are stateless


// ─── Upstash Redis (REST API — works in Cloudflare Workers) ──────────────────
const UPSTASH_URL   = typeof UPSTASH_REDIS_REST_URL   !== 'undefined' ? UPSTASH_REDIS_REST_URL   : null;
const UPSTASH_TOKEN = typeof UPSTASH_REDIS_REST_TOKEN !== 'undefined' ? UPSTASH_REDIS_REST_TOKEN : null;

async function upstashCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (e) {
    console.error('[Upstash] cmd failed:', e.message);
    return null;
  }
}

async function redisSave(token, entry) {
  await upstashCmd(
    'SET', 'mc:token:' + token,
    JSON.stringify({
      createdAt:        entry.createdAt,
      lastUsed:         entry.lastUsed,
      reqCount:         entry.reqCount        || 0,
      instanceUrl:      entry.instanceUrl     || null,
      preferredQuality: entry.preferredQuality || null
    }),
    'EX', 2592000  // 30 days TTL
  );
}

async function redisLoad(token) {
  const raw = await upstashCmd('GET', 'mc:token:' + token);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return {
      createdAt:        p.createdAt        || Date.now(),
      lastUsed:         p.lastUsed         || Date.now(),
      reqCount:         p.reqCount         || 0,
      instanceUrl:      p.instanceUrl      || null,
      preferredQuality: p.preferredQuality || null
    };
  } catch (e) { return null; }
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
  // Try Redis first
  var saved = await redisLoad(token);
  if (saved) {
    var entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, instanceUrl: saved.instanceUrl || null, preferredQuality: saved.preferredQuality || null, rateWin: [] };
    TOKEN_CACHE.set(token, entry);
    return entry;
  }
  // Workers are stateless — TOKEN_CACHE is lost between requests.
  // Without Redis, any well-formed token is trusted (no persistent store available).
  // Token format: 28 hex chars generated by crypto.randomBytes(14).toString('hex')
  if (/^[a-f0-9]{28}$/.test(token)) {
    var fresh = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], instanceUrl: null, preferredQuality: null };
    TOKEN_CACHE.set(token, fresh);
    return fresh;
  }
  return null;
}
function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1; return true;
}
async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry)                return res.status(404).json({ error: 'Invalid token.' });
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
  h += '.badge{display:none;background:#0d1a0d;border:1px solid #1a3a1a;border-radius:8px;padding:8px 12px;font-size:12px;color:#4a9a4a;margin-bottom:10px}';

  // ── Quality selector styles ────────────────────────────────────────────────
  h += '.ql-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}';
  h += '.ql-btn{flex:1;cursor:pointer;border:1px solid #2a2a2a;border-radius:10px;background:#0a0a0a;color:#555;font-size:12px;font-weight:700;padding:10px 6px;text-align:center;transition:all .15s;letter-spacing:.04em}';
  h += '.ql-btn:hover{border-color:#444;color:#aaa}';
  h += '.ql-btn.sel{background:#0d1520;border-color:#4a9eff;color:#4a9eff}';

  h += 'footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}</style></head><body>';

  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px"><circle cx="26" cy="26" r="26" fill="#fff"/><rect x="10" y="20" width="4" height="12" rx="2" fill="#000"/><rect x="17" y="14" width="4" height="24" rx="2" fill="#000"/><rect x="24" y="18" width="4" height="16" rx="2" fill="#000"/><rect x="31" y="11" width="4" height="30" rx="2" fill="#000"/><rect x="38" y="17" width="4" height="18" rx="2" fill="#000"/></svg>';

  h += '<div class="card"><h1>Claudochrome for Eclipse</h1>';
  h += '<p class="sub">Full TIDAL catalog — lossless FLAC, HiRes, AAC 320 — no account, no subscription.</p>';
  h += '<div class="tip"><b>Save your URL.</b> Paste it below to refresh without reinstalling.</div>';
  h += '<div class="pills"><span class="pill">Tracks &middot; Albums &middot; Artists</span><span class="pill hi">FLAC / HiRes</span><span class="pill hi">AAC 320</span></div>';

  h += '<div class="lbl">Custom Hi&#8209;Fi Instance <span style="color:#2a2a2a;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="customInstance" placeholder="https://your-instance.example.com">';
  h += '<div class="hint">Leave blank to use the shared pool. Paste your own self-hosted Hi-Fi API URL to lock this token exclusively to your instance.</div>';

  // ── Quality selector ───────────────────────────────────────────────────────
  h += '<div class="lbl">Preferred Audio Quality <span style="color:#2a2a2a;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<div class="ql-row">';
  h += '<div class="ql-btn" id="ql-HI_RES_LOSSLESS" onclick="selectQuality(\'HI_RES_LOSSLESS\')">HI-RES LOSSLESS<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">FLAC MQA 24-bit</span></div>';
  h += '<div class="ql-btn" id="ql-HI_RES"   onclick="selectQuality(\'HI_RES\')">HI-RES<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">FLAC / HiRes</span></div>';
  h += '<div class="ql-btn" id="ql-LOSSLESS" onclick="selectQuality(\'LOSSLESS\')">LOSSLESS<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">FLAC CD quality</span></div>';
  h += '<div class="ql-btn" id="ql-HIGH"     onclick="selectQuality(\'HIGH\')"    >HIGH<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">AAC 320 kbps</span></div>';
  h += '<div class="ql-btn" id="ql-LOW"      onclick="selectQuality(\'LOW\')"     >LOW<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">AAC 128 kbps</span></div>';
  h += '</div>';
  h += '<div class="hint" id="qlHint">No preference — addon tries LOSSLESS &rarr; HIGH &rarr; LOW automatically.</div>';

  h += '<button class="bw" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="badge" id="genBadge">&#10003; Locked to your custom instance</div><div class="blbl">Your addon URL &mdash; paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';

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
  h += '</div><div class="warn">Hi-Fi instances are community-hosted. The addon auto-discovers working instances and fails over automatically. Tokens locked to a custom instance will only use that instance.</div></div>';

  h += '<div class="card"><h2>Instance Health</h2>';
  h += '<p class="sub" style="margin-bottom:14px">Live status of all Hi-Fi API v2.7 instances.</p>';
  h += '<div class="inst-list" id="instList"><div style="color:#333;font-size:13px">Checking...</div></div>';
  h += '<button class="bg" style="margin-top:14px" onclick="checkHealth()">Refresh Status</button></div>';
  h += '<footer>Claudochrome Eclipse Addon v2.0.0 &bull; Hi-Fi API v2.7</footer>';

  h += '<script>';
  h += 'var _gu="",_ru="",_selQ=null;';

  // quality toggle — clicking the same pill again deselects it
  h += 'var QLABELS={HI_RES_LOSSLESS:"HI-RES LOSSLESS (FLAC MQA 24-bit)",HI_RES:"HI-RES (FLAC / HiRes)",LOSSLESS:"LOSSLESS (FLAC CD quality)",HIGH:"HIGH (AAC 320 kbps)",LOW:"LOW (AAC 128 kbps)"};';
  h += 'function selectQuality(q){';
  h += '  if(_selQ===q){_selQ=null;}else{_selQ=q;}';
  h += '  ["HI_RES_LOSSLESS","HI_RES","LOSSLESS","HIGH","LOW"].forEach(function(k){';
  h += '    document.getElementById("ql-"+k).classList.toggle("sel",_selQ===k);';
  h += '  });';
  h += '  document.getElementById("qlHint").textContent=_selQ';
  h += '    ? "Preferred: "+QLABELS[_selQ]+" \u2014 fallback to lower qualities if unavailable."';
  h += '    : "No preference \u2014 addon tries LOSSLESS \u2192 HIGH \u2192 LOW automatically.";';
  h += '}';

  h += 'function generate(){';
  h += '  var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";';
  h += '  var ci=document.getElementById("customInstance").value.trim();';
  h += '  while(ci.length&&ci[ci.length-1]==="/")ci=ci.slice(0,-1);';
  h += '  var body={};';
  h += '  if(ci)body.instanceUrl=ci;';
  h += '  if(_selQ)body.preferredQuality=_selQ;';   // ← send quality if chosen
  h += '  fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})';
  h += '    .then(function(r){return r.json();})';
  h += '    .then(function(d){';
  h += '      if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '      _gu=d.manifestUrl;';
  h += '      document.getElementById("genUrl").textContent=_gu;';
  h += '      document.getElementById("genBadge").style.display=d.usingCustomInstance?"block":"none";';
  h += '      document.getElementById("genBox").style.display="block";';
  h += '      btn.disabled=false;btn.textContent="Regenerate URL";';
  h += '    }).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});';
  h += '}';

  h += 'function copyGen(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';

  h += 'function doRefresh(){';
  h += '  var btn=document.getElementById("refBtn");';
  h += '  var eu=document.getElementById("existingUrl").value.trim();';
  h += '  if(!eu){alert("Paste your existing addon URL first.");return;}';
  h += '  btn.disabled=true;btn.textContent="Refreshing...";';
  h += '  fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})})';
  h += '    .then(function(r){return r.json();})';
  h += '    .then(function(d){';
  h += '      if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}';
  h += '      _ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;';
  h += '      document.getElementById("refBox").style.display="block";';
  h += '      btn.disabled=false;btn.textContent="Refresh Again";';
  h += '    }).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});';
  h += '}';

  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';

  h += 'function checkHealth(){var list=document.getElementById("instList");list.innerHTML="<div style=\\"color:#333;font-size:13px\\">Checking...</div>";';
  h += 'fetch("/instances").then(function(r){return r.json();}).then(function(data){list.innerHTML="";(data.instances||[]).forEach(function(inst){var row=document.createElement("div");row.className="inst";var dot=document.createElement("span");dot.className=inst.ok?"dot ok":"dot err";var urlSpan=document.createElement("span");urlSpan.className="inst-url";urlSpan.textContent=inst.url;row.appendChild(dot);row.appendChild(urlSpan);if(inst.ok){var ms=document.createElement("span");ms.className="inst-ms";ms.textContent=inst.ms+"ms";row.appendChild(ms);}list.appendChild(row);});}).catch(function(){list.innerHTML="<div style=\\"color:#c04040;font-size:13px\\">Could not reach server</div>";});}';
  h += 'checkHealth();';
  h += '<\/script></body></html>';
  return h;
}


// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', async (c) => {
  const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + (c.req.header('host') || '');
  return new Response(buildConfigPage(baseUrl), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

app.post('/generate', async (c) => {
  const body = await parseBody(c);
  const ip = (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return Response.json({ error: 'Too many tokens from this IP today.' }, { status: 429 });

  let instanceUrl = (body && body.instanceUrl) ? String(body.instanceUrl).trim().replace(/\/+$/, '') : null;
  if (instanceUrl) {
    if (!/^https?:\/\/.+/.test(instanceUrl)) return Response.json({ error: 'Instance URL must start with http:// or https://' }, { status: 400 });
    try { await axios.get(instanceUrl + '/search/', { params: { s: 'test', limit: 1 }, timeout: 8000 }); }
    catch (e) { return Response.json({ error: 'Could not reach your instance: ' + e.message }, { status: 400 }); }
  }

  const VALID_QUALITIES = ['HI_RES_LOSSLESS', 'HI_RES', 'LOSSLESS', 'HIGH', 'LOW'];
  const preferredQuality = (body && body.preferredQuality && VALID_QUALITIES.includes(body.preferredQuality)) ? body.preferredQuality : null;
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], instanceUrl, preferredQuality };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;

  const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + (c.req.header('host') || '');
  return Response.json({ token, manifestUrl: baseUrl + '/u/' + token + '/manifest.json', usingCustomInstance: !!instanceUrl, preferredQuality });
});

app.post('/refresh', async (c) => {
  const body = await parseBody(c);
  const raw = (body && body.existingUrl) ? String(body.existingUrl).trim() : '';
  let token = raw;
  const m = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) return Response.json({ error: 'Paste your full addon URL.' }, { status: 400 });
  const entry = await getTokenEntry(token);
  if (!entry) return Response.json({ error: 'URL not found. Generate a new one.' }, { status: 404 });
  const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + (c.req.header('host') || '');
  return Response.json({ token, manifestUrl: baseUrl + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/instances', async (c) => {
  const results = await Promise.all(HIFI_INSTANCES.map(async (inst) => {
    const start = Date.now();
    try { await axios.get(inst + '/search/', { params: { s: 'test', limit: 1 }, timeout: 6000 }); return { url: inst, ok: true, ms: Date.now() - start }; }
    catch (e) { return { url: inst, ok: false, ms: null }; }
  }));
  return Response.json({ instances: results });
});

app.get('/health', (c) => {
  return Response.json({ status: 'ok', version: '2.0.0', activeInstance, instanceHealthy, activeTokens: TOKEN_CACHE.size, timestamp: new Date().toISOString() });
});

async function withToken(c, handler) {
  const token = c.req.param('token');
  const entry = await getTokenEntry(token);
  if (!entry) return Response.json({ error: 'Invalid token.' }, { status: 404 });
  if (!checkRateLimit(entry)) return Response.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  if (entry.reqCount % 20 === 0) await redisSave(token, entry);
  return handler(entry);
}

app.get('/u/:token/manifest.json', async (c) => {
  return withToken(c, (entry) => {
    const token = c.req.param('token');
    return Response.json({
      id: 'com.eclipse.claudochrome.' + token.slice(0, 8),
      name: 'Claudochrome', version: '2.0.0',
      description: 'Full TIDAL catalog via Hi-Fi API v2.7. Lossless FLAC, AAC 320. No account required.',
      icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSQe_DbvCgGyEcwqhFv8S-Y7ULHa-0FCSHlfJQqpB0CuQ&s=10',
      resources: ['search', 'stream', 'catalog'], types: ['track', 'album', 'artist', 'playlist']
    });
  });
});

app.get('/u/:token/search', async (c) => {
  return withToken(c, async (entry) => {
    const q = String(c.req.query('q') || c.req.query('query') || c.req.query('s') || '').trim();
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 50);
    const inst = entry.instanceUrl;
    if (!q) return Response.json({ tracks: [], albums: [], artists: [], playlists: [] });

    const cacheKey = 'mc:search:' + (inst || 'pool') + ':' + q.toLowerCase() + ':' + limit;
    const cached = await upstashCmd('GET', cacheKey);
    if (cached) { try { return Response.json(JSON.parse(cached)); } catch(e) {} }

    try {
      const [mainResult, plResult] = await Promise.allSettled([
        hifiGetForToken(inst, '/search/', { s: q, limit, offset: 0 }),
        hifiGetForTokenSafe(inst, '/search/', { s: q, type: 'PLAYLISTS', limit: 10, offset: 0 })
      ]);

      const data = mainResult.status === 'fulfilled' ? mainResult.value : null;
      const items = (data && data.data && data.data.items) ? data.data.items : (data && data.items ? data.items : []);
      const albumMap = {}, artistMap = {}, artistHits = {}, tracks = [];

      for (let i = 0; i < items.length; i++) {
        const t = items[i];
        if (!t || !t.id) continue;
        if (t.album && t.album.id) {
          const abid = String(t.album.id);
          if (!albumMap[abid]) albumMap[abid] = { id: abid, title: t.album.title || 'Unknown', artist: trackArtist(t), artworkURL: coverUrl(t.album.cover), trackCount: t.album.numberOfTracks, year: t.album.releaseDate ? String(t.album.releaseDate).slice(0, 4) : undefined };
        }
        (t.artists || (t.artist ? [t.artist] : [])).forEach(a => {
          if (!a || !a.id) return;
          const arid = String(a.id);
          if (!artistMap[arid]) artistMap[arid] = { id: arid, name: a.name || 'Unknown', artworkURL: coverUrl(a.picture, 320) };
          artistHits[arid] = (artistHits[arid] || 0) + 1;
        });
        if (t.streamReady === false || t.allowStreaming === false) continue;
        tracks.push({ id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t), album: (t.album && t.album.title) || undefined, duration: trackDuration(t), artworkURL: coverUrl(t.album && t.album.cover), format: 'flac' });
      }

      const artistList = Object.keys(artistMap)
        .sort((a, b) => (artistRelevance(artistMap[b].name, q) * 100 + (artistHits[b] || 0)) - (artistRelevance(artistMap[a].name, q) * 100 + (artistHits[a] || 0)))
        .slice(0, 5).map(k => artistMap[k]);

      let plItems = [];
      if (plResult.status === 'fulfilled' && plResult.value) {
        const raw = plResult.value;
        const rawItems = raw.data?.playlists?.items || raw.data?.playlists || raw.data?.items || raw.playlists?.items || raw.playlists || raw.items || (Array.isArray(raw.data) ? raw.data : []);
        const realPlaylists = rawItems.filter(looksLikePlaylist);
        if (realPlaylists.length > 0) {
          plItems = realPlaylists.slice(0, 5).map(p => ({
            id: String(p.uuid || p.id || ''),
            title: p.title || 'Playlist',
            creator: p.creator?.name,
            artworkURL: coverUrl(p.squareImage || p.image),
            trackCount: p.numberOfTracks
          })).filter(p => p.id);
        }
      }

      const result = { tracks, albums: Object.values(albumMap).slice(0, 8), artists: artistList, playlists: plItems };
      upstashCmd('SET', cacheKey, JSON.stringify(result), 'EX', 300);
      return Response.json(result);
    } catch (e) {
      return Response.json({ error: 'Search failed: ' + e.message, tracks: [], albums: [], artists: [], playlists: [] }, { status: 502 });
    }
  });
});

app.get('/u/:token/stream/:id', async (c) => {
  return withToken(c, async (entry) => {
    const tid = c.req.param('id');
    const inst = entry.instanceUrl;
    const pref = entry.preferredQuality;

    // No preference = try all from best to worst
    // Preference selected = try that first, then fallback down only
    const ALL_QUALITIES = ['HI_RES_LOSSLESS', 'HI_RES', 'LOSSLESS', 'HIGH', 'LOW'];
    const qualities = pref
      ? [pref, ...ALL_QUALITIES.filter(q => ALL_QUALITIES.indexOf(q) > ALL_QUALITIES.indexOf(pref))]
      : ALL_QUALITIES;

    for (let qi = 0; qi < qualities.length; qi++) {
      const ql = qualities[qi];
      try {
        console.log(`[stream] trying track ${tid} quality=${ql} inst=${inst || activeInstance}`);
        const data = await hifiGetForToken(inst, '/track/', { id: tid, quality: ql });
        const payload = (data && data.data) ? data.data : data;

        if (payload && payload.manifest) {
          const decoded = decodeManifest(payload.manifest);
          if (decoded && decoded.url) {
            const codec = (decoded.codec || '').toLowerCase();
            const isFlac = codec.includes('flac') || codec.includes('audio/flac');
            const isMqa  = codec.includes('mqa');
            const isRealLossless = isFlac || isMqa;
            const format = isRealLossless ? 'flac' : 'aac';
            const qualityLabel =
              isRealLossless && ql === 'HI_RES_LOSSLESS' ? 'hires'    :
              isRealLossless && ql === 'HI_RES'          ? 'hires'    :
              isRealLossless && ql === 'LOSSLESS'        ? 'lossless' :
              ql === 'HIGH'                              ? '320kbps'  : '128kbps';
            console.log(`[stream] ✓ track ${tid} quality=${ql} codec=${decoded.codec} format=${format}`);
            return Response.json({
              url: decoded.url,
              format,
              quality: qualityLabel,
              codec: decoded.codec || null,
              expiresAt: Math.floor(Date.now() / 1000) + 21600
            });
          }
        }

        if (payload && payload.url) {
          const qualityLabel =
            ql === 'HI_RES'   ? 'hires'    :
            ql === 'LOSSLESS' ? 'lossless' :
            ql === 'HIGH'     ? '320kbps'  : '128kbps';
          return Response.json({
            url: payload.url,
            format: 'aac',
            quality: qualityLabel,
            expiresAt: Math.floor(Date.now() / 1000) + 21600
          });
        }

        console.warn(`[stream] no url or manifest for quality=${ql}, trying next...`);
      } catch (e) {
        console.error(`[stream] error quality=${ql}:`, e.message);
        if (qi === qualities.length - 1)
          return Response.json({ error: 'Could not get stream URL for track ' + tid + ': ' + e.message }, { status: 502 });
      }
    }
    return Response.json({ error: 'No stream found for track ' + tid }, { status: 404 });
  });
});

app.get('/u/:token/album/:id', async (c) => {
  return withToken(c, async (entry) => {
    const aid = c.req.param('id'), inst = entry.instanceUrl;
    try {
      const data = await hifiGetForToken(inst, '/album/', { id: aid, limit: 100, offset: 0 });
      const album = (data && data.data) ? data.data : data;
      const rawItems = album.items || [];
      const artistName = album.artist?.name || album.artists?.map(a => a.name).join(', ') || 'Unknown';
      const tracks = rawItems.map((item, i) => {
        const t = item.item || item;
        if (!t || !t.id || t.streamReady === false) return null;
        return { id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t) || artistName, duration: trackDuration(t), trackNumber: t.trackNumber || (i + 1), artworkURL: coverUrl(album.cover) };
      }).filter(Boolean);
      return Response.json({ id: String(album.id || aid), title: album.title || 'Unknown', artist: artistName, artworkURL: coverUrl(album.cover, 640), year: (album.releaseDate || '').slice(0, 4) || undefined, trackCount: album.numberOfTracks || tracks.length, tracks });
    } catch (e) { return Response.json({ error: 'Album fetch failed: ' + e.message }, { status: 502 }); }
  });
});

app.get('/u/:token/artist/:id', async (c) => {
  return withToken(c, async (entry) => {
    const aid = parseInt(c.req.param('id'), 10), inst = entry.instanceUrl;
    if (isNaN(aid)) return Response.json({ error: 'Invalid artist ID' }, { status: 400 });
    try {
      const infoData = await hifiGetForToken(inst, '/artist/', { id: aid });
      let artistInfo = infoData.artist?.id ? infoData.artist : infoData.data?.artist?.id ? infoData.data.artist : infoData.id ? infoData : infoData.data?.id ? infoData.data : {};
      const coverData = infoData.cover || {};
      let albumItems = [], allTracks = [];
      try {
        const discData = await hifiGetForToken(inst, '/artist/', { f: aid, skip_tracks: false });
        albumItems = Array.isArray(discData.albums) ? discData.albums : discData.albums?.items || [];
        allTracks  = Array.isArray(discData.tracks) ? discData.tracks  : discData.tracks?.items  || [];
      } catch (_) {}
      if (!albumItems.length) {
        try {
          const albData = await hifiGetForToken(inst, '/artist/albums/', { id: aid, limit: 50, offset: 0 });
          albumItems = Array.isArray(albData) ? albData : albData.items || albData.data?.items || albData.data || [];
        } catch (_) {}
      }
      if (!albumItems.length && artistInfo.name) {
        try {
          const sData = await hifiGetForToken(inst, '/search/', { s: artistInfo.name, limit: 20, offset: 0 });
          const sItems = sData?.data?.items || [];
          const aMap = {};
          sItems.forEach(t => {
            if (!t?.album?.id) return;
            const tArt = trackArtist(t).toLowerCase(), want = (artistInfo.name || '').toLowerCase();
            if (!tArt.includes(want) && !want.includes(tArt)) return;
            const alId = String(t.album.id);
            if (!aMap[alId]) aMap[alId] = { id: alId, title: t.album.title, cover: t.album.cover, releaseDate: t.album.releaseDate, numberOfTracks: t.album.numberOfTracks };
          });
          albumItems = Object.values(aMap);
        } catch (_) {}
      }
      const artistName = artistInfo.name || 'Unknown';
      const artworkURL = coverData['750'] || coverUrl(artistInfo.picture, 480);
      const topTracks = allTracks.filter(t => t?.id && t.streamReady !== false && t.allowStreaming !== false).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 20).map(t => ({ id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t) || artistName, duration: trackDuration(t), artworkURL: coverUrl(t.album?.cover) }));
      const albums = albumItems.filter(a => a?.id).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')).slice(0, 60).map(al => ({ id: String(al.id), title: al.title || 'Unknown', artist: artistName, artworkURL: coverUrl(al.cover), trackCount: al.numberOfTracks, year: (al.releaseDate || '').slice(0, 4) || undefined }));
      return Response.json({ id: String(artistInfo.id || aid), name: artistName, artworkURL, bio: null, topTracks, albums });
    } catch (e) { return Response.json({ error: 'Artist fetch failed: ' + e.message }, { status: 502 }); }
  });
});

app.get('/u/:token/playlist/:id', async (c) => {
  return withToken(c, async (entry) => {
    const pid = c.req.param('id'), inst = entry.instanceUrl;
    if (!isPlaylistUUID(pid)) return Response.json({ error: 'Invalid playlist ID. TIDAL playlist IDs must be UUIDs.' }, { status: 404 });
    try {
      const data = await hifiGetForToken(inst, '/playlist/', { id: pid, limit: 100, offset: 0 });
      let pl = null, rawItems = [];
      if      (data.playlist?.uuid || data.playlist?.id) { pl = data.playlist; rawItems = data.items || data.playlist.items || []; }
      else if (data.data?.playlist)                       { pl = data.data.playlist; rawItems = data.data.items || data.items || []; }
      else if (data.uuid || data.title)                   { pl = data; rawItems = data.items || []; }
      else if (data.data?.uuid || data.data?.title)       { pl = data.data; rawItems = data.data.items || data.items || []; }
      else                                                { pl = data; rawItems = data.items || []; }
      const tracks = rawItems.map(item => {
        const t = item.item || item;
        if (!t || !t.id || t.streamReady === false) return null;
        return { id: String(t.id), title: t.title || 'Unknown', artist: trackArtist(t), duration: trackDuration(t), artworkURL: coverUrl(t.album?.cover) };
      }).filter(Boolean);
      return Response.json({ id: String(pl?.uuid || pl?.id || pid), title: pl?.title || 'Playlist', creator: pl?.creator?.name, artworkURL: (pl?.squareImage || pl?.image) ? coverUrl(pl.squareImage || pl.image, 480) : undefined, trackCount: pl?.numberOfTracks || tracks.length, tracks });
    } catch (e) { return Response.json({ error: 'Playlist fetch failed: ' + e.message }, { status: 502 }); }
  });
});

// ─── TEMP DEBUG ROUTE — remove after diagnosing quality issue ────────────────
app.get('/u/:token/debug/stream/:id', async (c) => {
  return withToken(c, async (entry) => {
    const tid = c.req.param('id');
    const inst = entry.instanceUrl;
    const results = [];

    for (const ql of ['HI_RES', 'LOSSLESS', 'HIGH', 'LOW']) {
      try {
        const data = await hifiGetForToken(inst, '/track/', { id: tid, quality: ql });
        const payload = (data && data.data) ? data.data : data;
        const payloadKeys = Object.keys(payload || {});
        let manifestDecoded = null;
        if (payload && payload.manifest) {
          try {
            manifestDecoded = JSON.parse(Buffer.from(payload.manifest, 'base64').toString('utf8'));
          } catch(e) { manifestDecoded = { error: e.message }; }
        }
        results.push({
          quality: ql,
          status: 'ok',
          payloadKeys,
          hasManifest: !!payload?.manifest,
          manifestDecoded,
          directUrl: payload?.url || null,
          audioQuality: payload?.audioQuality || null,
        });
      } catch (e) {
        results.push({ quality: ql, status: 'error', error: e.message });
      }
    }

    return Response.json({ trackId: tid, inst: inst || activeInstance, results });
  });
});

export default app;

