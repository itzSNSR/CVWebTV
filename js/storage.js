/* CineVault TV — storage.js
   Small, bounded local data: preferences, six resume slots, watchlist,
   Live TV favourites. Every write is guarded; a TV with a broken
   localStorage still runs (the data just does not survive a restart). */

var CV = window.CV || {};
window.CV = CV;

CV.store = (function () {
  var PREFIX = 'cvtv.';
  var memory = {};
  var available = false;

  try {
    window.localStorage.setItem(PREFIX + 'probe', '1');
    window.localStorage.removeItem(PREFIX + 'probe');
    available = true;
  } catch (e) {
    available = false;
  }

  function getRaw(key) {
    if (available) {
      try { return window.localStorage.getItem(PREFIX + key); } catch (e) { /* fall through */ }
    }
    return memory.hasOwnProperty(key) ? memory[key] : null;
  }

  function setRaw(key, value) {
    memory[key] = value;
    if (available) {
      try { window.localStorage.setItem(PREFIX + key, value); } catch (e) { /* quota or blocked */ }
    }
  }

  function removeRaw(key) {
    delete memory[key];
    if (available) {
      try { window.localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    }
  }

  function read(key, fallback) {
    var raw = getRaw(key);
    if (raw === null || raw === '') return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      setRaw(key, JSON.stringify(value));
    } catch (e) {
      /* value not serialisable: keep the old data rather than corrupt it */
    }
  }

  return {
    available: available,
    read: read,
    write: write,
    remove: removeRaw,
    clearAll: function () {
      var i;
      if (available) {
        try {
          var drop = [];
          for (i = 0; i < window.localStorage.length; i++) {
            var k = window.localStorage.key(i);
            if (k && k.indexOf(PREFIX) === 0) drop.push(k);
          }
          for (i = 0; i < drop.length; i++) window.localStorage.removeItem(drop[i]);
        } catch (e) { /* ignore */ }
      }
      memory = {};
    }
  };
})();

/* ------------------------------------------------------------- preferences */

CV.prefs = (function () {
  var defaults = {
    quality: '1080p',       /* preferred, falls back to the best available below */
    subtitleLang: 'English',
    subtitleSize: 'Medium', /* Small | Medium | Large */
    lastCountry: 'ALL'
  };

  function get(key) {
    var value = CV.store.read('pref.' + key, null);
    return value === null ? defaults[key] : value;
  }

  function set(key, value) {
    CV.store.write('pref.' + key, value);
  }

  function all() {
    var out = {};
    var k = CV.util.keys(defaults);
    for (var i = 0; i < k.length; i++) out[k[i]] = get(k[i]);
    return out;
  }

  return { get: get, set: set, all: all, defaults: defaults };
})();

/* --------------------------------------------------- continue watching (6) */

CV.resume = (function () {
  var LIMIT = 6;
  var KEY = 'resume';

  function list() {
    var data = CV.store.read(KEY, []);
    return data instanceof Array ? data : [];
  }

  function save(data) {
    CV.store.write(KEY, data.slice(0, LIMIT));
  }

  function get(id, season, episode) {
    var data = list();
    for (var i = 0; i < data.length; i++) {
      if (data[i].id === id &&
        (data[i].season || 0) === (season || 0) &&
        (data[i].episode || 0) === (episode || 0)) return data[i];
    }
    /* For a series, fall back to the series-level record. */
    for (var j = 0; j < data.length; j++) {
      if (data[j].id === id) return data[j];
    }
    return null;
  }

  /**
   * One entry per title (for a series: the current season/episode only).
   * A seventh title evicts the oldest entry. A re-played title moves to the
   * front instead of creating a duplicate.
   */
  function put(entry) {
    if (!entry || !entry.id || !(entry.time > 0)) return;
    var data = list();
    var out = [{
      id: entry.id,
      type: entry.type || 'movie',
      title: entry.title || '',
      poster: entry.poster || '',
      season: entry.season || 0,
      episode: entry.episode || 0,
      episodeTitle: entry.episodeTitle || '',
      time: Math.floor(entry.time),
      duration: Math.floor(entry.duration || 0),
      updated: new Date().getTime()
    }];

    for (var i = 0; i < data.length && out.length < LIMIT; i++) {
      if (data[i].id !== entry.id) out.push(data[i]);
    }
    save(out);
  }

  function remove(id) {
    var data = list();
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (data[i].id !== id) out.push(data[i]);
    }
    save(out);
  }

  function clear() {
    save([]);
  }

  return { list: list, get: get, put: put, remove: remove, clear: clear, LIMIT: LIMIT };
})();

/* ---------------------------------------------------------------- watchlist */

CV.watchlist = (function () {
  var LIMIT = 20;
  var KEY = 'watchlist';

  function list() {
    var data = CV.store.read(KEY, []);
    return data instanceof Array ? data : [];
  }

  function has(id) {
    var data = list();
    for (var i = 0; i < data.length; i++) {
      if (data[i].id === id) return true;
    }
    return false;
  }

  function toggle(item) {
    var data = list();
    var out = [];
    var removed = false;
    for (var i = 0; i < data.length; i++) {
      if (data[i].id === item.id) removed = true;
      else out.push(data[i]);
    }
    if (!removed) {
      out.unshift({
        id: item.id,
        name: item.name,
        poster: item.poster,
        year: item.year || null,
        isTvShow: !!item.isTvShow
      });
      if (out.length > LIMIT) out = out.slice(0, LIMIT);
    }
    CV.store.write(KEY, out);
    return !removed;
  }

  function clear() {
    CV.store.write(KEY, []);
  }

  return { list: list, has: has, toggle: toggle, clear: clear, LIMIT: LIMIT };
})();

/* ---------------------------------------------------- live TV favourites */

CV.favs = (function () {
  var KEY = 'favs';
  var LIMIT = 40;

  function list() {
    var data = CV.store.read(KEY, []);
    return data instanceof Array ? data : [];
  }

  function has(id) {
    return CV.util.indexOf(list(), id) >= 0;
  }

  function toggle(id) {
    var data = list();
    var idx = CV.util.indexOf(data, id);
    if (idx >= 0) data.splice(idx, 1);
    else data.unshift(id);
    CV.store.write(KEY, data.slice(0, LIMIT));
    return idx < 0;
  }

  function clear() {
    CV.store.write(KEY, []);
  }

  return { list: list, has: has, toggle: toggle, clear: clear };
})();
