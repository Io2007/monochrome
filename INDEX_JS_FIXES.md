# index.js — Two surgical fixes for Cloudflare Workers

## FIX 1 — ioredis (line 5)

FIND (line 5):
  const Redis   = require('ioredis');

REPLACE WITH:
  let Redis = null;
  try { Redis = require('ioredis'); } catch(e) {}

---

## FIX 2 — Bottom of file, replace the last 6 lines

FIND (very bottom of index.js):
  (function startKeepAlive() {
    var selfUrl = process.env.RENDER_EXTERNAL_URL || null;
    if (!selfUrl) {
      console.log('[keep-alive] RENDER_EXTERNAL_URL not set — skipping self-ping.');
      return;
    }
    var pingUrl = selfUrl.replace(/\/+$/, '') + '/health';
    setInterval(function () {
      axios.get(pingUrl, { timeout: 10000 })
        .then(function () { console.log('[keep-alive] ping ok -> ' + pingUrl); })
        .catch(function (e) { console.warn('[keep-alive] ping failed: ' + e.message); });
    }, 14 * 60 * 1000);
    console.log('[keep-alive] started, pinging ' + pingUrl + ' every 14 min');
  })();

  if (require.main === module) {
    app.listen(PORT, function() { console.log('Claudochrome v2.0.0 (Hi-Fi API v2.7) on port ' + PORT); });
  }
  module.exports = app;

REPLACE WITH:
  if (typeof GLOBAL !== 'undefined' || typeof WorkerGlobalScope === 'undefined') {
    (function startKeepAlive() {
      var selfUrl = process.env.RENDER_EXTERNAL_URL || null;
      if (!selfUrl) {
        console.log('[keep-alive] RENDER_EXTERNAL_URL not set — skipping self-ping.');
        return;
      }
      var pingUrl = selfUrl.replace(/\/+$/, '') + '/health';
      setInterval(function () {
        axios.get(pingUrl, { timeout: 10000 })
          .then(function () { console.log('[keep-alive] ping ok -> ' + pingUrl); })
          .catch(function (e) { console.warn('[keep-alive] ping failed: ' + e.message); });
      }, 14 * 60 * 1000);
      console.log('[keep-alive] started, pinging ' + pingUrl + ' every 14 min');
    })();
  }

  if (typeof addEventListener === 'undefined' && require.main === module) {
    app.listen(PORT, function() { console.log('Claudochrome v2.0.0 (Hi-Fi API v2.7) on port ' + PORT); });
  }
  module.exports = app;
  export default app;

---

## Why these fixes?

Fix 1: Cloudflare's bundler can't resolve ioredis (it uses TCP which Workers don't support).
        Wrapping in try/catch makes it optional — the app already handles redis=null gracefully.
        Just don't set REDIS_URL in your Cloudflare Worker secrets and it will skip Redis entirely.

Fix 2: Cloudflare Workers requires an ES module default export (`export default app`).
        Without it you get the "no default export / Service Worker format" error.
        The keep-alive self-ping is also guarded so it only runs on Render, not on Workers.

---

## After making both fixes, redeploy:
  wrangler deploy
  or just push to main (GitHub Action handles it)

## Your Worker URL will be:
  https://monochrome1.YOUR-SUBDOMAIN.workers.dev
