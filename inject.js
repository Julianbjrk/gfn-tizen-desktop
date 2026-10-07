/*
 * gfn-tizen-desktop v0.3.0 — TizenBrew "mods" module (MIT)
 *
 * Runs the GeForce NOW web client (play.geforcenow.com) on a Samsung Tizen TV
 * while presenting itself as Chrome on Windows. The on-screen diagnostics
 * panel is in Swedish for its only user; code and comments are in English.
 *
 * How it runs: TizenBrew evaluates this file (CDP Runtime.evaluate) whenever a
 * document creates its JS context. That is asynchronous, so GFN's own scripts
 * may run first — and GFN detects the platform exactly once at start-up.
 * Therefore the module starts on play.geforcenow.com/robots.txt (a tiny text
 * file with no GFN scripts), applies the identity there, then fetches GFN's
 * index.html and writes it into the same window. GFN's scripts always run
 * after the spoof. A GFN page loaded directly with a late injection restarts
 * through robots.txt (rate limited, never with OAuth codes in the URL).
 *
 * Sections: config · state · log · identity · boot · webpack hook (GFN verdict,
 * 4K override) · WebRTC stats · mouse · overlay · events · start.
 *
 * It does not change games, automate input or touch HTTP headers.
 */
(function () {
  'use strict';

  if (window.__gfnTizenDesktop) { return; }

  // Read first: how far the page had got when TizenBrew injected us.
  var injectedAt = {
    ms: (window.performance && performance.now) ? Math.round(performance.now()) : -1,
    readyState: document.readyState,
    scripts: document.scripts ? document.scripts.length : 0
  };
  var lateInjection = injectedAt.readyState !== 'loading';

  /* ================================================================ config */

  var VERSION = '0.3.0';
  var GFN_HOST = 'play.geforcenow.com';
  var GFN_APP_PATH = '/mall/';        // where GFN's index.html is served
  var BOOT_PATH = '/robots.txt';      // small text file on the GFN origin
  var BOOT_KEY = 'gfn-tizen-boot';    // #gfn-tizen-boot=<path to show>
  var STORAGE = { reboots: 'gfnTizen.reboots', force4k: 'gfnTizen.force4k' };

  var CONFIG = {
    spoof: true,                      // present as Chrome on Windows
    hideTizenGlobals: true,           // hide Samsung's globals (GFN looks for them)
    spoofWorkers: true,               // same identity inside GFN's blob workers
    spoofPointerMedia: true,          // desktop answers for (hover)/(pointer) media queries
    bootViaRobots: true,              // load GFN ourselves after the spoof (see header)
    windowsPlatformVersion: '15.0.0', // Windows 11 in client hints
    mouse: {
      fix: true,                      // repair drags: synthesize missing button events
      blockNativeDrag: true,          // no text selection / drag-and-drop in the stream
      traceLength: 24                 // raw pointer events kept for the panel
    },
    force4k: {
      preferred: ['H265', 'AV1'],     // first codec the TV's WebRTC offers wins
      overrideData: 'force4kbrowser=1'
    },
    keys: { blue: 406, red: 403, green: 404 }, // ColorF3Blue, ColorF0Red, ColorF1Green
    overlay: { autoShowMs: 20000, maxLogLines: 60, shownLogLines: 10 }
  };

  // Globals that reveal Tizen (superset of what GFN's detector probes).
  var TIZEN_GLOBALS = ['tizen', 'webapis', 'b2bapis', 'TizenTVApiInfo', 'addEdgeEffectONSCROLLTizenUIF', 'tizentvwasm'];
  var AUTH_PARAMS = ['code', 'state', 'token', 'id_token', 'access_token', 'session_state'];

  /* ================================================================= state */

  var isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  var nav = window.navigator;
  var realUA = String(nav.userAgent || '');
  // Tizen writes "(KHTML, like Gecko) 120.0.6099.5/9.0 TV" without "Chrome/".
  var chromeMatch = /(?:Chrome\/|like Gecko\) )(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(realUA);
  var major = chromeMatch ? chromeMatch[1] : '120';
  var fullVersion = (chromeMatch && chromeMatch[2]) ? (major + '.' + chromeMatch[2]) : (major + '.0.0.0');
  var spoofUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';

  var logLines = [];                 // { text, count, time }
  var real = null;                   // identity before spoofing
  var hidden = {};                   // stashed Tizen globals
  var hiddenNames = [];
  var pluginNote = '';
  var workerCount = { Worker: 0, SharedWorker: 0 };
  var startNote = '';
  var sdk = null;                    // GFN's Ragnarok SDK module exports, once seen
  var verdict = null;                // GFN's own platform verdict
  var force4k = { wanted: false, applied: '', codec: '' };
  var peers = [];                    // RTCPeerConnections GFN created
  var stream = { text: '', lastAt: 0 };
  var mouse = {
    moves: 0, lastClick: null, lastKey: null,
    trace: [], down: {},             // down[button] = { t, moves }
    native: 0,                       // bitmask of buttons with a native mousedown seen
    synth: 0,                        // bitmask of buttons we synthesized mousedown for
    fixes: 0, swallowed: 0, lastDrag: '',
    wheel: false, logged: 0,         // first few button events are logged verbosely
    pending: {},                     // pending[button] = timer for a withheld release
    lock: ''                         // last pointer lock event / error
  };
  var sdkId = null;                  // webpack module id of the Ragnarok SDK
  var synthetic = (typeof WeakSet === 'function') ? new WeakSet() : null;
  var overlay = { el: null, visible: false, hideTimer: null, pollTimer: null };
  var unsupportedSeen = false;

  window.__gfnTizenDesktop = {
    version: VERSION,
    config: CONFIG,
    diag: function () { return diagText(); },
    log: function () { return logLines.map(lineText); },
    trace: function () { return mouse.trace.slice(); }
  };

  /* =================================================================== log */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function tzLabel() {
    var m = -new Date().getTimezoneOffset();
    return 'UTC' + (m >= 0 ? '+' : '-') + Math.floor(Math.abs(m) / 60) + (m % 60 ? ':' + pad2(Math.abs(m) % 60) : '');
  }
  function fmt(v) {
    if (typeof v === 'string') { return v; }
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.substr(0, n - 1) + '…' : s; }
  function lineText(l) { return clock(l.time) + ' ' + l.text + (l.count > 1 ? '  ×' + l.count : ''); }

  // Repeated messages collapse into one line with a counter.
  function log() {
    var text = Array.prototype.slice.call(arguments).map(fmt).join(' ');
    var last = logLines[logLines.length - 1];
    if (last && last.text === text) {
      last.count += 1;
      last.time = new Date();
    } else {
      logLines.push({ text: text, count: 1, time: new Date() });
      if (logLines.length > CONFIG.overlay.maxLogLines) { logLines.shift(); }
    }
    try { console.log('[gfn-tizen] ' + text); } catch (e) { /* ignore */ }
    if (overlay.visible) { renderOverlay(); }
  }

  // OAuth codes must never end up in logs, photos or reboot targets.
  function stripAuth(url) {
    return String(url).replace(/([?#&])([^#&=]+)=([^#&]*)/g, function (m, sep, key) {
      return AUTH_PARAMS.indexOf(key.toLowerCase()) === -1 ? m : sep + key + '=…';
    });
  }
  function hasAuthParams(url) {
    return new RegExp('[?&#](' + AUTH_PARAMS.join('|') + ')=', 'i').test(String(url));
  }

  /* ============================================================== identity */

  function readRealIdentity() {
    var r = { platform: '', uaData: '', globals: [] };
    try { r.platform = String(nav.platform || ''); } catch (e) { /* ignore */ }
    try {
      var d = nav.userAgentData;
      r.uaData = d ? (d.platform || '""') + ' / ' + (d.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(', ') : 'saknas';
    } catch (e) { r.uaData = 'fel'; }
    TIZEN_GLOBALS.forEach(function (n) {
      try { if (n in window) { r.globals.push(n); } } catch (e) { /* ignore */ }
    });
    return r;
  }

  function defineGetter(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, { get: getter, configurable: true, enumerable: true });
      return true;
    } catch (e) {
      log('kunde inte ersätta ' + prop + ': ' + e.message);
      return false;
    }
  }

  // Client-hint values, shared by the page and its workers.
  function uaDataValues() {
    var brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major }
    ];
    return {
      brands: brands,
      high: {
        architecture: 'x86', bitness: '64', brands: brands,
        fullVersionList: [
          { brand: 'Not_A Brand', version: '8.0.0.0' },
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Google Chrome', version: fullVersion }
        ],
        mobile: false, model: '', platform: 'Windows',
        platformVersion: CONFIG.windowsPlatformVersion,
        uaFullVersion: fullVersion, wow64: false, formFactors: ['Desktop']
      }
    };
  }

  // Also serialized into workers: keep it self-contained (no closures).
  function buildUAData(v, UADataCtor) {
    var data = {
      brands: v.brands, mobile: false, platform: 'Windows',
      getHighEntropyValues: function (hints) {
        var out = { brands: v.brands, mobile: false, platform: 'Windows' };
        (Array.isArray(hints) ? hints : []).forEach(function (h) {
          if (Object.prototype.hasOwnProperty.call(v.high, h)) { out[h] = v.high[h]; }
        });
        return Promise.resolve(out);
      },
      toJSON: function () { return { brands: v.brands, mobile: false, platform: 'Windows' }; }
    };
    // Let instanceof checks pass; own properties shadow the native getters.
    try { if (UADataCtor && UADataCtor.prototype) { Object.setPrototypeOf(data, UADataCtor.prototype); } } catch (e) { /* ignore */ }
    return data;
  }

  // The "PPAPI SAMSUNGHEALTH" plugin alone makes GFN conclude Tizen.
  function filteredPlugins() {
    var all = Array.prototype.slice.call(nav.plugins || []);
    var kept = all.filter(function (p) { return !/^PPAPI SAMSUNG/i.test(p.name); });
    if (kept.length === all.length) { return null; }
    var list = {};
    kept.forEach(function (p, i) { list[i] = p; });
    list.length = kept.length;
    list.item = function (i) { return kept[i] || null; };
    list.namedItem = function (n) { return kept.filter(function (p) { return p.name === n; })[0] || null; };
    list.refresh = function () {};
    list[Symbol.iterator] = function () { return kept[Symbol.iterator](); };
    try { if (window.PluginArray) { Object.setPrototypeOf(list, window.PluginArray.prototype); } } catch (e) { /* ignore */ }
    pluginNote = (all.length - kept.length) + ' Samsung-plugin dolt';
    return list;
  }

  function applySpoof() {
    var proto = Object.getPrototypeOf(nav);
    var uaData = buildUAData(uaDataValues(), window.NavigatorUAData);
    var plugins = filteredPlugins();
    var props = {
      userAgent: function () { return spoofUA; },
      appVersion: function () { return spoofUA.replace(/^Mozilla\//, ''); },
      platform: function () { return 'Win32'; },
      vendor: function () { return 'Google Inc.'; },
      maxTouchPoints: function () { return 0; },
      userAgentData: function () { return uaData; }
    };
    if (plugins) { props.plugins = function () { return plugins; }; }
    Object.keys(props).forEach(function (p) {
      defineGetter(proto, p, props[p]);
      if (Object.prototype.hasOwnProperty.call(nav, p)) { defineGetter(nav, p, props[p]); }
    });
    log('spoof ' + (nav.userAgent === spoofUA ? 'aktiv' : 'MISSLYCKADES') + ' (Chromium ' + major + ')');
  }

  // GFN's detector classifies by (hover)/(pointer) media queries; a TV with a
  // mouse must still look like a desktop with a fine pointer.
  function spoofPointerMedia() {
    var realMatch = window.matchMedia;
    if (typeof realMatch !== 'function') { return; }
    var answers = [
      [/^\(\s*(any-)?hover\s*:\s*hover\s*\)$/, true],
      [/^\(\s*(any-)?hover\s*:\s*none\s*\)$/, false],
      [/^\(\s*(any-)?pointer\s*:\s*fine\s*\)$/, true],
      [/^\(\s*(any-)?pointer\s*:\s*(coarse|none)\s*\)$/, false]
    ];
    window.matchMedia = function (query) {
      var mql = realMatch.call(window, query);
      try {
        var q = String(query).trim().toLowerCase();
        answers.some(function (a) {
          if (!a[0].test(q)) { return false; }
          Object.defineProperty(mql, 'matches', { value: a[1], configurable: true });
          return true;
        });
      } catch (e) { /* ignore */ }
      return mql;
    };
  }

  function hideGlobals() {
    TIZEN_GLOBALS.forEach(function (name) {
      var had;
      try { had = name in window; } catch (e) { had = false; }
      if (!had) { return; }
      try { hidden[name] = window[name]; } catch (e) { /* ignore */ }
      // Ideally gone (GFN also tests with "in"), otherwise an undefined getter.
      try { delete window[name]; } catch (e) { /* ignore */ }
      var still;
      try { still = name in window; } catch (e) { still = true; }
      if (still) {
        try {
          Object.defineProperty(window, name, {
            configurable: true,
            get: function () { return undefined; },
            set: function (v) { hidden[name] = v; }
          });
        } catch (e) {
          log('kunde inte dölja ' + name + ': ' + e.message);
          return;
        }
      }
      hiddenNames.push(name);
    });
    if (hiddenNames.length) { log('dolda Tizen-globaler: ' + hiddenNames.join(', ')); }
  }

  // Runs inside every blob worker GFN creates, before GFN's own code.
  function workerPrelude(c, build) {
    try {
      var P = self.WorkerNavigator && self.WorkerNavigator.prototype;
      if (!P) { return; }
      var def = function (p, v) {
        try { Object.defineProperty(P, p, { get: function () { return v; }, configurable: true, enumerable: true }); } catch (e) { /* ignore */ }
      };
      def('userAgent', c.ua);
      def('appVersion', c.ua.replace(/^Mozilla\//, ''));
      def('platform', 'Win32');
      def('userAgentData', build(c.v, self.NavigatorUAData));
    } catch (e) { /* ignore */ }
  }

  // GFN's detector reads navigator.platform and userAgentData inside workers
  // created from blob URLs. Prepend our prelude to each of them.
  function patchWorkers() {
    var prelude = '(' + workerPrelude.toString() + ')(' +
      JSON.stringify({ ua: spoofUA, v: uaDataValues() }) + ', ' + buildUAData.toString() + ');\n';
    var keep = {};
    var realRevoke = URL.revokeObjectURL;
    // GFN revokes its blob URL right after new Worker(); ours imports it asynchronously.
    URL.revokeObjectURL = function (u) {
      if (keep[u]) { setTimeout(function () { realRevoke.call(URL, u); }, 15000); return; }
      return realRevoke.apply(URL, arguments);
    };
    ['Worker', 'SharedWorker'].forEach(function (kind) {
      var Orig = window[kind];
      if (typeof Orig !== 'function' || typeof Proxy !== 'function') { return; }
      window[kind] = new Proxy(Orig, {
        construct: function (target, args, newTarget) {
          try {
            var u = String(args[0]);
            if (/^blob:/.test(u)) {
              var opts = args[1];
              var isModule = !!(opts && typeof opts === 'object' && opts.type === 'module');
              keep[u] = true;
              var body = prelude + (isModule ? 'import ' + JSON.stringify(u) + ';\n' : 'importScripts(' + JSON.stringify(u) + ');\n');
              var wrapped = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
              setTimeout(function () { realRevoke.call(URL, wrapped); }, 15000);
              args = [wrapped].concat(Array.prototype.slice.call(args, 1));
              workerCount[kind] += 1;
            }
          } catch (e) {
            log(kind + '-spoof misslyckades: ' + e.message);
          }
          return Reflect.construct(target, args, newTarget);
        }
      });
    });
  }

  /* ================================================================== boot */

  function isGfnOrigin() { return location.hostname === GFN_HOST; }
  function isBootDocument() { return isTop && isGfnOrigin() && location.pathname === BOOT_PATH; }

  // The path to show after booting: same origin, under /mall/, never with OAuth codes.
  function bootTarget() {
    try {
      var m = new RegExp('[#&]' + BOOT_KEY + '=([^&]*)').exec(location.hash);
      var t = m ? decodeURIComponent(m[1]) : GFN_APP_PATH;
      if (t.indexOf(GFN_APP_PATH) === 0 && !hasAuthParams(t)) { return t; }
    } catch (e) { /* malformed hash */ }
    return GFN_APP_PATH;
  }

  // At most 3 restarts per 2 minutes, so a fault never becomes a loop.
  function rebootAllowed() {
    try {
      var now = Date.now();
      var list = JSON.parse(sessionStorage.getItem(STORAGE.reboots) || '[]').filter(function (t) { return now - t < 120000; });
      if (list.length >= 3) { return false; }
      list.push(now);
      sessionStorage.setItem(STORAGE.reboots, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function rebootViaRobots(reason) {
    if (!rebootAllowed()) {
      log('för många omstarter – fortsätter utan (' + reason + ')');
      return false;
    }
    var path = location.pathname + location.search + location.hash;
    if (hasAuthParams(path)) { path = GFN_APP_PATH; }
    try { console.log('[gfn-tizen] omstart via ' + BOOT_PATH + ': ' + reason); } catch (e) { /* ignore */ }
    location.replace(BOOT_PATH + '#' + BOOT_KEY + '=' + encodeURIComponent(path));
    return true;
  }

  // After a login redirect: let GFN exchange the code first, then restart.
  function rebootAfterAuth() {
    var waited = 0;
    log('inloggningsretur – väntar tills GFN tagit emot koden');
    var timer = setInterval(function () {
      waited += 1;
      if (!hasAuthParams(location.href) || waited >= 180) {
        clearInterval(timer);
        setTimeout(function () { rebootViaRobots('efter inloggning'); }, 5000);
      }
    }, 1000);
  }

  function boot() {
    var target = bootTarget();
    startNote = 'via ' + BOOT_PATH + ' – spoof före GFN';
    log('startar GFN via ' + BOOT_PATH + ' → ' + stripAuth(target));
    fetch(GFN_APP_PATH, { credentials: 'include', cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.text();
      })
      .then(function (html) {
        history.replaceState(null, '', target);
        document.open();
        document.write(html);
        document.close();
        // document.open() drops the DOM and every listener on window.
        overlay.el = null;
        installListeners();
        onReady();
      })
      .catch(function (e) {
        log('kunde inte starta via ' + BOOT_PATH + ': ' + e.message + ' – laddar GFN direkt');
        location.replace(GFN_APP_PATH);
      });
  }

  /* ========================================================== webpack hook */

  // GFN's webpack runtime does: t = self.webpackChunkgfn_mall = self.webpackChunkgfn_mall || [];
  // t.push = n.bind(...). A pre-created array with an accessor "push" catches that
  // assignment, so every chunk registration can be observed. When the chunk that
  // defines the Ragnarok SDK arrives, a chunk of our own obtains webpack's require,
  // loads the SDK exports and applies the 4K override before GFN reads capabilities.
  function installWebpackHook() {
    if (typeof Proxy !== 'function' || Object.prototype.hasOwnProperty.call(self, 'webpackChunkgfn_mall')) { return; }
    var arr = [];
    var runtimePush = null;
    var hookCount = 0;
    function wrappedPush(chunk) {
      var result = runtimePush.apply(arr, arguments);
      try { onChunk(chunk); } catch (e) { log('webpack-hook: ' + e.message); }
      return result;
    }
    function onChunk(chunk) {
      if (sdk || !chunk || !chunk[1] || typeof chunk[1] !== 'object') { return; }
      if (!sdkId) { sdkId = findSdkId(chunk[1]); }
      if (!sdkId) { return; }
      hookCount += 1;
      arr.push([['gfn-tizen-hook-' + hookCount], {}, function (req) { adoptSdk(req, sdkId); }]);
    }
    Object.defineProperty(arr, 'push', {
      configurable: true, enumerable: false,
      get: function () { return runtimePush ? wrappedPush : Array.prototype.push; },
      set: function (fn) { runtimePush = fn; }
    });
    self.webpackChunkgfn_mall = arr;
  }

  // The SDK module is the one whose factory source assigns ConfigureRagnarokSettings.
  function findSdkId(modules) {
    return Object.keys(modules).filter(function (k) {
      try { return String(modules[k]).indexOf('ConfigureRagnarokSettings=') !== -1; } catch (e) { return false; }
    })[0] || null;
  }

  // Load the SDK exports through webpack's require. Throws if a dependency is
  // not registered yet; the hook simply tries again on the next chunk.
  function adoptSdk(req, id) {
    var R = req(id);
    if (!R || typeof R.ConfigureRagnarokSettings !== 'function') { throw new Error('modul ' + id + ' saknar ConfigureRagnarokSettings'); }
    sdk = R;
    log('GFN:s SDK hittad (modul ' + id + ')');
    applyForce4k();
  }

  // Fallback when the page was not booted by us: find the SDK in the live runtime.
  function findSdkLate() {
    var q = self.webpackChunkgfn_mall;
    if (sdk || !q || typeof q.push !== 'function') { return; }
    q.push([['gfn-tizen-late-probe'], {}, function (req) {
      var id = sdkId || findSdkId(req.m || {});
      if (id) { adoptSdk(req, id); }
    }]);
  }

  function force4kWanted() {
    try { return localStorage.getItem(STORAGE.force4k) === '1'; } catch (e) { return false; }
  }

  // Codec for the 4K override: the first preferred codec the TV's WebRTC offers.
  function pick4kCodec() {
    var offered = getVideoCodecs().split(', ');
    return CONFIG.force4k.preferred.filter(function (c) { return offered.indexOf(c) !== -1; })[0] || '';
  }

  // GFN only offers 3840×2160 in browsers for H265/AV1 and only with
  // force4kbrowser (or NVIDIA's remote flag plus a decoder check). Keys absent
  // from later ConfigureRagnarokSettings calls keep our values.
  function applyForce4k() {
    if (!force4k.wanted || !sdk) { return; }
    var codec = pick4kCodec();
    if (!codec) {
      force4k.applied = 'avbrutet: TV:ns WebRTC saknar ' + CONFIG.force4k.preferred.join('/');
      log('4K-läge: ' + force4k.applied);
      return;
    }
    var data = 'codeclist=' + codec + ',H264&' + CONFIG.force4k.overrideData;
    try {
      sdk.ConfigureRagnarokSettings({ overrideData: data });
      force4k.codec = codec;
      force4k.applied = 'aktivt (' + data + ')';
      log('4K-läge aktivt: ' + data + ' – välj Custom → 3840×2160 i GFN:s inställningar');
    } catch (e) {
      force4k.applied = 'fel: ' + e.message;
      log('4K-läge misslyckades: ' + e.message);
    }
  }

  function toggleForce4k() {
    var next = !force4k.wanted;
    try { localStorage.setItem(STORAGE.force4k, next ? '1' : '0'); } catch (e) { log('kan inte spara 4K-valet: ' + e.message); return; }
    force4k.wanted = next;
    showOverlay(0);
    if (streamVideo()) {
      log('4K-läge ' + (next ? 'PÅ' : 'AV') + ' – gäller från nästa start (avsluta strömmen och starta om GFN Desktop)');
      return;
    }
    log('4K-läge ' + (next ? 'PÅ' : 'AV') + ' – startar om om 3 s');
    setTimeout(function () { rebootViaRobots('4K-läge ' + (next ? 'på' : 'av')); }, 3000);
  }

  // Ask GFN's detector what it concluded. Read-only: getPlatformDetails() is
  // cached and already computed by GFN.
  function probeGfnVerdict() {
    if (!sdk) { try { findSdkLate(); } catch (e) { log('SDK-sökning: ' + e.message); } }
    if (!sdk || typeof sdk.getPlatformDetails !== 'function') { verdict = sdk ? 'detektorn saknar getPlatformDetails' : 'GFN:s SDK inte sedd'; return; }
    try {
      sdk.getPlatformDetails().then(function (d) {
        var ok;
        try { ok = sdk.IsFeatureSupported(sdk.BrowserFeature.Streaming, d); } catch (e) { ok = '?'; }
        verdict = [
          d.os + ' / ' + d.browser + ' ' + (d.browserVer || ''),
          d.platformType || d.deviceType,
          'säkerhet ' + d.confidence,
          d.spoofing ? 'SPOOF UPPTÄCKT' : '',
          d.forging ? 'forging' : '',
          'strömning ' + (ok === true ? 'ja' : ok === false ? 'NEJ' : ok)
        ].filter(Boolean).join(', ');
        log('GFN-beslut: ' + verdict);
      }, function (e) { verdict = 'fel: ' + e; });
    } catch (e) {
      verdict = 'fel: ' + e.message;
    }
  }

  /* ========================================================== WebRTC stats */

  // Keep every RTCPeerConnection GFN creates, so the panel can show what the
  // stream actually delivers (resolution, fps, codec, delays).
  function patchPeerConnection() {
    var Orig = window.RTCPeerConnection;
    if (typeof Orig !== 'function' || typeof Proxy !== 'function') { return; }
    window.RTCPeerConnection = new Proxy(Orig, {
      construct: function (target, args, newTarget) {
        var pc = Reflect.construct(target, args, newTarget);
        peers.push(pc);
        if (peers.length > 4) { peers.shift(); }
        log('WebRTC-anslutning skapad');
        return pc;
      }
    });
  }

  function activePeer() {
    for (var i = peers.length - 1; i >= 0; i--) {
      var s = peers[i].connectionState;
      if (s === 'connected' || s === 'connecting' || s === 'new') { return peers[i]; }
    }
    return null;
  }

  function ms(x) { return x === undefined ? '?' : Math.round(x * 1000) + ' ms'; }

  function refreshStreamStats() {
    var pc = activePeer();
    if (!pc) { stream.text = ''; return; }
    if (Date.now() - stream.lastAt < 900) { return; }
    stream.lastAt = Date.now();
    pc.getStats().then(function (report) {
      var inbound = null, byId = {};
      report.forEach(function (s) { byId[s.id] = s; });
      report.forEach(function (s) {
        if (s.type === 'inbound-rtp' && s.kind === 'video' && (!inbound || (s.framesDecoded || 0) > (inbound.framesDecoded || 0))) { inbound = s; }
      });
      if (!inbound) { stream.text = 'ingen videoström än (' + pc.connectionState + ')'; return; }
      var codec = byId[inbound.codecId];
      var transport = byId[inbound.transportId];
      var pair = transport && byId[transport.selectedCandidatePairId];
      var decode = inbound.framesDecoded ? (inbound.totalDecodeTime || 0) / inbound.framesDecoded : undefined;
      var buffer = inbound.jitterBufferEmittedCount ? (inbound.jitterBufferDelay || 0) / inbound.jitterBufferEmittedCount : undefined;
      stream.text = [
        (inbound.frameWidth || '?') + '×' + (inbound.frameHeight || '?') + ' @ ' + (inbound.framesPerSecond || '?') + ' fps',
        codec ? String(codec.mimeType || '').replace(/^video\//, '') : '?',
        'RTT ' + (pair ? ms(pair.currentRoundTripTime) : '?'),
        'buffert ' + ms(buffer),
        'avkodning ' + ms(decode) + (inbound.decoderImplementation ? ' (' + trunc(inbound.decoderImplementation, 18) + ')' : ''),
        'tappade ' + (inbound.framesDropped || 0) + ', förlorade paket ' + (inbound.packetsLost || 0)
      ].join(', ');
    }).catch(function (e) { stream.text = 'getStats: ' + e.message; });
  }

  /* ================================================================= mouse */

  function streamVideo() { return document.getElementById('remote-video'); }
  function isSynthetic(e) { return !!(synthetic && synthetic.has(e)); }
  function buttonBit(button) { return button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : button === 3 ? 8 : button === 4 ? 16 : 0; }
  function bitButton(bit) { return bit === 1 ? 0 : bit === 2 ? 2 : bit === 4 ? 1 : bit === 8 ? 3 : 4; }

  function trace(e, note) {
    if (mouse.trace.length >= CONFIG.mouse.traceLength) { mouse.trace.shift(); }
    mouse.trace.push({
      t: Math.round(e.timeStamp), type: e.type, button: e.button, buttons: e.buttons,
      dx: e.movementX, dy: e.movementY, x: e.clientX, y: e.clientY,
      target: e.target && e.target.tagName ? e.target.tagName.toLowerCase() + (e.target.id ? '#' + e.target.id : '') : '?',
      trusted: e.isTrusted, note: note || ''
    });
  }

  // Dispatch a mouse event the way the SDK's listeners on #remote-video expect it.
  function synthesize(type, button, from, target) {
    var ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: button, buttons: from.buttons,
      clientX: from.clientX, clientY: from.clientY, screenX: from.screenX, screenY: from.screenY,
      movementX: 0, movementY: 0,
      ctrlKey: from.ctrlKey, shiftKey: from.shiftKey, altKey: from.altKey, metaKey: from.metaKey
    });
    if (synthetic) { synthetic.add(ev); }
    mouse.fixes += 1;
    (target || from.target || document).dispatchEvent(ev);
  }

  function describeDrag(button, info, endReason) {
    var held = Math.round(performance.now() - info.t);
    mouse.lastDrag = 'knapp ' + button + ': ' + info.moves + ' rörelser (' + info.dx + ',' + info.dy + ' px) under ' + held + ' ms → ' + endReason;
  }

  function noteButton(text) {
    mouse.logged += 1;
    if (mouse.logged <= 12) { log(text); }
    else if (mouse.logged === 13) { log('(fler musknappshändelser loggas inte; se raden Mushändelser)'); }
  }

  function clearPending(button) {
    if (mouse.pending[button]) { clearTimeout(mouse.pending[button]); delete mouse.pending[button]; }
  }

  function onMouseDown(e) {
    if (isSynthetic(e)) { trace(e, 'synt'); return; }
    var bit = buttonBit(e.button);
    clearPending(e.button);
    // A native press for a button we already synthesized: keep the bookkeeping,
    // but do not let the SDK see a second press.
    if (mouse.synth & bit) {
      trace(e, 'dubblett');
      mouse.synth &= ~bit;
      mouse.native |= bit;
      e.stopImmediatePropagation();
      return;
    }
    trace(e);
    mouse.native |= bit;
    mouse.down[e.button] = { t: performance.now(), moves: 0, dx: 0, dy: 0 };
    mouse.lastClick = describe(e.target) + ' @' + e.clientX + ',' + e.clientY;
    noteButton('musknapp ' + e.button + ' ned (buttons=' + e.buttons + ') på ' + mouse.lastClick);
  }

  function finishButton(button, reason) {
    var bit = buttonBit(button);
    mouse.native &= ~bit;
    mouse.synth &= ~bit;
    var info = mouse.down[button];
    if (info) { describeDrag(button, info, reason); delete mouse.down[button]; }
  }

  function onMouseUp(e) {
    if (isSynthetic(e)) { trace(e, 'synt'); return; }
    var bit = buttonBit(e.button);
    // Quirk guard: a release reported while the bitmask still says "held" is
    // withheld. If no movement confirms the hold within 400 ms, the release is
    // delivered anyway, so a button can never stay stuck.
    if (CONFIG.mouse.fix && (e.buttons & bit) && streamVideo()) {
      trace(e, 'svald');
      mouse.swallowed += 1;
      e.stopImmediatePropagation();
      e.preventDefault();
      armPendingRelease(e);
      return;
    }
    trace(e);
    clearPending(e.button);
    finishButton(e.button, 'släppt');
    noteButton('musknapp ' + e.button + ' upp (buttons=' + e.buttons + ')');
  }

  function armPendingRelease(e) {
    clearPending(e.button);
    var snapshot = { buttons: e.buttons & ~buttonBit(e.button), clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    mouse.pending[e.button] = setTimeout(function () {
      delete mouse.pending[e.button];
      if (!(mouse.native & buttonBit(e.button))) { return; }
      finishButton(e.button, 'släppt efter väntan');
      synthesize('mouseup', e.button, snapshot, streamVideo());
    }, 400);
  }

  function onMove(e) {
    if (isSynthetic(e)) { return; }
    mouse.moves += 1;
    if (mouse.moves === 1) { log('första mushändelse (' + e.clientX + ',' + e.clientY + ')'); }
    Object.keys(mouse.down).forEach(function (b) {
      var info = mouse.down[b];
      info.moves += 1;
      info.dx += e.movementX || 0;
      info.dy += e.movementY || 0;
    });
    var involved = e.buttons || mouse.native || mouse.synth;
    if (!involved) { return; }
    if (e.type !== 'pointerrawupdate') { trace(e); }
    // Movement with the button still held confirms a withheld release was spurious.
    Object.keys(mouse.pending).forEach(function (b) { if (e.buttons & buttonBit(+b)) { armPendingRelease({ button: +b, buttons: e.buttons, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY }); } });
    if (!CONFIG.mouse.fix || !streamVideo()) { return; }
    // Reconcile: bits present in the bitmask without a mousedown get one;
    // bits we synthesized that disappeared get a mouseup.
    var known = mouse.native | mouse.synth;
    var missing = e.buttons & ~known;
    var released = mouse.synth & ~e.buttons;
    var video = streamVideo();
    [1, 2, 4].forEach(function (bit) {
      if (missing & bit) {
        mouse.synth |= bit;
        mouse.down[bitButton(bit)] = { t: performance.now(), moves: 0, dx: 0, dy: 0 };
        log('drag-fix: syntetisk knapp ' + bitButton(bit) + ' ned (buttons=' + e.buttons + ')');
        synthesize('mousedown', bitButton(bit), e, video);
      }
      if (released & bit) {
        finishButton(bitButton(bit), 'syntetiskt släppt');
        synthesize('mouseup', bitButton(bit), e, video);
      }
    });
  }

  function installMouseListeners() {
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    ['mousemove', 'pointermove', 'pointerrawupdate'].forEach(function (t) { window.addEventListener(t, onMove, true); });
    ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'dragstart', 'drag', 'dragend', 'auxclick', 'contextmenu'].forEach(function (t) {
      window.addEventListener(t, function (e) { trace(e); }, true);
    });
    window.addEventListener('wheel', function (e) { if (!mouse.wheel) { mouse.wheel = true; log('hjul: deltaY ' + e.deltaY); } }, { capture: true, passive: true });
    if (CONFIG.mouse.blockNativeDrag) {
      ['dragstart', 'selectstart'].forEach(function (t) {
        window.addEventListener(t, function (e) { if (streamVideo()) { e.preventDefault(); } }, true);
      });
    }
    document.addEventListener('pointerlockchange', function () {
      mouse.lock = document.pointerLockElement ? 'låst (' + describe(document.pointerLockElement) + ')' : 'olåst';
      log('pointer lock ' + mouse.lock);
    });
    document.addEventListener('pointerlockerror', function () { mouse.lock = 'FEL vid låsning'; log('pointer lock misslyckades'); });
    // Surface the rejection reason the SDK would otherwise swallow.
    var proto = window.Element && Element.prototype;
    if (proto && typeof proto.requestPointerLock === 'function') {
      var realLock = proto.requestPointerLock;
      proto.requestPointerLock = function () {
        var r;
        try { r = realLock.apply(this, arguments); } catch (e) { mouse.lock = 'kastade ' + e.name; log('requestPointerLock kastade ' + e.name + ': ' + e.message); throw e; }
        if (r && typeof r.then === 'function') {
          r.then(function () { mouse.lock = 'låst'; }, function (e) { mouse.lock = 'avvisad: ' + (e && e.name); log('requestPointerLock avvisad: ' + (e && e.name) + ' ' + (e && e.message)); });
          r.catch(function () {});
        }
        return r;
      };
    }
  }

  function mouseText() {
    if (!mouse.moves && !mouse.lastClick) { return 'inga mushändelser'; }
    var held = Object.keys(mouse.down).map(function (b) { return 'knapp ' + b + ' hålls (' + mouse.down[b].moves + ' rörelser)'; });
    return [
      mouse.moves + ' rörelser',
      'native=' + mouse.native + ' synt=' + mouse.synth,
      held.join(', '),
      mouse.lastDrag ? 'senaste drag: ' + mouse.lastDrag : '',
      'fixar ' + mouse.fixes + ', svalda släpp ' + mouse.swallowed,
      mouse.lock ? 'lås ' + mouse.lock : ''
    ].filter(Boolean).join(' · ');
  }

  function traceText() {
    return mouse.trace.slice(-8).map(function (r) {
      return r.type.replace('pointerrawupdate', 'raw') + (r.button !== undefined && /down|up|click|menu/.test(r.type) ? '(' + r.button + ')' : '') +
        ' b=' + r.buttons + (r.dx || r.dy ? ' d=' + r.dx + ',' + r.dy : '') + (r.note ? ' ' + r.note : '') + (r.trusted ? '' : ' !');
    }).join('  ');
  }

  /* =============================================================== overlay */

  var videoCodecs = null;
  function getVideoCodecs() {
    if (videoCodecs) { return videoCodecs; }
    try {
      if (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
        var caps = RTCRtpReceiver.getCapabilities('video');
        var seen = {};
        videoCodecs = (caps && caps.codecs ? caps.codecs : [])
          .map(function (c) { return String(c.mimeType || '').replace(/^video\//i, ''); })
          .filter(function (n) {
            if (!n || /^(rtx|red|ulpfec|flexfec-03)$/i.test(n) || seen[n]) { return false; }
            seen[n] = true;
            return true;
          })
          .join(', ') || 'inga';
      } else {
        videoCodecs = 'getCapabilities saknas';
      }
    } catch (e) {
      videoCodecs = 'fel: ' + e.message;
    }
    return videoCodecs;
  }

  function gamepadText() {
    try {
      if (!nav.getGamepads) { return 'Gamepad API SAKNAS'; }
      var pads = Array.prototype.filter.call(nav.getGamepads(), Boolean);
      if (!pads.length) { return '0 (tryck en knapp på handkontrollen)'; }
      return pads.map(function (p) {
        return '#' + p.index + ' ' + p.id + ' [' + (p.mapping || 'ingen mappning') + ', ' + p.buttons.length + ' knappar, ' + p.axes.length + ' axlar]';
      }).join(' | ');
    } catch (e) {
      return 'fel: ' + e.message;
    }
  }

  function uaDataText() {
    try {
      var d = nav.userAgentData;
      if (!d) { return 'saknas'; }
      return d.platform + ' / ' + (d.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(', ');
    } catch (e) {
      return 'fel: ' + e.message;
    }
  }

  // Short description of an element, never form field values.
  function describe(t) {
    if (!t || !t.tagName) { return '?'; }
    var tag = t.tagName.toLowerCase();
    var s = tag + (t.id ? '#' + trunc(t.id, 24) : '');
    if (t.type && /^(input|button)$/.test(tag)) { s += '[' + t.type + ']'; }
    if (!/^(input|textarea|select|video|canvas)$/.test(tag)) {
      var txt = String(t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) { s += ' "' + trunc(txt, 20) + '"'; }
    }
    return s;
  }

  // Key names without revealing what is typed: characters show as "tecken".
  function keyName(e) {
    var k = e.key;
    if (k && k.length === 1) { return 'tecken'; }
    return (k || 'okänd') + ' (' + e.keyCode + ')';
  }

  function diagText() {
    refreshStreamStats();
    var lines = [
      'GFN Desktop för Tizen v' + VERSION + '   [blå: visa/dölj · röd: 4K-läge · grön: drag-fix]   klocka ' + tzLabel(),
      'Sida:           ' + location.host + trunc(location.pathname, 60),
      'Start:          ' + (startNote || ('direkt, injicerad ' + injectedAt.ms + ' ms, ' + injectedAt.readyState +
        ', ' + injectedAt.scripts + ' skript före' + (lateInjection ? ' – SEN' : ' – tidig'))),
      'GFN-beslut:     ' + (verdict || 'väntar…'),
      'Ström:          ' + (stream.text || 'ingen aktiv ström'),
      '4K-läge:        ' + (force4k.wanted ? 'PÅ – ' + (force4k.applied || 'väntar på GFN:s SDK') : 'av') + ' · codecs ' + getVideoCodecs(),
      'Mus:            ' + mouseText() + (CONFIG.mouse.fix ? '' : ' · drag-fix AV'),
      'Mushändelser:   ' + (mouse.trace.length ? traceText() : '–'),
      'Tangent:        ' + (mouse.lastKey || '–'),
      'Handkontroller: ' + gamepadText(),
      'Spoof:          ' + (nav.userAgent === spoofUA ? 'aktiv – Windows/Chrome ' + major + ' (' + fullVersion + ')' : 'INTE aktiv') + ', UA-data ' + uaDataText(),
      'Riktig:         ' + trunc(realUA, 90) + ' · ' + (real ? real.platform + ', UA-data ' + trunc(real.uaData, 40) : ''),
      'Tizen-spår:     ' + (real && real.globals.length ? real.globals.join(', ') : 'inga globaler') +
        (hiddenNames.length ? ' (dolda)' : '') + (pluginNote ? ', ' + pluginNote : '') +
        ', workers ' + workerCount.Worker + '+' + workerCount.SharedWorker + ' spoofade',
      'Fönster:        ' + window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) +
        ', skärm ' + screen.width + '×' + screen.height + (document.pointerLockElement ? ', pointer lock' : ''),
      '──── logg ────'
    ];
    return lines.concat(logLines.slice(-CONFIG.overlay.shownLogLines).map(lineText)).join('\n');
  }

  function ensureOverlay() {
    if (overlay.el && overlay.el.isConnected) { return overlay.el; }
    if (!document.body) { return null; }
    var el = document.createElement('div');
    el.id = 'gfn-tizen-overlay';
    el.style.cssText = [
      'position:fixed', 'top:24px', 'left:24px', 'max-width:1500px', 'z-index:2147483647',
      'background:rgba(0,0,0,0.85)', 'color:#d9ffd9', 'font:16px/1.35 monospace',
      'padding:14px 18px', 'border-radius:10px', 'white-space:pre-wrap',
      'pointer-events:none', 'display:none'
    ].join(';');
    document.body.appendChild(el);
    overlay.el = el;
    return el;
  }

  function renderOverlay() {
    var el = ensureOverlay();
    if (el) { el.textContent = diagText(); }
  }

  function showOverlay(ms) {
    var el = ensureOverlay();
    if (!el) { return; }
    overlay.visible = true;
    el.style.display = 'block';
    renderOverlay();
    clearInterval(overlay.pollTimer);
    overlay.pollTimer = setInterval(renderOverlay, 1000);
    clearTimeout(overlay.hideTimer);
    if (ms) { overlay.hideTimer = setTimeout(hideOverlay, ms); }
  }

  function hideOverlay() {
    overlay.visible = false;
    clearInterval(overlay.pollTimer);
    clearTimeout(overlay.hideTimer);
    if (overlay.el) { overlay.el.style.display = 'none'; }
  }

  function watchForUnsupportedText() {
    var checks = 0;
    var timer = setInterval(function () {
      checks += 1;
      try {
        var text = document.body ? (document.body.innerText || '') : '';
        var m = /.{0,60}(not supported|unsupported|stöds inte).{0,60}/i.exec(text);
        if (m && !unsupportedSeen) {
          unsupportedSeen = true;
          log('Sidan säger att något inte stöds: "' + m[0].replace(/\s+/g, ' ') + '"');
          showOverlay(0);
        }
      } catch (e) { /* ignore */ }
      if (checks >= 18 || unsupportedSeen) { clearInterval(timer); }
    }, 5000);
  }

  /* ================================================================ events */

  function installListeners() {
    window.addEventListener('error', function (e) {
      var t = e && e.target;
      if (t && t !== window && t.tagName) {
        // GFN sets img.src = "" when tiles are destroyed; with <base href="#"> that
        // resolves to /mall/ and is pure noise.
        var raw = t.getAttribute && (t.getAttribute('src') || t.getAttribute('href'));
        if (!raw) { return; }
        log('resurs kunde inte laddas: <' + t.tagName.toLowerCase() + '> ' + trunc(stripAuth(raw), 90));
        return;
      }
      var where = e && e.filename ? trunc(e.filename.replace(/^https?:\/\/[^/]+/, ''), 50) + ':' + e.lineno : 'utan källa';
      var msg = (e && e.message) || String(e);
      var stack = e && e.error && e.error.stack ? String(e.error.stack).split('\n').slice(1, 2).join('').trim() : '';
      log('JS-fel @ ' + where + ': ' + trunc(msg, 110) + (stack && where === 'utan källa' ? ' ' + trunc(stack, 60) : ''));
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      log('ohanterat löfte: ' + trunc((r && (r.message || r)) || 'okänt', 120));
    });

    window.addEventListener('gamepadconnected', function (e) {
      log('handkontroll ansluten: ' + e.gamepad.id + ' (' + (e.gamepad.mapping || 'ingen mappning') + ')');
    });
    window.addEventListener('gamepaddisconnected', function (e) {
      log('handkontroll frånkopplad: ' + e.gamepad.id);
    });

    installMouseListeners();

    window.addEventListener('keydown', function (e) {
      mouse.lastKey = keyName(e);
      if (e.keyCode === CONFIG.keys.blue) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (overlay.visible) { hideOverlay(); } else { showOverlay(0); }
      } else if (e.keyCode === CONFIG.keys.red) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleForce4k();
      } else if (e.keyCode === CONFIG.keys.green) {
        e.preventDefault(); e.stopImmediatePropagation();
        CONFIG.mouse.fix = !CONFIG.mouse.fix;
        log('drag-fix ' + (CONFIG.mouse.fix ? 'PÅ' : 'AV'));
        showOverlay(0);
      }
    }, true);
  }

  function onReady() {
    log('sida laddad: ' + location.host + location.pathname);
    if (!startNote) {
      log('injicerad efter ' + injectedAt.ms + ' ms (' + injectedAt.readyState + ', ' + injectedAt.scripts + ' skript)');
    }
    if (CONFIG.overlay.autoShowMs) { showOverlay(CONFIG.overlay.autoShowMs); }
    watchForUnsupportedText();
    if (isGfnOrigin()) { setTimeout(probeGfnVerdict, 8000); }
  }

  /* ================================================================= start */

  real = readRealIdentity();
  if (CONFIG.hideTizenGlobals) { hideGlobals(); }
  if (CONFIG.spoof) {
    applySpoof();
    if (CONFIG.spoofWorkers) { patchWorkers(); }
    if (CONFIG.spoofPointerMedia) { spoofPointerMedia(); }
  }

  // Subframes get the identity only; everything else is for the top document.
  if (!isTop) { return; }

  if (isGfnOrigin()) {
    force4k.wanted = force4kWanted();
    installWebpackHook();
    patchPeerConnection();
  }

  if (CONFIG.bootViaRobots && isBootDocument()) {
    boot();
    return;
  }

  // A GFN page loaded directly, and we came too late: GFN has already decided.
  if (CONFIG.bootViaRobots && isGfnOrigin() && lateInjection) {
    if (hasAuthParams(location.href)) {
      rebootAfterAuth();
    } else if (rebootViaRobots('sen injektion (' + injectedAt.readyState + ')')) {
      return;
    }
  }

  installListeners();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
