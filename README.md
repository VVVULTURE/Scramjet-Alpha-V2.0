# Scramjet Proxy Deployment

A self-hosted web proxy built on [Scramjet v2.0.67-alpha.1](https://github.com/MercuryWorkshop/scramjet) with a Wisp transport server. Deploy to Render (or any Node.js host) in minutes.

## Features

- 🌐 Full web proxy via Scramjet service worker
- ⚡ Wisp WebSocket transport (all traffic through your server — no external bare servers)
- 🔒 XOR URL encoding
- 🎨 Clean dark UI with quick links and inline browsing
- 🚀 One-click Render deploy

## Tech Stack

| Layer | Technology |
|---|---|
| Proxy engine | Scramjet 2.0.67-alpha.1 |
| Transport | `@mercuryworkshop/wisp-js` 0.4.x |
| Server | Express + Node.js HTTP |
| Frontend | Vanilla HTML/CSS/JS |

## How It Works

1. The Express server serves static files (the Scramjet JS/WASM bundles and the UI).
2. WebSocket upgrade requests to `/wisp/` are handed off to the Wisp server, which proxies raw TCP connections from the browser.
3. The Scramjet service worker intercepts all fetch events in the browser and rewrites URLs to flow through Wisp.

```
Browser → Service Worker (Scramjet) → WebSocket (Wisp) → Server → Internet
```

## Deploy to Render

### Option A — Render Dashboard (recommended)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New Web Service**.
3. Connect your GitHub repo.
4. Render auto-detects `render.yaml`. Click **Apply**.
5. Done! Your proxy will be live at `https://your-service.onrender.com`.

### Option B — render.yaml (already included)

The `render.yaml` in this repo configures:
- Runtime: Node.js
- Build: `npm install`
- Start: `node server.js`
- Free plan

### Option C — Manual settings

| Setting | Value |
|---|---|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |

## Run Locally

```bash
npm install
node server.js
# → http://localhost:8080
```

## Project Structure

```
scramjet-proxy/
├── server.js              # Express + Wisp server
├── package.json
├── render.yaml            # Render deploy config
├── .gitignore
└── static/
    ├── index.html         # Proxy UI
    ├── scramjet-init.js   # Client init helper
    └── scramjet/          # Scramjet dist files
        ├── scramjet.js    # Service worker bundle (IIFE)
        ├── scramjet.mjs   # ESM build
        ├── scramjet.wasm  # WASM rewriter
        ├── scramjet_bundled.js
        └── scramjet_bundled.mjs
```

## Wisp Endpoint

The Wisp server is available at `ws://your-host/wisp/` (or `wss://` on HTTPS). The frontend automatically detects the protocol.

## Notes

- Scramjet uses a **service worker** — the browser must support them (all modern browsers do).
- First visit registers the SW; subsequent visits are instant.
- On Render free tier, the server sleeps after 15 min of inactivity. The first request after sleep takes ~30s to wake.
- For production use, upgrade to Render's paid tier or use a platform without cold starts.

## License

Scramjet is licensed under AGPL-3.0. See [MercuryWorkshop/scramjet](https://github.com/MercuryWorkshop/scramjet) for details.
