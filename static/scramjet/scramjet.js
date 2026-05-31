// ═══════════════════════════════════════════════════════════════════════════
//  scramjet.js  —  Scramjet Service Worker Entry Point
//  This replaces the raw client bundle that was incorrectly registered as a
//  service worker.  The client bundle (scramjet_bundled.js) is imported
//  lazily inside event handlers so that top-level IIFE code (including
//  WebSocket.CLOSED and URL.createObjectURL.bind) runs only after the SW
//  global scope is fully initialised.
// ═══════════════════════════════════════════════════════════════════════════

// ─── XOR codec — must match index.html ─────────────────────────────────────
const codec = {
  encode(str) {
    return btoa(
      Array.from(encodeURIComponent(str))
        .map(c => String.fromCharCode(c.charCodeAt(0) ^ 2))
        .join('')
    );
  },
  decode(str) {
    try {
      return decodeURIComponent(
        Array.from(atob(str))
          .map(c => String.fromCharCode(c.charCodeAt(0) ^ 2))
          .join('')
      );
    } catch { return null; }
  },
};

const SCRAMJET_PREFIX  = '/scramjet~/';
const BUNDLE_URL       = '/scramjet/scramjet_bundled.js';
const WASM_URL         = '/scramjet/scramjet.wasm';
const BARE_URL         = '/bare/';

let fetchHandler  = null;
let bundleLoaded  = false;
let cookieJar     = null;

// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureBundle() {
  if (bundleLoaded) return;

  // ── SW global shims ────────────────────────────────────────────────────
  // Chrome 91+ removed URL.createObjectURL / revokeObjectURL from service
  // worker scope (they require a document context).  The scramjet bundle's
  // module 5994 caches these with .bind() at evaluation time, so if they
  // are undefined the importScripts call throws:
  //   TypeError: Cannot read properties of undefined (reading 'bind')
  // We shim them as no-ops BEFORE importing the bundle.  The SW never
  // needs to create real blob URLs — those are only used client-side.
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = (_blob) => 'blob:sw-stub/unavailable';
    URL.revokeObjectURL = (_url)  => {};
  }

  importScripts(BUNDLE_URL);
  bundleLoaded = true;
}

// ─── Install — load bundle here so globals are ready ───────────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    ensureBundle();
    await self.skipWaiting();
  })());
});

// ─── Activate — take control of all clients immediately ────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// ─── Message — receive config sent by index.html after registration ─────────
self.addEventListener('message', async event => {
  if (event.data?.type !== 'init') return;
  if (!fetchHandler) {
    await setupFetchHandler(event.data.config);
  }
  event.source?.postMessage({ type: 'scramjet-sw-ready' });
});

// ─── ScramjetFetchHandler initialisation ────────────────────────────────────
async function setupFetchHandler(cfg) {
  ensureBundle();

  const {
    ScramjetFetchHandler,
    ScramjetHeaders,
    CookieJar,
    defaultConfig,
    setWasm,
  } = self.$scramjet;

  // Initialise the WASM rewriter
  const wasmResp = await fetch(cfg?.wasm ?? WASM_URL);
  setWasm(new Uint8Array(await wasmResp.arrayBuffer()));

  cookieJar = new CookieJar();

  // The proxy prefix URL (resolved against the SW's own origin)
  const prefix = new URL(cfg?.prefix ?? SCRAMJET_PREFIX, self.location.href);

  // Build the context that ScramjetFetchHandler and the rewriters share
  const context = {
    config: defaultConfig,
    prefix,
    interface: {
      codecEncode: codec.encode,
      codecDecode: codec.decode,

      // Scripts injected into every proxied HTML page (head element)
      getInjectScripts(_meta, _domHandler, _htmlCtx, scriptElem) {
        return [
          scriptElem(`${prefix.origin}${BUNDLE_URL}`),
          scriptElem(`${prefix.origin}/scramjet/scramjet-client-init.js`),
        ];
      },

      // Preamble prepended to every proxied worker script
      getWorkerInjectScripts(_meta, _isModule, scriptLine) {
        return scriptLine(`${prefix.origin}${BUNDLE_URL}`);
      },
    },
    cookieJar,
  };

  // Build the HTTP bare transport (routes through the server-side /bare/ endpoint)
  const transport = makeBareTransport();

  fetchHandler = new ScramjetFetchHandler({
    transport,
    context,
    crossOriginIsolated: false,
    sendSetCookie: async cookies => {
      for (const { url, cookie } of cookies) {
        cookieJar.setCookies(cookie, new URL(url));
      }
    },
    fetchDataUrl: url => fetch(url),
    fetchBlobUrl: url => fetch(url),
  });
}

