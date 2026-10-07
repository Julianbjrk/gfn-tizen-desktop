/*
 * gfn-tizen-desktop v0.2.0 — TizenBrew mods-modul (MIT)
 *
 * TizenBrew kör den här filen med CDP Runtime.evaluate när varje nytt dokument
 * skapar sin JS-kontext. Det sker asynkront, så GFN:s egna skript hinner ofta
 * före. GFN avgör plattform EN gång vid start (Ragnarok-biblioteket), så en sen
 * spoof hjälper inte.
 * (evaluateScriptOnDocumentStart används inte: i TizenBrew 2.0.5 öppnas sidan
 * aldrig när man klickar på en sådan modul.)
 *
 * Därför startar modulen på play.geforcenow.com/robots.txt, en liten textfil
 * utan GFN-skript. Där sätts spoofen först, och sedan hämtar och skriver modulen
 * själv in GFN:s index.html i samma fönster (document.write). GFN:s skript körs
 * alltså alltid efter spoofen. Laddas GFN-sidan ändå direkt (omladdning, retur
 * från inloggningen) och skriptet kom för sent, startas den om via robots.txt.
 *
 * Vad den gör:
 *   1. Får GFN:s webbklient att se Chrome på Windows i stället för en Tizen-TV:
 *      navigator (userAgent, userAgentData, platform, vendor, plugins), samma
 *      värden i GFN:s workers, och döljer Samsungs globala objekt.
 *   2. Visar en diagnostikruta på TV:n (blå knapp på fjärrkontrollen), eftersom
 *      det inte går att ansluta DevTools medan TizenBrew använder debug-porten.
 *      Rutan visar även GFN:s eget plattformsbeslut.
 *
 * Vad den INTE gör: ändrar inget i spelet, automatiserar ingenting, rör inga
 * HTTP-headers (JS kan inte det).
 */
