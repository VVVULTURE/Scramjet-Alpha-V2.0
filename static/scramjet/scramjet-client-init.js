// ═══════════════════════════════════════════════════════════════════════════
//  scramjet-client-init.js
//  Injected into every proxied HTML page to set up the ScramjetClient that
//  hooks browser APIs (fetch, XHR, WebSocket, eval, etc.) so all outgoing
//  requests are transparently redirected through the proxy prefix.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // Wait until $scramjet is populated by scramjet_bundled.js, then init.
  function whenReady(cb) {
    if (typeof self !== 'undefined' && self.$scramjet) return cb();
    if (typeof document !== 'undefined') {
      document.currentScript?.closest('head')
        ? document.addEventListener('DOMContentLoaded', () => cb(), { once: true })
        : cb();
    }
  }

  // XOR codec — must stay in sync with the SW and index.html
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

  const SCRAMJET_PREFIX = '/scramjet~/';
  const origin          = self.location.origin;

  function init() {
    const {
      ScramjetClient,
      CookieJar,
      setWasm,
      defaultConfig,
      versionInfo,
    } = self.$scramjet;

    // The prefix URL (same as the SW — both must agree)
    const prefix = new URL(SCRAMJET_PREFIX, origin);

    // Minimal bare transport.
    // HTTP requests are handled by the service worker (they never reach this
    // transport directly).  This transport only matters for WebSocket
    // connections initiated inside the proxied page.
    const transport = {
      ready: true,
      async init() {},
      // Best-effort direct WebSocket connection.
      // For proper WS proxying through wisp, replace this with a wisp client.
      connect(url, protocols, _headers, onopen, onmessage, onclose, onerror) {
        let ws;
        try {
          ws = new WebSocket(url, protocols);
          ws.binaryType  = 'arraybuffer';
          ws.onopen      = () => onopen('', '');
          ws.onmessage   = e  => onmessage(e.data);
          ws.onclose     = e  => onclose(e.code, e.reason);
          ws.onerror     = () => onerror();
        } catch (err) { onerror(err); }
        const send  = data        => ws?.readyState === 1 && ws.send(data);
        const close = (code, rsn) => ws?.close(code, rsn);
        return [send, close];
      },
    };

    const context = {
      config: defaultConfig,
      prefix,
      interface: {
        codecEncode: codec.encode,
        codecDecode: codec.decode,
        getInjectScripts(_meta, _dom, _ctx, scriptElem) {
          return [
            scriptElem(`${origin}/scramjet/scramjet_bundled.js`),
            scriptElem(`${origin}/scramjet/scramjet-client-init.js`),
          ];
        },
        getWorkerInjectScripts(_meta, _isModule, scriptLine) {
          return scriptLine(`${origin}/scramjet/scramjet_bundled.js`);
        },
      },
      cookieJar: new CookieJar(),
    };

    try {
      const client = new ScramjetClient(window, {
        transport,
        context,
        history:     [],
        initHeaders: [],
      });
      client.hook();

      // Load WASM asynchronously so dynamic eval-rewriting works
      fetch('/scramjet/scramjet.wasm')
        .then(r => r.arrayBuffer())
        .then(buf => setWasm(new Uint8Array(buf)))
        .catch(err => console.warn('[Scramjet client] WASM load failed:', err));

      if (typeof versionInfo !== 'undefined') {
        console.debug('[Scramjet client] initialised v' + versionInfo.version);
      }
    } catch (err) {
      console.error('[Scramjet client] init error:', err);
    }
  }

  whenReady(init);
})();
