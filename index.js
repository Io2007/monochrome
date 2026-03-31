const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Redis ──────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('connect', () => console.log('[Redis] connected'));
redis.on('error',   (e) => console.error('[Redis] error', e.message));

// ─── Hi-Fi Instances ────────────────────────────────────────────────────────
const HIFI_INSTANCES = [
  'https://ohio-1.monochrome.tf',
  'https://ohio-2.monochrome.tf',
  'https://va-1.monochrome.tf',
  'https://va-2.monochrome.tf'
];
let activeHifi = null;

async function pickHifi() {
  for (const inst of HIFI_INSTANCES) {
    try {
      await axios.get(inst + '/v1/health', { timeout: 4000 });
      activeHifi = inst;
      console.log('[hifi] healthy:', inst);
      return;
    } catch (_) {}
  }
  console.error('[hifi] all instances down');
}
pickHifi();
setInterval(pickHifi, 60000);

// ─── Helpers ────────────────────────────────────────────────────────────────
const COUNTRY = process.env.TIDAL_COUNTRY || 'US';

function coverURL(uuid, size) {
  if (!uuid) return null;
  size = size || 320;
  return 'https://resources.tidal.com/images/' + uuid.replace(/-/g, '/') + '/' + size + 'x' + size + '.jpg';
}

function mapTrack(t) {
  return {
    id:         String(t.id),
    title:      t.title,
    artist:     (t.artist && t.artist.name) || (t.artists && t.artists[0] && t.artists[0].name) || 'Unknown',
    album:      (t.album && t.album.title) || '',
    duration:   t.duration || 0,
    artworkURL: coverURL((t.album && t.album.cover) || null),
    isrc:       t.isrc || undefined,
    format:     'flac'
  };
}

function mapAlbum(a) {
  return {
    id:         String(a.id),
    title:      a.title,
    artist:     (a.artist && a.artist.name) || (a.artists && a.artists[0] && a.artists[0].name) || 'Unknown',
    artworkURL: coverURL(a.cover),
    trackCount: a.numberOfTracks || 0,
    year:       a.releaseDate ? String(a.releaseDate).slice(0, 4) : undefined
  };
}

function mapArtist(a) {
  return {
    id:         String(a.id),
    name:       a.name,           // ← MUST be 'name', never 'title'
    artworkURL: coverURL(a.picture),
    genres:     a.genres || []
  };
}

// ─── Config page ─────────────────────────────────────────────────────────────
app.get('/', function (req, res) {
  const base = (req.protocol + '://' + req.get('host'));
  let h = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claudochrome</title>';
  h += '<style>body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#e0e0e0;max-width:600px;margin:40px auto;padding:20px}';
  h += 'h1{color:#4f98a3;margin-bottom:4px}.sub{color:#888;margin-bottom:32px}';
  h += '.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:16px}';
  h += 'label{display:block;color:#aaa;font-size:13px;margin-bottom:6px}';
  h += 'input{width:100%;padding:10px 12px;background:#111;border:1px solid #333;border-radius:8px;color:#e0e0e0;font-size:14px;box-sizing:border-box}';
  h += 'button{margin-top:12px;padding:10px 20px;background:#4f98a3;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px}';
  h += 'button:hover{background:#3a7d88}.url-box{word-break:break-all;background:#111;border:1px solid #333;border-radius:8px;padding:12px;font-size:13px;color:#4f98a3;margin-top:12px;display:none}';
  h += '.copy-btn{background:#2a2a2a;font-size:12px;padding:6px 12px;margin-top:8px}</style></head><body>';
  h += '<h1>Claudochrome</h1><p class="sub">TIDAL streaming addon for Eclipse Music</p>';
  h += '<div class="card"><label>Generate your personal addon URL</label>';
  h += '<button onclick="gen()">Generate URL</button>';
  h += '<div class="url-box" id="out"></div>';
  h += '<button class="copy-btn" id="copyBtn" style="display:none" onclick="copy()">Copy URL</button></div>';
  h += '<div class="card"><label>Or use the shared URL (no token)</label>';
  h += '<div class="url-box" style="display:block">' + base + '/manifest.json</div></div>';
  h += '<script>function gen(){var t=([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,function(c){return(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)});var url="' + base + '/"+t+"/manifest.json";document.getElementById("out").innerText=url;document.getElementById("out").style.display="block";document.getElementById("copyBtn").style.display="inline-block";document.getElementById("copyBtn").dataset.url=url;}';
  h += 'function copy(){navigator.clipboard.writeText(document.getElementById("copyBtn").dataset.url);document.getElementById("copyBtn").innerText="Copied!";setTimeout(function(){document.getElementById("copyBtn").innerText="Copy URL"},2000);}</script>';
  h += '<footer style="margin-top:32px;color:#555;font-size:12px">Claudochrome Eclipse Addon v1.5.0</footer></body></html>';
  res.send(h);
});