(function () {
  'use strict';

  if (window.__gfnTizenDesktop) { return; }

  // Hur långt sidan hunnit när TizenBrew injicerade oss (läses först av allt).
  var injectedAt = {
    ms: (window.performance && performance.now) ? Math.round(performance.now()) : -1,
    readyState: document.readyState,
    scripts: document.scripts ? document.scripts.length : 0
  };
  var lateInjection = injectedAt.readyState !== 'loading';

  var VERSION = '0.2.0';
  var GFN_HOST = 'play.geforcenow.com';
  var BOOT_PATH = '/robots.txt';    // liten textfil på GFN:s domän, utan GFN-skript
  var BOOT_KEY = 'gfn-tizen-boot';  // #gfn-tizen-boot=<sökväg att visa>

  var CONFIG = {
    spoof: true,                    // utge sig för att vara Chrome på Windows
    hideTizenGlobals: true,         // dölj Samsungs globala objekt (GFN letar efter dem)
    spoofWorkers: true,             // samma identitet i GFN:s workers (där läses plattformen)
    bootViaRobots: true,            // ladda GFN själv efter spoofen (se ovan)
    gfnHtmlPath: '/mall/',          // där GFN:s index.html serveras
    windowsPlatformVersion: '15.0.0', // motsvarar Windows 11 i client hints
    keepScreenOn: true,             // försök stänga av TV:ns skärmsläckare
    overlay: {
      autoShowMs: 20000,            // visa rutan automatiskt så länge efter sidladdning (0 = av)
      toggleKeyCode: 406,           // blå knapp (ColorF3Blue)
      maxLogLines: 40,
      shownLogLines: 10
    }
  };

  // Globala objekt som avslöjar Tizen (samma lista som GFN:s detektor använder).
  var TIZEN_GLOBALS = ['tizen', 'webapis', 'b2bapis', 'TizenTVApiInfo', 'addEdgeEffectONSCROLLTizenUIF', 'tizentvwasm'];

  var isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  var nav = window.navigator;
  var realUA = String(nav.userAgent || '');
  // Tizen 9 skriver "(KHTML, like Gecko) 120.0.6099.5/9.0 TV" utan "Chrome/".
  var chromeMatch = /(?:Chrome\/|like Gecko\) )(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(realUA);
  var major = chromeMatch ? chromeMatch[1] : '120';
  var fullVersion = (chromeMatch && chromeMatch[2]) ? (major + '.' + chromeMatch[2]) : (major + '.0.0.0');
  var spoofUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';

  var real = readRealIdentity();
  var hidden = {};           // undangömda Tizen-globaler
  var hiddenNames = [];
  var pluginNote = '';
  var workerCount = { Worker: 0, SharedWorker: 0 };
  var startNote = '';
  var verdict = null;        // GFN:s eget plattformsbeslut
  var logLines = [];
  var overlay = { el: null, visible: false, hideTimer: null, pollTimer: null };
  var unsupportedSeen = false;
  var input = { moves: 0, lastMouse: null, lastClick: null, lastKey: null };

  window.__gfnTizenDesktop = {
    version: VERSION,
    config: CONFIG,
    diag: function () { return diagText(); },
    log: function () { return logLines.slice(); }
  };

  /* ------------------------------------------------------------ logg */

  function fmt(v) {
    if (typeof v === 'string') { return v; }
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function log() {
    var parts = Array.prototype.slice.call(arguments).map(fmt);
    var line = new Date().toISOString().substr(11, 8) + ' ' + parts.join(' ');
    logLines.push(line);
    if (logLines.length > CONFIG.overlay.maxLogLines) { logLines.shift(); }
    try { console.log('[gfn-tizen] ' + line); } catch (e) { /* ignorera */ }
    if (overlay.visible) { renderOverlay(); }
  }

  function trunc(s, n) { s = String(s); return s.length > n ? s.substr(0, n - 1) + '…' : s; }

  /* ------------------------------------------------------------ riktig identitet */

  function readRealIdentity() {
    var r = { platform: '', uaData: '', globals: [], plugins: [] };
    try { r.platform = String(nav.platform || ''); } catch (e) { /* ignorera */ }
    try {
      var d = nav.userAgentData;
      r.uaData = d ? (d.platform || '""') + ' / ' + (d.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(', ') : 'saknas';
    } catch (e) { r.uaData = 'fel'; }
    TIZEN_GLOBALS.forEach(function (n) {
      try { if (window[n]) { r.globals.push(n); } } catch (e) { /* ignorera */ }
    });
    try {
      r.plugins = Array.prototype.map.call(nav.plugins || [], function (p) { return p.name; });
    } catch (e) { /* ignorera */ }
    return r;
  }

  /* ------------------------------------------------------------ spoof */

  function defineGetter(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, { get: getter, configurable: true, enumerable: true });
      return true;
    } catch (e) {
      log('kunde inte ersätta ' + prop + ': ' + e.message);
      return false;
    }
  }

  // Värdena för client hints, delas mellan sidan och dess workers.
  function uaDataValues() {
    var brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major }
    ];
    return {
      brands: brands,
      high: {
        architecture: 'x86',
        bitness: '64',
        brands: brands,
        fullVersionList: [
          { brand: 'Not_A Brand', version: '8.0.0.0' },
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Google Chrome', version: fullVersion }
        ],
        mobile: false,
        model: '',
        platform: 'Windows',
        platformVersion: CONFIG.windowsPlatformVersion,
        uaFullVersion: fullVersion,
        wow64: false,
        formFactors: ['Desktop']
      }
    };
  }

  function buildUAData(v, UADataCtor) {
    var data = {
      brands: v.brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: function (hints) {
        var out = { brands: v.brands, mobile: false, platform: 'Windows' };
        (Array.isArray(hints) ? hints : []).forEach(function (h) {
          if (Object.prototype.hasOwnProperty.call(v.high, h)) { out[h] = v.high[h]; }
        });
        return Promise.resolve(out);
      },
      toJSON: function () { return { brands: v.brands, mobile: false, platform: 'Windows' }; }
    };
    // Låt instanceof-kontroller lyckas; egna egenskaper skuggar de inbyggda getters.
    try { if (UADataCtor && UADataCtor.prototype) { Object.setPrototypeOf(data, UADataCtor.prototype); } } catch (e) { /* ignorera */ }
    return data;
  }

  // Samsung-pluginet "PPAPI SAMSUNGHEALTH" räcker för att GFN ska se Tizen.
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
    try { if (window.PluginArray) { Object.setPrototypeOf(list, window.PluginArray.prototype); } } catch (e) { /* ignorera */ }
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
      // Om egenskapen ligger på själva instansen i den här motorn:
      if (Object.prototype.hasOwnProperty.call(nav, p)) { defineGetter(nav, p, props[p]); }
    });
    log('spoof ' + (nav.userAgent === spoofUA ? 'aktiv' : 'MISSLYCKADES') + ' (Chromium ' + major + ')');
  }

  function hideGlobals() {
    TIZEN_GLOBALS.forEach(function (name) {
      var had;
      try { had = name in window; } catch (e) { had = false; }
      if (!had) { return; }
      try { hidden[name] = window[name]; } catch (e) { /* ignorera */ }
      // Helst helt borta (GFN kontrollerar även med "in"), annars en getter som ger undefined.
      try { delete window[name]; } catch (e) { /* ignorera */ }
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

  function tizenApi() { return hidden.tizen || window.tizen; }
  function webApis() { return hidden.webapis || window.webapis; }

  // Körs i varje worker som GFN skapar, före GFN:s egen kod.
  function workerPrelude(c) {
    try {
      var P = self.WorkerNavigator && self.WorkerNavigator.prototype;
      if (!P) { return; }
      var def = function (p, v) {
        try { Object.defineProperty(P, p, { get: function () { return v; }, configurable: true, enumerable: true }); } catch (e) { /* ignorera */ }
      };
      def('userAgent', c.ua);
      def('appVersion', c.ua.replace(/^Mozilla\//, ''));
      def('platform', 'Win32');
      var data = {
        brands: c.v.brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function (hints) {
          var out = { brands: c.v.brands, mobile: false, platform: 'Windows' };
          (Array.isArray(hints) ? hints : []).forEach(function (h) {
            if (Object.prototype.hasOwnProperty.call(c.v.high, h)) { out[h] = c.v.high[h]; }
          });
          return Promise.resolve(out);
        },
        toJSON: function () { return { brands: c.v.brands, mobile: false, platform: 'Windows' }; }
      };
      try { if (self.NavigatorUAData) { Object.setPrototypeOf(data, self.NavigatorUAData.prototype); } } catch (e) { /* ignorera */ }
      def('userAgentData', data);
    } catch (e) { /* ignorera */ }
  }

  // GFN:s detektor läser navigator.platform och userAgentData i workers som
  // skapas från blob-URL:er. Lägg vår prelude först i varje sådan worker.
  function patchWorkers() {
    var prelude = '(' + workerPrelude.toString() + ')(' + JSON.stringify({ ua: spoofUA, v: uaDataValues() }) + ');\n';
    var keep = {};
    var realRevoke = URL.revokeObjectURL;
    // GFN återkallar blob-URL:en direkt efter new Worker(); vår worker läser den asynkront.
    URL.revokeObjectURL = function (u) {
      if (keep[u]) { setTimeout(function () { realRevoke.call(URL, u); }, 15000); return; }
      return realRevoke.apply(URL, arguments);
    };
    ['Worker', 'SharedWorker'].forEach(function (kind) {
      var Orig = window[kind];
      if (typeof Orig !== 'function') { return; }
      var Wrapped = function (url, opts) {
        var target = url;
        try {
          var u = String(url);
          if (/^blob:/.test(u)) {
            var isModule = !!(opts && typeof opts === 'object' && opts.type === 'module');
            keep[u] = true;
            var body = prelude + (isModule ? 'import ' + JSON.stringify(u) + ';\n' : 'importScripts(' + JSON.stringify(u) + ');\n');
            target = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
            setTimeout(function () { realRevoke.call(URL, target); }, 15000);
            workerCount[kind] += 1;
          }
        } catch (e) {
          log(kind + '-spoof misslyckades: ' + e.message);
          target = url;
        }
        return arguments.length > 1 ? new Orig(target, opts) : new Orig(target);
      };
      Wrapped.prototype = Orig.prototype;
      try {
        Object.defineProperty(window, kind, { value: Wrapped, configurable: true, writable: true });
      } catch (e) {
        log('kunde inte ersätta ' + kind + ': ' + e.message);
      }
    });
  }

  function keepScreenOn() {
    var w = webApis();
    try {
      if (w && w.appcommon && w.appcommon.setScreenSaver) {
        w.appcommon.setScreenSaver(
          w.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
          function () { log('skärmsläckare av'); },
          function (e) { log('skärmsläckare: ' + (e && e.message)); }
        );
      } else {
        log('webapis.appcommon saknas – skärmsläckaren styrs inte');
      }
    } catch (e) {
      log('skärmsläckare: ' + e.message);
    }
  }

  /* ------------------------------------------------------------ start via robots.txt */

  function isBootDocument() {
    return isTop && location.hostname === GFN_HOST && location.pathname === BOOT_PATH;
  }

  function bootTarget() {
    var m = new RegExp('[#&]' + BOOT_KEY + '=([^&]*)').exec(location.hash);
    var t = m ? decodeURIComponent(m[1]) : CONFIG.gfnHtmlPath;
    return /^\/(?!\/)/.test(t) ? t : CONFIG.gfnHtmlPath;   // bara sökvägar på samma domän
  }

  function hasAuthParams() {
    return /[?&#](code|state|token|id_token|access_token)=/.test(location.href);
  }

  // Högst 3 omstarter per 2 minuter, så att ett fel aldrig blir en loop.
  function rebootAllowed() {
    try {
      var now = Date.now();
      var list = JSON.parse(sessionStorage.getItem('gfnTizenReboots') || '[]').filter(function (t) { return now - t < 120000; });
      if (list.length >= 3) { return false; }
      list.push(now);
      sessionStorage.setItem('gfnTizenReboots', JSON.stringify(list));
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
    try { console.log('[gfn-tizen] omstart via ' + BOOT_PATH + ': ' + reason); } catch (e) { /* ignorera */ }
    location.replace(BOOT_PATH + '#' + BOOT_KEY + '=' + encodeURIComponent(path));
    return true;
  }

  // Efter inloggningen: låt GFN byta in koden först, starta sedan om via robots.txt.
  function rebootAfterAuth() {
    var waited = 0;
    log('inloggningsretur – väntar tills GFN tagit emot koden');
    var timer = setInterval(function () {
      waited += 1;
      if (!hasAuthParams() || waited >= 180) {
        clearInterval(timer);
        setTimeout(function () { rebootViaRobots('efter inloggning'); }, 5000);
      }
    }, 1000);
  }

  function boot() {
    var target = bootTarget();
    startNote = 'via ' + BOOT_PATH + ' – spoof före GFN';
    log('startar GFN via ' + BOOT_PATH + ' → ' + target);
    fetch(CONFIG.gfnHtmlPath, { credentials: 'include', cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.text();
      })
      .then(function (html) {
        history.replaceState(null, '', target);
        document.open();
        document.write(html);
        document.close();
        // document.open() tar bort elementen och alla lyssnare på window.
        overlay.el = null;
        installListeners();
        onReady();
      })
      .catch(function (e) {
        log('kunde inte starta via ' + BOOT_PATH + ': ' + e.message + ' – laddar GFN direkt');
        location.replace(target);
      });
  }

  /* ------------------------------------------------------------ GFN:s eget beslut */

  // Fråga GFN:s detektor (Ragnarok, webpack-modul) vad den kom fram till.
  // Bara läsning: getPlatformDetails() är cachad och redan beräknad av GFN.
  function probeGfnVerdict() {
    var q = window.webpackChunkgfn_mall;
    if (!q || typeof q.push !== 'function') { verdict = 'GFN:s webpack saknas'; return; }
    try {
      q.push([['gfnTizenProbe' + Date.now()], {}, function (req) {
        var R = null;
        try { R = req(56123); } catch (e) { /* modul-id byts vid nya GFN-versioner */ }
        if (!R || typeof R.getPlatformDetails !== 'function') {
          var m = req.m || {};
          Object.keys(m).some(function (id) {
            try {
              if (String(m[id]).indexOf('getPlatformDetails=') !== -1) { R = req(id); return true; }
            } catch (e) { /* ignorera */ }
            return false;
          });
        }
        if (!R || typeof R.getPlatformDetails !== 'function') { verdict = 'detektorn hittades inte'; return; }
        R.getPlatformDetails().then(function (d) {
          var ok;
          try { ok = R.IsFeatureSupported(R.BrowserFeature.Streaming, d); } catch (e) { ok = '?'; }
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
      }]);
    } catch (e) {
      verdict = 'fel: ' + e.message;
    }
  }

  /* ------------------------------------------------------------ diagnostik */

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
        return '#' + p.index + ' ' + p.id + ' [' + (p.mapping || 'ingen mappning') + ', ' +
          p.buttons.length + ' knappar, ' + p.axes.length + ' axlar]';
      }).join('\n                ');
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

  function diagText() {
    var lines = [
      'GFN Desktop för Tizen v' + VERSION + '      [blå knapp: visa/dölj]',
      'Sida:           ' + location.host + trunc(location.pathname, 60),
      'Start:          ' + (startNote || ('direkt, injicerad ' + injectedAt.ms + ' ms, ' + injectedAt.readyState +
        ', ' + injectedAt.scripts + ' skript före' + (lateInjection ? ' – SEN' : ' – tidig'))),
      'GFN-beslut:     ' + (verdict || 'väntar…'),
      'Riktig UA:      ' + trunc(realUA, 120),
      'Riktig plattf.: ' + real.platform + ', UA-data ' + trunc(real.uaData, 70),
      'Spoof:          ' + (nav.userAgent === spoofUA ? 'aktiv – Windows/Chrome ' + major + ' (' + fullVersion + ')' : 'INTE aktiv') +
        ', UA-data ' + uaDataText(),
      'Tizen-spår:     ' + (real.globals.length ? real.globals.join(', ') : 'inga globaler') +
        (hiddenNames.length ? ' (dolda)' : '') + (pluginNote ? ', ' + pluginNote : '') +
        ', workers ' + workerCount.Worker + '+' + workerCount.SharedWorker + ' spoofade',
      'WebRTC:         ' + (window.RTCPeerConnection ? 'finns' : 'SAKNAS') + ', codecs ' + getVideoCodecs(),
      'Handkontroller: ' + gamepadText(),
      'Mus/tangent:    ' + (input.moves ? input.moves + ' musrörelser' : 'inga mushändelser') +
        (input.lastClick ? ', klick: ' + input.lastClick : '') + ', tangent ' + (input.lastKey || '–'),
      'Fönster:        ' + window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) +
        ', skärm ' + screen.width + '×' + screen.height,
      '──── logg ────'
    ];
    return lines.concat(logLines.slice(-CONFIG.overlay.shownLogLines)).join('\n');
  }

  function ensureOverlay() {
    if (overlay.el && overlay.el.isConnected) { return overlay.el; }
    if (!document.body) { return null; }
    var el = document.createElement('div');
    el.id = 'gfn-tizen-overlay';
    el.style.cssText = [
      'position:fixed', 'top:24px', 'left:24px', 'max-width:1300px', 'z-index:2147483647',
      'background:rgba(0,0,0,0.85)', 'color:#d9ffd9', 'font:17px/1.35 monospace',
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
      } catch (e) { /* ignorera */ }
      if (checks >= 18 || unsupportedSeen) { clearInterval(timer); }
    }, 5000);
  }

  // Kort beskrivning av ett klickat element, utan värden från formulärfält.
  function describe(t) {
    if (!t || !t.tagName) { return '?'; }
    var tag = t.tagName.toLowerCase();
    var s = tag + (t.id ? '#' + trunc(t.id, 24) : '');
    if (t.type && /^(input|button)$/.test(tag)) { s += '[' + t.type + ']'; }
    if (!/^(input|textarea|select)$/.test(tag)) {
      var txt = String(t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) { s += ' "' + trunc(txt, 24) + '"'; }
    }
    return s;
  }

  // Tangentnamn utan att avslöja vad som skrivs: tecken visas bara som "tecken".
  function keyName(e) {
    var k = e.key;
    if (k && k.length === 1) { return 'tecken'; }
    return (k || 'okänd') + ' (' + e.keyCode + ')';
  }

  /* ------------------------------------------------------------ händelser */

  function installListeners() {
    window.addEventListener('error', function (e) {
      if (e && e.target && e.target !== window && e.target.tagName) {
        log('resurs kunde inte laddas: ' + trunc(e.target.src || e.target.href || e.target.tagName, 100));
      } else {
        log('JS-fel: ' + trunc((e && e.message) || e, 140) +
          (e && e.filename ? ' @ ' + trunc(e.filename, 60) + ':' + e.lineno : ''));
      }
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      log('ohanterat löfte: ' + trunc((r && (r.message || r)) || 'okänt', 140));
    });

    window.addEventListener('gamepadconnected', function (e) {
      log('handkontroll ansluten: ' + e.gamepad.id + ' (' + (e.gamepad.mapping || 'ingen mappning') + ')');
    });
    window.addEventListener('gamepaddisconnected', function (e) {
      log('handkontroll frånkopplad: ' + e.gamepad.id);
    });

    window.addEventListener('mousemove', function (e) {
      if (!input.moves) { log('första mushändelse (' + e.clientX + ',' + e.clientY + ')'); }
      input.moves += 1;
      input.lastMouse = { x: e.clientX, y: e.clientY };
    }, true);

    window.addEventListener('mousedown', function (e) {
      input.lastClick = describe(e.target) + ' @' + e.clientX + ',' + e.clientY;
      log('klick: ' + input.lastClick);
    }, true);

    window.addEventListener('keydown', function (e) {
      input.lastKey = keyName(e);
    }, true);

    if (isTop) {
      window.addEventListener('keydown', function (e) {
        if (e.keyCode === CONFIG.overlay.toggleKeyCode) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (overlay.visible) { hideOverlay(); } else { showOverlay(0); }
        }
      }, true);
    }
  }

  function onReady() {
    if (!isTop) { return; }
    log('sida laddad: ' + location.host + location.pathname);
    if (!startNote) {
      log('injicerad efter ' + injectedAt.ms + ' ms (' + injectedAt.readyState + ', ' + injectedAt.scripts + ' skript)');
    }
    if (CONFIG.keepScreenOn) { keepScreenOn(); }
    if (CONFIG.overlay.autoShowMs) { showOverlay(CONFIG.overlay.autoShowMs); }
    watchForUnsupportedText();
    if (location.hostname === GFN_HOST) { setTimeout(probeGfnVerdict, 8000); }
  }

  /* ------------------------------------------------------------ start */

  if (CONFIG.hideTizenGlobals) { hideGlobals(); }
  if (CONFIG.spoof) { applySpoof(); }
  if (CONFIG.spoof && CONFIG.spoofWorkers) { patchWorkers(); }

  if (CONFIG.bootViaRobots && isBootDocument()) {
    boot();
    return;
  }

  // GFN-sidan laddad direkt och vi kom för sent: GFN har redan avgjort plattformen.
  if (CONFIG.bootViaRobots && isTop && location.hostname === GFN_HOST && lateInjection) {
    if (hasAuthParams()) {
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
