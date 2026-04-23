# Cloudflare Workers Setup — Claudochrome

## Files included
- `wrangler.toml`       → Cloudflare Workers config (add to repo root)
- `package.json`        → Updated package.json (replaces existing)
- `.github/workflows/deploy.yml` → Auto-deploy on git push to main

## ONE manual change needed in index.js

Find this block near the very bottom of index.js:

```js
if (require.main === module) {
  app.listen(PORT, function() { console.log('Claudochrome v2.0.0 (Hi-Fi API v2.7) on port ' + PORT); });
}
module.exports = app;
```

REPLACE it with:

```js
if (typeof addEventListener === 'undefined' && require.main === module) {
  app.listen(PORT, function() { console.log('Claudochrome v2.0.0 (Hi-Fi API v2.7) on port ' + PORT); });
}
module.exports = app;
```

That's the ONLY change to index.js. Everything else stays identical.

---

## Redis note
ioredis (TCP) does NOT work on Cloudflare Workers free tier.
The app already handles `redis = null` gracefully (in-memory token cache only).
Simply do NOT set a REDIS_URL secret in Cloudflare — it will run fine without it.
Tokens will be in-memory only (reset on redeploy), which is acceptable.

If you want persistent tokens on Workers, use Upstash Redis (free tier):
https://upstash.com — they provide an HTTP-based Redis URL that works on Workers.
Just add it as: wrangler secret put REDIS_URL

---

## Step-by-step deploy

### On desktop/laptop:
1. Add all 3 files to your repo root (deploy.yml goes in .github/workflows/)
2. Make the ONE index.js change above
3. Run: npm install
4. Run: wrangler login
5. Run: wrangler deploy
6. Your URL will be: https://eclipse-claudochrome.YOUR-SUBDOMAIN.workers.dev

### Auto-deploy via GitHub (after step 5 above):
1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token" → use "Edit Cloudflare Workers" template
3. Copy the token
4. Go to your GitHub repo → Settings → Secrets → Actions
5. Add secret named: CLOUDFLARE_API_TOKEN
6. Every push to main now auto-deploys

---

## Getting your URL for Eclipse

After deploying, your base URL is:
  https://eclipse-claudochrome.YOUR-SUBDOMAIN.workers.dev

1. Open that URL in your browser
2. Tap "Generate My Addon URL"
3. Copy the manifest URL it gives you (looks like):
   https://eclipse-claudochrome.YOUR-SUBDOMAIN.workers.dev/u/TOKEN/manifest.json
4. In Eclipse → Settings → Connections → Add Connection → Addon
5. Paste the manifest URL → tap Install
