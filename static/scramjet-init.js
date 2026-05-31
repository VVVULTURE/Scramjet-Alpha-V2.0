// ─────────────────────────────────────────────────────────────────────────────
// scramjet-init.js — client-side Scramjet initialisation
// ─────────────────────────────────────────────────────────────────────────────
//
// KEY CHANGES vs. the original:
//
//   1. The service worker is now registered at '/sw.js' (project root), NOT
//      '/scramjet/scramjet.js'.
//
//      A script at /scramjet/scramjet.js can only control URLs under
//      /scramjet/ unless the server sends a special Service-Worker-Allowed
//      header.  A script at /sw.js sits at the root, so claiming scope '/'
//      works with zero server configuration.
//
//   2. files.all still points to '/scramjet/scramjet.js' — the Scramjet
//      controller uses this to know what the worker bundle URL is.  The
//      bundle itself is untouched and served at the same path.
// ─────────────────────────────────────────────────────────────────────────────

(async function initScramjet () {

  // Determine Wisp WebSocket URL from current protocol + host.
  const wispUrl =
    (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host + '/wisp/';

  // ScramjetController is exposed by scramjet_bundled.js (already loaded by
  // index.html before this script runs).
  if (typeof $scramjetLoadController !== 'function') {
    console.error('[scramjet-init] $scramjetLoadController not found — ' +
                  'make sure scramjet_bundled.js is loaded before this script.');
    return;
  }

  const { ScramjetController } = $scramjetLoadController();

  const controller = new ScramjetController({
    // URL prefix Scramjet uses to identify proxied requests.
    prefix: '/scramjet/proxy/',

    // Paths the service worker needs to know about.
    files: {
      wasm: '/scramjet/scramjet.wasm',   // WASM URL rewriter
      all:  '/scramjet/scramjet.js',     // worker bundle (imported by sw.js)
      sync: '/scramjet/scramjet.js',     // sync XHR worker (optional)
    },

    // XOR codec — keeps encoded URLs from being trivially readable.
    codec: {
      encode (url) {
        if (!url) return url;
        let out = '';
        for (let i = 0; i < url.length; i++) {
          out += String.fromCharCode(url.charCodeAt(i) ^ 2);
        }
        return encodeURIComponent(out);
      },
      decode (encoded) {
        if (!encoded) return encoded;
        const raw = decodeURIComponent(encoded);
        let out = '';
        for (let i = 0; i < raw.length; i++) {
          out += String.fromCharCode(raw.charCodeAt(i) ^ 2);
        }
        return out;
      }
    }
  });

  // ── Register the service worker ──────────────────────────────────────────
  //
  // /sw.js is at the root, so the browser allows it to control scope '/'.
  // No Service-Worker-Allowed server header is required.
  //
  // Previously this was '/scramjet/scramjet.js', which caused:
  //   SecurityError: scope '/' not under max scope '/scramjet/'
  await controller.init('/sw.js');

  // ── Set up BareMux / Wisp transport ─────────────────────────────────────
  //
  // BareMux routes all proxy traffic through our Wisp WebSocket server
  // instead of needing a separate public bare server.
  if (typeof BareMux !== 'undefined') {
    try {
      const conn = new BareMux.BareMuxConnection('/scramjet/baremux.js');
      await conn.setTransport('/scramjet/wisp-transport.js', [wispUrl]);
    } catch (err) {
      console.warn('[scramjet-init] BareMux transport setup failed:', err);
    }
  }

  // Expose controller so index.html search/navigation handler can use it.
  window._scramjetController = controller;

  // ── Search / navigation form ─────────────────────────────────────────────
  const form  = document.getElementById('search-form');
  const input = document.getElementById('search-input');

  if (form && input) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;

      let url;
      try {
        url = new URL(query);
      } catch {
        const looksLikeHost =
          /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(query);
        url = looksLikeHost
          ? new URL('https://' + query)
          : new URL('https://www.google.com/search?q=' +
                    encodeURIComponent(query));
      }

      location.href = controller.encodeUrl(url.href);
    });
  }

}());
