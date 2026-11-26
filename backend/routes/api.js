'use strict';

/**
 * API layer. Every route validates its input, caches successful upstream
 * results briefly, and answers with a small JSON object. Errors are always
 * `{ error: { code, message } }` so the TV can show one sentence instead of a
 * blank screen.
 */

var config = require('../config/config');
var providers = require('../providers');

var cache = new Map();

function cacheGet(key) {
  var hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= config.maxCacheEntries) {
    var oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value: value, expires: Date.now() + config.cacheTtlMs });
}

function fail(code, message, status) {
  var err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

var ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function intParam(value, fallback, min, max) {
  var n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function textParam(value, max) {
  if (value === undefined || value === null) return '';
  var s = String(value);
  if (s.length > max) s = s.substring(0, max);
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function idParam(value) {
  var s = String(value || '');
  if (!ID_RE.test(s)) throw fail('bad_id', 'Invalid content id', 400);
  return s;
}

function typeParam(value) {
  var t = String(value || 'all').toLowerCase();
  if (['all', 'movies', 'series'].indexOf(t) < 0) throw fail('bad_type', 'Invalid content type', 400);
  return t;
}

function ottParam(value) {
  if (!value) return '';
  var allowed = config.ottFilters.map(function (o) { return o.id; });
  var v = String(value).toLowerCase();
  if (allowed.indexOf(v) < 0) throw fail('bad_ott', 'Unknown platform filter', 400);
  return v;
}

function qualityParam(value) {
  var q = String(value || '');
  if (!q) return '';
  if (!/^[A-Za-z0-9 ().+-]{1,24}$/.test(q)) throw fail('bad_quality', 'Invalid quality', 400);
  return q;
}

function cached(key, producer) {
  var hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  return Promise.resolve(producer()).then(function (value) {
    cacheSet(key, value);
    return value;
  });
}

/**
 * @returns {Promise<{status:number, body:any}>}
 */
function handle(pathname, params) {
  var provider = providers.active();

  if (pathname === '/api/health') {
    var meta = provider.meta();
    return Promise.resolve({
      status: 200,
      body: {
        ok: true,
        app: 'CineVault TV',
        version: 1,
        provider: meta.provider,
        demo: !!meta.demo,
        configured: meta.configured !== false,
        missing: meta.missing || [],
        ottEnabled: !!meta.ottEnabled,
        serverTime: new Date().toISOString()
      }
    });
  }

  if (pathname === '/api/meta') {
    return Promise.resolve({ status: 200, body: provider.meta() });
  }

  if (pathname === '/api/home') {
    var homeParams = {
      page: intParam(params.page, 1, 1, 500),
      pageSize: intParam(params.pageSize, config.pageSize, 1, config.maxPageSize),
      type: typeParam(params.type),
      ott: ottParam(params.ott),
      lang: textParam(params.lang, 8).toLowerCase()
    };
    var homeKey = 'home:' + JSON.stringify(homeParams);
    return cached(homeKey, function () { return provider.home(homeParams); })
      .then(function (body) { return { status: 200, body: body }; });
  }

  if (pathname === '/api/search') {
    var q = textParam(params.q, 80);
    if (!q) throw fail('bad_query', 'Search text is required', 400);
    var searchParams = {
      q: q,
      page: intParam(params.page, 1, 1, 200),
      pageSize: intParam(params.pageSize, config.pageSize, 1, config.maxPageSize)
    };
    var searchKey = 'search:' + JSON.stringify(searchParams);
    return cached(searchKey, function () { return provider.search(searchParams); })
      .then(function (body) { return { status: 200, body: body }; });
  }

  if (pathname === '/api/details') {
    var detailId = idParam(params.id);
    return cached('details:' + detailId, function () { return provider.details(detailId); })
      .then(function (body) {
        if (!body) throw fail('not_found', 'Title not found', 404);
        return { status: 200, body: body };
      });
  }

  if (pathname === '/api/episodes') {
    var seriesId = idParam(params.id);
    var wantedSeason = params.season ? intParam(params.season, 1, 1, 200) : 0;
    var episodesKey = 'episodes:' + seriesId + ':' + wantedSeason;
    return cached(episodesKey, function () { return provider.episodes(seriesId, wantedSeason); })
      .then(function (body) {
        if (!body) throw fail('not_found', 'Series not found', 404);
        return { status: 200, body: body };
      });
  }

  if (pathname === '/api/playback') {
    var playId = idParam(params.id);
    var playParams = {
      id: playId,
      season: intParam(params.season, 1, 1, 200),
      episode: intParam(params.episode, 1, 1, 5000),
      quality: qualityParam(params.quality)
    };
    // Provider-issued identifiers only: they must look like ids, and the
    // provider validates them against the title before using them.
    if (params.resourceId) playParams.resourceId = idParam(params.resourceId);
    if (params.audioSubjectId) playParams.audioSubjectId = idParam(params.audioSubjectId);
    // Playback URLs are short-lived upstream, so this is cached only for a
    // very short window to collapse accidental double taps.
    var playKey = 'play:' + JSON.stringify(playParams) + ':' + Math.floor(Date.now() / 15000);
    return cached(playKey, function () { return provider.playback(playParams); })
      .then(function (body) {
        if (!body) throw fail('not_found', 'Playback information unavailable', 404);
        return { status: 200, body: body };
      });
  }

  if (pathname === '/api/channels') {
    var channelParams = {
      country: textParam(params.country, 6).toUpperCase(),
      category: textParam(params.category, 40),
      q: textParam(params.q, 60)
    };
    var channelKey = 'channels:' + JSON.stringify(channelParams);
    return cached(channelKey, function () { return provider.channels(channelParams); })
      .then(function (body) { return { status: 200, body: body }; });
  }

  if (pathname === '/api/channel') {
    var channelId = idParam(params.id);
    var info = provider.channelStream ? provider.channelStream(channelId) : null;
    if (!info) throw fail('not_found', 'Channel unavailable', 404);
    return Promise.resolve({ status: 200, body: info });
  }

  throw fail('not_found', 'Unknown endpoint', 404);
}

module.exports = {
  handle: handle,
  clearCache: function () { cache.clear(); }
};
