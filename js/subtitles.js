/* CineVault TV — subtitles.js
   One custom text overlay, driven by cues parsed from the fetched SRT/VTT.
   The TV browser's TextTrack support is not trusted: several sets expose the
   API but never draw the cues. SRT is converted locally and responses that
   belong to a previous episode are discarded. */

var CV = window.CV || {};
window.CV = CV;

CV.subs = (function () {

  var u = CV.util;
  var video = null;
  var overlay = null;
  var token = 0;
  var langs = [];
  var activeLang = '';
  var cues = [];
  var cueCache = {};
  var timeHandler = null;
  var tickTimer = null;
  var sizeName = 'Medium';
  var lastText = null;

  var SIZES = { Small: 22, Medium: 28, Large: 36 };

  function applySize(size) {
    if (size && SIZES[size]) sizeName = size;
    if (overlay) overlay.style.fontSize = SIZES[sizeName] + 'px';
  }

  function srtToVtt(text) {
    var t = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    t = t.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    t = t.replace(/^\uFEFF/, '');
    if (t.indexOf('WEBVTT') !== 0) t = 'WEBVTT\n\n' + t;
    return t;
  }

  function parseCues(vttText) {
    var out = [];
    var blocks = String(vttText || '').split(/\n{2,}/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      var timeLine = null;
      var startLine = 0;
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('-->') >= 0) {
          timeLine = lines[j];
          startLine = j + 1;
          break;
        }
      }
      if (!timeLine) continue;
      var parts = timeLine.split('-->');
      var start = parseStamp(parts[0]);
      var end = parseStamp(parts[1]);
      if (start === null || end === null) continue;
      var text = lines.slice(startLine).join('\n').replace(/<[^>]+>/g, '');
      out.push({ start: start, end: end, text: text });
    }
    return out;
  }

  function parseStamp(value) {
    var m = u.trim(value).split(' ')[0].match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) * 3600 : 0) +
      Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  }

  function clear(videoEl) {
    token++;
    var v = videoEl || video;
    if (v) {
      var tracks = v.getElementsByTagName('track');
      while (tracks.length) {
        v.removeChild(tracks[0]);
      }
      try {
        var tt = v.textTracks;
        if (tt) {
          for (var i = tt.length - 1; i >= 0; i--) tt[i].mode = 'disabled';
        }
      } catch (e) { /* ignore */ }
    }
    cues = [];
    cueCache = {};
    langs = [];
    activeLang = '';
    lastText = null;
    if (timeHandler && video) {
      u.off(video, 'timeupdate', timeHandler);
      u.off(video, 'seeked', timeHandler);
      timeHandler = null;
    }
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function fetchText(url, cb) {
    var xhr = new XMLHttpRequest();
    var done = false;
    try {
      xhr.open('GET', url, true);
    } catch (e) {
      return cb('Subtitle request failed');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
      else cb('Subtitle unavailable');
    };
    xhr.onerror = function () {
      if (done) return;
      done = true;
      cb('Subtitle unavailable');
    };
    try {
      xhr.send(null);
    } catch (e) {
      cb('Subtitle unavailable');
    }
  }

  function findLang(lang) {
    for (var i = 0; i < langs.length; i++) {
      if (langs[i].language === lang) return langs[i];
    }
    return null;
  }

  function fetchCues(item, cb) {
    fetchText(CV.api.resolvePath(item.url), function (err, text) {
      if (err) return cb(null);
      var body = item.format === 'srt' ? srtToVtt(text) : text;
      var list = parseCues(body);
      cb(list && list.length ? list : null);
    });
  }

  function pickLang(preferred) {
    if (preferred === 'Off') return 'Off';
    for (var i = 0; i < langs.length; i++) {
      if (langs[i].language === preferred) return preferred;
    }
    for (var j = 1; j < langs.length; j++) {
      if (guessCode(langs[j].language) === 'en') return langs[j].language;
    }
    return langs.length > 1 ? langs[1].language : 'Off';
  }

  function guessCode(lang) {
    var l = String(lang || '').toLowerCase();
    if (l.indexOf('malayalam') === 0) return 'ml';
    if (l.indexOf('hindi') === 0) return 'hi';
    if (l.indexOf('tamil') === 0) return 'ta';
    if (l.indexOf('telugu') === 0) return 'te';
    if (l.indexOf('english') === 0) return 'en';
    if (l.indexOf('spanish') === 0) return 'es';
    if (l.indexOf('french') === 0) return 'fr';
    if (l.indexOf('german') === 0) return 'de';
    return 'en';
  }

  /**
   * @param videoEl  the single <video>
   * @param list     [{language, url, format}]
   * @param preferred preferred language label ('English')
   * @param onChange called with the active language after its cues load
   */
  function attach(videoEl, list, preferred, onChange) {
    video = videoEl;
    clear(videoEl);
    var myToken = token;

    langs = [{ language: 'Off', url: '' }];
    for (var i = 0; i < (list || []).length; i++) {
      langs.push(list[i]);
    }
    applySize(sizeName);

    if (!list || !list.length) return;

    var want = pickLang(preferred);
    setLang(want, function (active) {
      if (myToken !== token) return;
      if (onChange) onChange(active);
    });
  }

  function setLang(lang, done) {
    activeLang = lang;
    lastText = null;
    if (!video) {
      if (done) done(lang);
      return;
    }
    if (lang === 'Off') {
      cues = [];
      renderCue();
      if (done) done('Off');
      return;
    }

    var item = findLang(lang);
    if (!item) {
      cues = [];
      renderCue();
      if (done) done(lang);
      return;
    }

    var cacheKey = item.url;
    if (cueCache[cacheKey]) {
      cues = cueCache[cacheKey];
      ensureOverlay();
      bindCueEvents();
      renderCue();
      if (done) done(lang);
      return;
    }

    /* Clear the old language immediately; load the chosen file once. */
    cues = [];
    renderCue();
    var myToken = token;
    fetchCues(item, function (list) {
      if (myToken !== token || activeLang !== lang) return;
      cues = list || [];
      if (list) cueCache[cacheKey] = list;
      ensureOverlay();
      bindCueEvents();
      renderCue();
      if (done) done(lang);
    });
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = u.el('div');
    overlay.id = 'subs-overlay';
    overlay.style.position = 'absolute';
    overlay.style.left = '8%';
    overlay.style.right = '8%';
    overlay.style.bottom = '14%';
    overlay.style.textAlign = 'center';
    overlay.style.color = '#FFFFFF';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.55)';
    overlay.style.padding = '0.15rem 0.5rem';
    overlay.style.fontSize = SIZES[sizeName] + 'px';
    overlay.style.lineHeight = '1.35';
    overlay.style.zIndex = '4';
    overlay.style.whiteSpace = 'pre-wrap';
    overlay.style.pointerEvents = 'none';
    overlay.style.display = 'none';
    lastText = null;
    var host = video && video.parentNode;
    if (host) host.appendChild(overlay);
  }

  function bindCueEvents() {
    if (!video || timeHandler) return;
    timeHandler = function () { renderCue(); };
    u.on(video, 'timeupdate', timeHandler);
    u.on(video, 'seeked', timeHandler);
    /* A few TV engines fire timeupdate very sparsely. A low-frequency tick
       keeps the overlay in step with the video without touching playback. */
    tickTimer = setInterval(renderCue, 250);
  }

  function renderCue() {
    if (!overlay) return;
    var text = '';
    if (activeLang && activeLang !== 'Off' && video) {
      var t = video.currentTime || 0;
      for (var i = 0; i < cues.length; i++) {
        if (t >= cues[i].start && t <= cues[i].end) {
          text = cues[i].text;
          break;
        }
      }
    }
    if (text === lastText) return;
    lastText = text;
    overlay.innerHTML = '';
    if (!text) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = 'block';
    overlay.appendChild(document.createTextNode(text));
  }

  function langList() {
    return langs;
  }

  function active() {
    return activeLang;
  }

  function hasSubs() {
    return langs.length > 1;
  }

  return {
    attach: attach,
    clear: clear,
    setLang: setLang,
    setSize: applySize,
    langList: langList,
    active: active,
    hasSubs: hasSubs,
    srtToVtt: srtToVtt,
    parseCues: parseCues
  };
})();
