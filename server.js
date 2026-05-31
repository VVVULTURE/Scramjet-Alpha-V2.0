import express from "express";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { server as wispServer } from "@mercuryworkshop/wisp-js/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT      = process.env.PORT || 8080;
const WISP_PATH = "/wisp/";

const app    = express();
const server = createServer(app);

// ─── /bare/  HTTP proxy endpoint for the scramjet service worker transport ───
// The SW posts here with X-Bare-URL / X-Bare-Method / X-Bare-Headers.
// The server fetches the target URL server-side (bypassing browser CORS)
// and forwards the response.
app.use("/bare/", express.raw({ type: "*/*", limit: "10mb" }), async (req, res) => {
  const targetUrl  = req.headers["x-bare-url"];
  const method     = req.headers["x-bare-method"] ?? req.method;
  const rawHdrs    = req.headers["x-bare-headers"] ?? "{}";

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing X-Bare-URL header" });
  }

  let forwardHeaders = {};
  try { forwardHeaders = JSON.parse(rawHdrs); } catch { /* ignore */ }

  // Strip hop-by-hop / CORS headers we'll re-add ourselves
  const STRIP = new Set([
    "host", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding",
    "upgrade", "origin",
  ]);
  Object.keys(forwardHeaders).forEach(k => {
    if (STRIP.has(k.toLowerCase())) delete forwardHeaders[k];
  });

  try {
    const hasBody = method !== "GET" && method !== "HEAD" && req.body?.length;

    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body:    hasBody ? req.body : undefined,
      redirect: "manual",   // forward redirects back to the SW
    });

    // Collect response headers
    const respHeaders = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });

    // Tell the SW the real status and headers via special response headers
    res.setHeader("X-Bare-Status",      upstream.status);
    res.setHeader("X-Bare-Status-Text", upstream.statusText ?? "");
    res.setHeader("X-Bare-Headers",     JSON.stringify(respHeaders));

    // Allow the SW to read our bare response headers
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Expose-Headers",
      "X-Bare-Status, X-Bare-Status-Text, X-Bare-Headers");

    // Forward safe response headers so body streaming works
    const FORWARD_SAFE = ["content-type", "content-length", "content-encoding"];
    FORWARD_SAFE.forEach(k => {
      const v = respHeaders[k];
      if (v) res.setHeader(k, v);
    });

    res.status(upstream.status);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump   = async () => {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
        return pump();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err) {
    console.error("[bare] upstream fetch error:", err.message);
    res.status(502).json({ error: "Upstream fetch failed", detail: err.message });
  }
});

// Preflight for bare endpoint
app.options("/bare/", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, X-Bare-URL, X-Bare-Method, X-Bare-Headers");
  res.sendStatus(204);
});

// ─── Scramjet static files ────────────────────────────────────────────────────
app.use("/scramjet/", express.static(join(__dirname, "static/scramjet"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".wasm")) {
      res.setHeader("Content-Type", "application/wasm");
    }
    // Allow scramjet JS files to be used as service workers
    res.setHeader("Service-Worker-Allowed",       "/");
    res.setHeader("Cross-Origin-Opener-Policy",   "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  },
}));

// ─── Frontend static files ───────────────────────────────────────────────────
app.use("/", express.static(join(__dirname, "static"), {
  index: "index.html",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cross-Origin-Opener-Policy",   "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
  },
}));

// ─── Wisp WebSocket upgrade ───────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith(WISP_PATH)) {
    req.url = req.url.slice(WISP_PATH.length - 1) || "/";
    wispServer.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Scramjet proxy server running on port ${PORT}`);
  console.log(`Wisp endpoint: ws://localhost:${PORT}${WISP_PATH}`);
  console.log(`Bare endpoint: http://localhost:${PORT}/bare/`);
  console.log(`Visit: http://localhost:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down…");
  server.close(() => process.exit(0));
});
