/*
 * gfn-tizen-desktop v0.1.2 — TizenBrew mods-modul (MIT)
 *
 * TizenBrew kör den här filen med CDP Runtime.evaluate så fort varje nytt
 * dokument skapar sin JS-kontext. Det sker asynkront, så sidans tidigaste skript
 * kan hinna före. Diagnostikrutan visar hur tidigt injektionen kom, och vid en
 * sen injektion laddas sidan om en gång (då ligger modulen i TizenBrews cache
 * och hinner oftast före sidans skript).
 * (evaluateScriptOnDocumentStart används inte: i TizenBrew 2.0.5 öppnas sidan
 * aldrig när man klickar på en sådan modul.)
 *
 * Vad den gör:
 *   1. Får GFN:s webbklient att se Chrome på Windows i stället för en Tizen-TV
 *      (navigator.userAgent, userAgentData, platform, vendor).
 *   2. Visar en diagnostikruta på TV:n (blå knapp på fjärrkontrollen), eftersom
 *      det inte går att ansluta DevTools medan TizenBrew använder debug-porten.
 *   3. Ritar en egen muspekare, eftersom TV:n inte visar någon inne i TizenBrew.
 *      Den göms när musen är stilla och när spelet låser musen (pointer lock).
 *
 * Vad den INTE gör: ändrar inget i spelet, automatiserar ingenting, rör inga
 * HTTP-headers (JS kan inte det; se CLAUDE.md, experiment E4).
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

  var VERSION = '0.1.2';

  var CONFIG = {
    spoof: true,                    // utge sig för att vara Chrome på Windows
    hideTizenGlobals: false,        // dölj window.tizen/webapis för sidan (prova om GFN hamnar i TV-läge)
    trySetHttpUserAgent: false,     // experiment E4: byt även HTTP-headerns UA via tizen.websetting (laddar om en gång)
    windowsPlatformVersion: '15.0.0', // motsvarar Windows 11 i client hints
    keepScreenOn: true,             // försök stänga av TV:ns skärmsläckare
    reloadOnceIfLate: true,         // ladda om sidan en gång om injektionen kom efter att sidan tolkats
    cursor: {
      enabled: true,                // rita en egen muspekare (TizenBrew visar ingen)
      hideAfterMs: 5000             // göm den när musen varit stilla så här länge (0 = aldrig)
    },
    overlay: {
      autoShowMs: 20000,            // visa rutan automatiskt så länge efter sidladdning (0 = av)
      toggleKeyCode: 406,           // blå knapp (ColorF3Blue)
      maxLogLines: 40,
      shownLogLines: 12
    }
  };

  var isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  var nav = window.navigator;
  var realUA = String(nav.userAgent || '');
  // Tizen 9 skriver "(KHTML, like Gecko) 120.0.6099.5/9.0 TV" utan "Chrome/".
  var chromeMatch = /(?:Chrome\/|like Gecko\) )(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(realUA);
  var major = chromeMatch ? chromeMatch[1] : '120';
  var fullVersion = (chromeMatch && chromeMatch[2]) ? (major + '.' + chromeMatch[2]) : (major + '.0.0.0');
  var spoofUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';

  var hidden = {};           // undangömda Tizen-globaler (om hideTizenGlobals)
  var logLines = [];
  var overlay = { el: null, visible: false, hideTimer: null, pollTimer: null };
  var unsupportedSeen = false;
  var input = { moves: 0, lastMouse: null, lastClick: null, lastKey: null };
  var cursor = { el: null, hideTimer: null };

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

  function buildUAData() {
    var brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major }
    ];
    var fullVersionList = [
      { brand: 'Not_A Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion }
    ];
    var high = {
      architecture: 'x86',
      bitness: '64',
      brands: brands,
      fullVersionList: fullVersionList,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: CONFIG.windowsPlatformVersion,
      uaFullVersion: fullVersion,
      wow64: false,
      formFactors: ['Desktop']
    };
    var data = {
      brands: brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: function (hints) {
        var out = { brands: brands, mobile: false, platform: 'Windows' };
        (Array.isArray(hints) ? hints : []).forEach(function (h) {
          if (Object.prototype.hasOwnProperty.call(high, h)) { out[h] = high[h]; }
        });
        return Promise.resolve(out);
      },
      toJSON: function () { return { brands: brands, mobile: false, platform: 'Windows' }; }
    };
    // Låt instanceof-kontroller lyckas; egna egenskaper skuggar de inbyggda getters.
    try {
      if (window.NavigatorUAData && window.NavigatorUAData.prototype) {
        Object.setPrototypeOf(data, window.NavigatorUAData.prototype);
      }
    } catch (e) { /* ignorera */ }
    return data;
  }

  function applySpoof() {
    var proto = Object.getPrototypeOf(nav);
    var uaData = buildUAData();
    var props = {
      userAgent: function () { return spoofUA; },
      appVersion: function () { return spoofUA.replace(/^Mozilla\//, ''); },
      platform: function () { return 'Win32'; },
      vendor: function () { return 'Google Inc.'; },
      maxTouchPoints: function () { return 0; },
      userAgentData: function () { return uaData; }
    };
    Object.keys(props).forEach(function (p) {
      defineGetter(proto, p, props[p]);
      // Om egenskapen ligger på själva instansen i den här motorn:
      if (Object.prototype.hasOwnProperty.call(nav, p)) { defineGetter(nav, p, props[p]); }
    });
    log('spoof ' + (nav.userAgent === spoofUA ? 'aktiv' : 'MISSLYCKADES') + ' (Chromium ' + major + ')');
  }

  function hideGlobals() {
    ['tizen', 'webapis', 'b2bapis'].forEach(function (name) {
      try {
        hidden[name] = window[name];
        Object.defineProperty(window, name, {
          configurable: true,
          get: function () { return undefined; },
          set: function (v) { hidden[name] = v; }
        });
      } catch (e) {
        log('kunde inte dölja ' + name + ': ' + e.message);
      }
    });
    log('Tizen-globaler dolda för sidan');
  }

  function tizenApi() { return hidden.tizen || window.tizen; }
  function webApis() { return hidden.webapis || window.webapis; }

  function trySetHttpUserAgent() {
    var t = tizenApi();
    try {
      if (!t || !t.websetting || !t.websetting.setUserAgentString) {
        log('E4: tizen.websetting saknas på sidan');
        return;
      }
      if (sessionStorage.getItem('gfnTizenUaSet')) { log('E4: HTTP-UA redan satt i den här sessionen'); return; }
      sessionStorage.setItem('gfnTizenUaSet', '1');
      t.websetting.setUserAgentString(spoofUA, function () {
        log('E4: HTTP-UA satt, laddar om');
        location.reload();
      }, function (e) {
        log('E4: setUserAgentString misslyckades: ' + (e && e.message));
      });
    } catch (e) {
      log('E4: ' + e.message);
    }
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

  function trunc(s, n) { s = String(s); return s.length > n ? s.substr(0, n - 1) + '…' : s; }

  function diagText() {
    var lines = [
      'GFN Desktop för Tizen v' + VERSION + '      [blå knapp: visa/dölj]',
      'Sida:           ' + location.host + trunc(location.pathname, 60),
      'Chromium:       ' + major + ' (' + fullVersion + ')',
      'Riktig UA:      ' + trunc(realUA, 120),
      'Injektion:      ' + injectedAt.ms + ' ms efter sidstart, ' + injectedAt.readyState + ', ' +
        injectedAt.scripts + ' skript före' + (lateInjection ? ' – SEN' : ' – tidig') +
        (reloadedForLateness() ? ' (efter 1 omladdning)' : ''),
      'Spoof:          ' + (nav.userAgent === spoofUA ? 'aktiv – Windows/Chrome ' + major : 'INTE aktiv'),
      'UA-data:        ' + uaDataText(),
      'WebRTC:         ' + (window.RTCPeerConnection ? 'finns' : 'SAKNAS'),
      'Videocodecs:    ' + getVideoCodecs(),
      'Handkontroller: ' + gamepadText(),
      'Mus:            ' + (input.moves
        ? input.moves + ' rörelser, senast ' + input.lastMouse.x + ',' + input.lastMouse.y +
          (document.pointerLockElement ? ' (låst av spelet)' : '')
        : 'inga mushändelser än') +
        (input.lastClick ? ', klick: ' + input.lastClick : ''),
      'Tangent:        ' + (input.lastKey || '–'),
      'Tizen-API:      tizen ' + (tizenApi() ? 'ja' : 'nej') + ', webapis ' + (webApis() ? 'ja' : 'nej') +
        (CONFIG.hideTizenGlobals ? ' (dolda för sidan)' : ''),
      'Fönster:        ' + window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) +
        ', skärm ' + screen.width + '×' + screen.height,
      '──── logg ────'
    ];
    return lines.concat(logLines.slice(-CONFIG.overlay.shownLogLines)).join('\n');
  }

  function ensureOverlay() {
    if (overlay.el) { return overlay.el; }
    if (!document.body) { return null; }
    var el = document.createElement('div');
    el.id = 'gfn-tizen-overlay';
    el.style.cssText = [
      'position:fixed', 'top:24px', 'left:24px', 'max-width:1240px', 'z-index:2147483647',
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

  /* ------------------------------------------------------------ muspekare */

  function ensureCursor() {
    if (cursor.el) { return cursor.el; }
    if (!document.body) { return null; }
    // Byggs med DOM-anrop (inte innerHTML) så att det fungerar även med Trusted Types.
    var ns = 'http://www.w3.org/2000/svg';
    var el = document.createElement('div');
    el.id = 'gfn-tizen-cursor';
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:28px', 'height:28px', 'z-index:2147483647',
      'pointer-events:none', 'display:none', 'will-change:transform'
    ].join(';');
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('viewBox', '0 0 28 28');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M2 2 L2 22 L7.5 16.8 L11.5 25.5 L15.3 23.8 L11.4 15.3 L19 15.3 Z');
    path.setAttribute('fill', '#fff');
    path.setAttribute('stroke', '#000');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    el.appendChild(svg);
    document.body.appendChild(el);
    cursor.el = el;
    return el;
  }

  function hideCursor() {
    clearTimeout(cursor.hideTimer);
    if (cursor.el) { cursor.el.style.display = 'none'; }
  }

  function showCursorAt(x, y) {
    if (!CONFIG.cursor.enabled) { return; }
    if (document.pointerLockElement) { hideCursor(); return; }
    var el = ensureCursor();
    if (!el) { return; }
    el.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)';
    el.style.display = 'block';
    clearTimeout(cursor.hideTimer);
    if (CONFIG.cursor.hideAfterMs) { cursor.hideTimer = setTimeout(hideCursor, CONFIG.cursor.hideAfterMs); }
  }

  // Kort beskrivning av ett klickat element, utan värden från formulärfält.
  function describe(t) {
    if (!t || !t.tagName) { return '?'; }
    var s = t.tagName.toLowerCase();
    if (t.id) { s += '#' + trunc(t.id, 24); }
    if (t.type && /^(input|button)$/.test(s.split('#')[0])) { s += '[' + t.type + ']'; }
    if (!/^(input|textarea|select)/.test(s)) {
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
      showCursorAt(e.clientX, e.clientY);
    }, true);

    window.addEventListener('mousedown', function (e) {
      input.lastClick = describe(e.target) + ' @' + e.clientX + ',' + e.clientY;
      if (!input.moves) { input.lastMouse = { x: e.clientX, y: e.clientY }; }
      log('klick: ' + input.lastClick);
      showCursorAt(e.clientX, e.clientY);
    }, true);

    // Pekaren lämnar dokumentet (eller går in i en iframe som ritar sin egen).
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) { hideCursor(); }
    }, true);

    document.addEventListener('pointerlockchange', function () {
      var locked = !!document.pointerLockElement;
      if (locked) { hideCursor(); }
      log('pointer lock ' + (locked ? 'på' : 'av'));
    });

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
    log('injicerad efter ' + injectedAt.ms + ' ms (' + injectedAt.readyState + ', ' + injectedAt.scripts + ' skript)');
    if (CONFIG.keepScreenOn) { keepScreenOn(); }
    if (CONFIG.overlay.autoShowMs) { showOverlay(CONFIG.overlay.autoShowMs); }
    watchForUnsupportedText();
  }

  /* ------------------------------------------------------------ start */

  function reloadedForLateness() {
    try { return sessionStorage.getItem('gfnTizenLateReload') === '1'; } catch (e) { return false; }
  }

  // Sen injektion: sidans skript kan redan ha läst av webbläsaren. Ladda om en
  // gång per flik och origin; nästa gång ligger modulen i TizenBrews cache.
  if (CONFIG.reloadOnceIfLate && isTop && lateInjection && !reloadedForLateness()) {
    try {
      sessionStorage.setItem('gfnTizenLateReload', '1');
      try { console.log('[gfn-tizen] sen injektion (' + injectedAt.readyState + '), laddar om en gång'); } catch (e) { /* ignorera */ }
      location.reload();
      return;
    } catch (e) { /* sessionStorage saknas: fortsätt utan omladdning */ }
  }

  if (CONFIG.hideTizenGlobals) { hideGlobals(); }
  if (CONFIG.spoof) { applySpoof(); }
  if (CONFIG.spoof && CONFIG.trySetHttpUserAgent && isTop) { trySetHttpUserAgent(); }
  installListeners();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