// ─── Manifest (base) ─────────────────────────────────────────────────────────
app.get('/manifest.json', function (req, res) {
  res.json({
    id:          'com.eclipse.claudochrome.main',
    name:        'Claudochrome',
    version:     '1.5.0',
    description: 'TIDAL streaming via Hi-Fi API — lossless quality',
    resources:   ['search', 'stream', 'catalog'],   // ← 'catalog' is required
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// ─── Manifest (per-user token) ────────────────────────────────────────────────
app.get('/:token/manifest.json', function (req, res) {
  res.json({
    id:          'com.eclipse.claudochrome.' + req.params.token,
    name:        'Claudochrome',
    version:     '1.5.0',
    description: 'TIDAL streaming via Hi-Fi API — lossless quality',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// ─── Search handler (shared logic) ───────────────────────────────────────────
async function handleSearch(q, res) {
  console.log('[search] q:', JSON.stringify(q));
  if (!q || !activeHifi) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  try {
    const r = await axios.get(activeHifi + '/v1/search', {
      params: { query: q, types: 'TRACKS,ALBUMS,ARTISTS', limit: 20, countryCode: COUNTRY },
      timeout: 8000
    });
    const d = r.data;

    const tracks  = ((d.tracks  && d.tracks.items)  || []).map(mapTrack);
    const albums  = ((d.albums  && d.albums.items)  || []).map(mapAlbum);
    const artists = ((d.artists && d.artists.items) || []).map(mapArtist);

    console.log('[search] returning tracks:', tracks.length, 'albums:', albums.length, 'artists:', artists.length);
    res.json({ tracks, albums, artists, playlists: [] });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  }
}

app.get('/search',        function (req, res) { handleSearch((req.query.q || '').trim(), res); });
app.get('/:token/search', function (req, res) { handleSearch((req.query.q || '').trim(), res); });

// ─── Stream handler ───────────────────────────────────────────────────────────
async function handleStream(id, res) {
  if (!activeHifi) return res.status(503).json({ error: 'No Hi-Fi instance available' });
  const cacheKey = 'cc:stream:' + id;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  } catch (_) {}

  try {
    const r = await axios.get(activeHifi + '/v1/tracks/' + id + '/streamUrl', {
      params: { soundQuality: 'LOSSLESS', countryCode: COUNTRY },
      timeout: 8000
    });
    const result = {
      url:     r.data.url,
      format:  (r.data.codec || 'flac').toLowerCase(),
      quality: r.data.soundQuality || 'LOSSLESS'
    };
    try { await redis.setex(cacheKey, 3600, JSON.stringify(result)); } catch (_) {}
    res.json(result);
  } catch (e) {
    console.error('[stream] error:', e.message);
    res.status(500).json({ error: 'Stream unavailable' });
  }
}

app.get('/stream/:id',        function (req, res) { handleStream(req.params.id, res); });
app.get('/:token/stream/:id', function (req, res) { handleStream(req.params.id, res); });

// ─── Album ────────────────────────────────────────────────────────────────────
async function handleAlbum(id, res) {
  if (!activeHifi) return res.status(503).json({ error: 'No instance' });
  try {
    const [aR, tR] = await Promise.all([
      axios.get(activeHifi + '/v1/albums/' + id,          { params: { countryCode: COUNTRY }, timeout: 8000 }),
      axios.get(activeHifi + '/v1/albums/' + id + '/tracks', { params: { countryCode: COUNTRY, limit: 100 }, timeout: 8000 })
    ]);
    const album  = aR.data;
    const tracks = ((tR.data && tR.data.items) || []).map(function (t) {
      return Object.assign(mapTrack(t), {
        artworkURL: coverURL((t.album && t.album.cover) || album.cover)
      });
    });
    res.json(Object.assign(mapAlbum(album), { tracks: tracks }));
  } catch (e) {
    console.error('[album] error:', e.message);
    res.status(500).json({ error: 'Album unavailable' });
  }
}

app.get('/album/:id',        function (req, res) { handleAlbum(req.params.id, res); });
app.get('/:token/album/:id', function (req, res) { handleAlbum(req.params.id, res); });

// ─── Artist ───────────────────────────────────────────────────────────────────
async function handleArtist(id, res) {
  if (!activeHifi) return res.status(503).json({ error: 'No instance' });
  try {
    const [arR, ttR, alR] = await Promise.all([
      axios.get(activeHifi + '/v1/artists/' + id,              { params: { countryCode: COUNTRY }, timeout: 8000 }),
      axios.get(activeHifi + '/v1/artists/' + id + '/toptracks', { params: { countryCode: COUNTRY, limit: 10 }, timeout: 8000 }),
      axios.get(activeHifi + '/v1/artists/' + id + '/albums',  { params: { countryCode: COUNTRY, limit: 20 }, timeout: 8000 })
    ]);
    const artist    = arR.data;
    const topTracks = ((ttR.data && ttR.data.items) || []).map(mapTrack);
    const albums    = ((alR.data && alR.data.items) || []).map(mapAlbum);
    res.json(Object.assign(mapArtist(artist), { topTracks: topTracks, albums: albums }));
  } catch (e) {
    console.error('[artist] error:', e.message);
    res.status(500).json({ error: 'Artist unavailable' });
  }
}

app.get('/artist/:id',        function (req, res) { handleArtist(req.params.id, res); });
app.get('/:token/artist/:id', function (req, res) { handleArtist(req.params.id, res); });

// ─── Playlist ─────────────────────────────────────────────────────────────────
async function handlePlaylist(id, res) {
  if (!activeHifi) return res.status(503).json({ error: 'No instance' });
  try {
    const [pR, tR] = await Promise.all([
      axios.get(activeHifi + '/v1/playlists/' + id,           { params: { countryCode: COUNTRY }, timeout: 8000 }),
      axios.get(activeHifi + '/v1/playlists/' + id + '/tracks', { params: { countryCode: COUNTRY, limit: 100 }, timeout: 8000 })
    ]);
    const pl     = pR.data;
    const tracks = ((tR.data && tR.data.items) || []).map(mapTrack);
    res.json({
      id:          String(pl.uuid || pl.id),
      title:       pl.title,
      description: pl.description || '',
      artworkURL:  coverURL(pl.squareImage || pl.image),
      creator:     (pl.creator && pl.creator.name) || 'TIDAL',
      tracks:      tracks
    });
  } catch (e) {
    console.error('[playlist] error:', e.message);
    res.status(500).json({ error: 'Playlist unavailable' });
  }
}

app.get('/playlist/:id',        function (req, res) { handlePlaylist(req.params.id, res); });
app.get('/:token/playlist/:id', function (req, res) { handlePlaylist(req.params.id, res); });

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', function (req, res) {
  res.json({
    status:        'ok',
    version:       '1.5.0',
    activeHifi:    activeHifi,
    redisConnected: redis.status === 'ready',
    timestamp:     new Date().toISOString()
  });
});

app.listen(PORT, function () {
  console.log('Claudochrome v1.5.0 (Hi-Fi API v2.7) on port ' + PORT);
});