// ─── Bare HTTP transport — proxies through /bare/ on the Express server ─────
function makeBareTransport() {
  return {
    ready: false,

    async init() { this.ready = true; },

    async request(url, method, body, headers) {
      // Flatten headers into a plain object
      const rawHeaders = {};
      if (headers) {
        for (const [k, v] of headers) rawHeaders[k] = v;
      }

      const resp = await fetch(BARE_URL, {
        method: 'POST',
        headers: {
          'X-Bare-URL':         url.href,
          'X-Bare-Method':      method,
          'X-Bare-Headers':     JSON.stringify(rawHeaders),
          'Content-Type':       'application/octet-stream',
        },
        body: (body && method !== 'GET' && method !== 'HEAD') ? body : null,
      });

      const status     = parseInt(resp.headers.get('X-Bare-Status') ?? String(resp.status), 10);
      const statusText = resp.headers.get('X-Bare-Status-Text') ?? resp.statusText ?? '';
      let rawResp = {};
      try { rawResp = JSON.parse(resp.headers.get('X-Bare-Headers') ?? '{}'); } catch { /* ignore */ }

      return {
        status,
        statusText,
        headers:    rawResp,
        rawHeaders: Object.entries(rawResp),
        body:       resp.body,
        url:        url.href,
        redirected: false,
      };
    },

    // WebSocket passthrough — best-effort direct connection
    connect(url, protocols, _headers, onopen, onmessage, onclose, onerror) {
      let ws;
      try {
        ws = new WebSocket(url, protocols);
        ws.binaryType = 'arraybuffer';
        ws.onopen    = () => onopen('', '');
        ws.onmessage = e  => onmessage(e.data);
        ws.onclose   = e  => onclose(e.code, e.reason);
        ws.onerror   = () => onerror();
      } catch (e) { onerror(e); }
      const send  = data         => ws?.readyState === 1 && ws.send(data);
      const close = (code, rsn) => ws?.close(code, rsn);
      return [send, close];
    },
  };
}

// ─── Fetch event — intercept only scramjet-prefixed requests ────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle requests that fall under the proxy prefix
  if (!url.pathname.startsWith(SCRAMJET_PREFIX)) return;
  if (!fetchHandler) return;   // handler not ready yet → let browser handle

  event.respondWith(handleProxiedFetch(event));
});

async function handleProxiedFetch(event) {
  const req = event.request;
  const { ScramjetHeaders } = self.$scramjet;

  try {
    // Build the raw-request object ScramjetFetchHandler expects
    const rawRequest = {
      rawUrl:         new URL(req.url),
      body:           req.body ?? null,
      method:         req.method,
      clientId:       event.clientId ?? '',
      rawReferrer:    req.referrer ? safeUrl(req.referrer) : undefined,
      rawClientUrl:   undefined,
      rawDestination: req.destination ?? '',
      initialHeaders: ScramjetHeaders.fromNativeHeaders(req.headers),
    };

    const result = await fetchHandler.handleFetch(rawRequest);
    if (!result) return errorResponse('Empty proxy result', 502);

    // Convert ScramjetHeaders → native Headers
    const nativeHeaders = result.headers?.toNativeHeaders
      ? result.headers.toNativeHeaders()
      : new Headers(Object.entries(result.headers?.headers ?? {}));

    return new Response(result.body, {
      status:     result.status,
      statusText: result.statusText,
      headers:    nativeHeaders,
    });
  } catch (err) {
    console.error('[Scramjet SW] Fetch error:', err);
    return errorResponse(`Scramjet error: ${err.message}`, 500);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function safeUrl(str) { try { return new URL(str); } catch { return undefined; } }
function errorResponse(msg, status) {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}
