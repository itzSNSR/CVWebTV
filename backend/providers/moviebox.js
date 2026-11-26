'use strict';

/**
 * MovieBox provider adapter.
 *
 * Endpoint shapes, parameter names and response parsing are taken from the
 * CineVault Android client (data/network/MovieBoxApi.kt and the mock server
 * that reproduces the official API). Nothing is invented: season/episode data
 * comes from subject-api/season-info/v2, playback from subject-api/play-info/v2,
 * subtitles from get-ext-captions / get-stream-captions.
 *
 * Credentials (base URL, application signing key, session cookie) come from the
 * environment. They are never logged, never returned to the TV and never
 * written to disk. Without them every route answers 503 provider_not_configured.
 */

var https = require('https');
var http = require('http');

var config = require('../config/config');
var auth = require('../auth/movieboxSigner');
var session = require('../auth/movieboxSession');
var mediaProxy = require('../mediaProxy');

var STATUS = {
  BAD_BASE: 'provider_not_configured',
  NO_KEY: 'provider_not_configured',
  UNAUTHORIZED: 'provider_unauthorized',
  TOKEN: 'provider_token_required',
  NOT_FOUND: 'not_found',
  RATE: 'provider_rate_limited',
  UPSTREAM: 'upstream_error',
  TIMEOUT: 'upstream_timeout',
  BAD_JSON: 'upstream_bad_json'
};

function fail(code, message, status) {
  var e = new Error(message);
  e.code = code;
  e.status = status || 502;
  return e;
}

/* ------------------------------------------------------------------ config */

function missing() {
  var out = [];
  if (!config.moviebox.baseUrl) out.push('MOVIEBOX_BASE_URL');
  return out.concat(auth.missing());
}

function configured() {
  return missing().length === 0;
}

function notConfigured() {
  var miss = missing();
  return fail(STATUS.BAD_BASE,
    'MovieBox is not configured on this server. Missing: ' + miss.join(', ') + '.', 503);
}

/* Signing lives in backend/auth/movieboxSigner.js; the adapter only asks it
   for a header set. Credentials stay on the server. */

/* ----------------------------------------------------------------- request */

var sessionCookie = '';
var lastSessionRefresh = 0;

function requestOnce(path, method, bodyString) {
  return new Promise(function (resolve, reject) {
    var target;
    try {
      target = new URL(path, config.moviebox.baseUrl);
    } catch (e) {
      return reject(fail(STATUS.BAD_BASE, 'MOVIEBOX_BASE_URL is not a valid URL.', 503));
    }
    var lib = target.protocol === 'http:' ? http : https;
    // The authentication module canonicalises the query itself and supplies
    // the newer app profile. A visitor token is attached when one is cached.
    var headers = auth.signOfficial(method || 'GET', target.pathname + target.search,
      bodyString, session.peekToken());
    if (sessionCookie) headers.Cookie = sessionCookie;

    var req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: method || 'GET',
      headers: headers,
      timeout: config.requestTimeoutMs
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var setCookie = res.headers['set-cookie'];
        if (setCookie) {
          for (var i = 0; i < setCookie.length; i++) {
            if (setCookie[i].indexOf('session_id') >= 0) {
              sessionCookie = setCookie[i].split(';')[0];
              lastSessionRefresh = Date.now();
            }
          }
        }
        var text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 441 ||
            ((res.statusCode === 401 || res.statusCode === 403) &&
              /token|jwt|unauthorized|miss token/i.test(text))) {
          return reject(fail(STATUS.TOKEN,
            'MovieBox requires a session token for details and playback.', 502));
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(fail(STATUS.UNAUTHORIZED,
            'MovieBox rejected the request. The signing key or session has no access to this content.', 502));
        }
        if (res.statusCode === 404) {
          return reject(fail(STATUS.NOT_FOUND, 'Content not found upstream.', 404));
        }
        if (res.statusCode === 429) {
          return reject(fail(STATUS.RATE, 'MovieBox is rate limiting this server. Try again shortly.', 503));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(fail(STATUS.UPSTREAM, 'MovieBox returned HTTP ' + res.statusCode + '.', 502));
        }
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return reject(fail(STATUS.BAD_JSON, 'MovieBox returned a response that is not JSON.', 502));
        }
        if (json && typeof json.code === 'number' && json.code !== 0 && json.code !== 200 && json.code !== 1) {
          return reject(fail(STATUS.UPSTREAM,
            'MovieBox error ' + json.code + (json.message ? ' (' + String(json.message).slice(0, 120) + ')' : ''), 502));
        }
        resolve(json);
      });
    });

    req.on('timeout', function () {
      req.destroy(new Error('timeout'));
    });
    req.on('error', function (e) {
      if (e.code === STATUS.BAD_BASE) return reject(e);
      var timedOut = /timeout/i.test(e.message || '');
      reject(fail(timedOut ? STATUS.TIMEOUT : STATUS.UPSTREAM,
        timedOut ? 'MovieBox did not answer in time.' : 'Could not reach MovieBox.', 502));
    });
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

/** One retry for reads; never retried: playback (session URLs expire fast). */
function request(path, options) {
  options = options || {};
  if (!configured()) return Promise.reject(notConfigured());
  var method = options.method || 'GET';
  var body = options.body ? JSON.stringify(options.body) : null;
  var attempts = options.noRetry ? 1 : 2;
  var tokenRetried = false;

  function tokenReady() {
    if (!options.requiresToken || !session.enabled()) return Promise.resolve();
    return session.getToken();
  }

  function attempt(n) {
    return tokenReady()
      .then(function () { return requestOnce(path, method, body); })
      .catch(function (e) {
        // A cached visitor token can expire or be rejected: refresh once.
        if (e.code === STATUS.TOKEN && session.enabled() && !tokenRetried) {
          tokenRetried = true;
          session.clear();
          return session.getToken(true).then(function () {
            return requestOnce(path, method, body);
          });
        }
        var retryable = e.code === STATUS.UPSTREAM || e.code === STATUS.TIMEOUT;
        if (n < attempts && retryable) {
          return new Promise(function (r) { setTimeout(r, config.retryDelayMs); })
            .then(function () { return attempt(n + 1); });
        }
        throw e;
      });
  }
  return attempt(1);
}

/**
 * Tries the documented path first and falls back to its sibling variant.
 * The Retrofit interface names `play-info` while the reference server uses
 * `play-info/v2`; which one a region answers is not something this project
 * can assume, so a 404 simply moves to the next candidate.
 */
function tryPaths(paths, queryParams, options) {
  var index = 0;
  function attempt() {
    if (index >= paths.length) {
      return Promise.reject(fail(STATUS.UPSTREAM,
        'No known endpoint variant answered (' + paths.join(', ') + ').', 502));
    }
    var candidate = paths[index++];
    return request('/' + candidate + query(queryParams), options).catch(function (e) {
      if (e.code === STATUS.NOT_FOUND) return attempt();
      throw e;
    });
  }
  return attempt();
}

function query(params) {
  var parts = [];
  Object.keys(params).forEach(function (k) {
    var v = params[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/* ------------------------------------------------------------ normalisation */

function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'null') return v;
  }
  return null;
}

function asNumber(v) {
  var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isFinite(n) ? n : 0;
}

/**
 * Poster selection. Cards ask for the smallest variant the provider offers
 * (thumbUrl before webpUrl before url) so a 148 px wide card does not pull a
 * full-resolution backdrop. Details ask for the largest.
 */
function imageUrl(value, size) {
  if (!value) return null;
  var raw;
  if (typeof value === 'string') {
    raw = value;
  } else if (typeof value === 'object') {
    raw = size === 'large'
      ? pick(value.url, value.webpUrl, value.thumbUrl)
      : pick(value.thumbUrl, value.webpUrl, value.url);
  }
  if (!raw) return null;
  raw = String(raw).trim();
  if (raw.indexOf('//') === 0) raw = 'https:' + raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  /* Relative paths are kept and resolved by the client against the API origin.
     MovieBox itself returns absolute URLs; this only avoids dropping a provider
     that returns CDN-relative artwork. */
  if (/^\/[^/]/.test(raw) || /^[a-z0-9._-]+\//i.test(raw)) return raw;
  return null;
}

function posterOf(item, size) {
  return imageUrl(pick(item.poster, item.cover, item.horizontalPoster, item.horizontalCover), size);
}

function backdropOf(item) {
  return imageUrl(pick(item.horizontalPoster, item.horizontalCover, item.banner, item.cover, item.poster), 'large');
}

function genresOf(item) {
  var raw = pick(item.genres, item.genre, item.cats, item.category);
  var out = [];
  if (Array.isArray(raw)) {
    raw.forEach(function (g) {
      if (g !== null && typeof g !== 'object') out.push(String(g));
      else if (g && g.name) out.push(String(g.name));
    });
  } else if (typeof raw === 'string') {
    out = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return out;
}

/** Language names the provider itself attaches to a title. */
function languagesOf(item) {
  var out = [];
  var raw = pick(item.dubs, item.audioList, item.languages, item.audio);
  if (Array.isArray(raw)) {
    raw.forEach(function (d) {
      var name = d && typeof d === 'object'
        ? pick(d.lanName, d.name, d.language, d.lan)
        : d;
      if (name) out.push(String(name).trim());
    });
  } else if (typeof raw === 'string') {
    out = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return out;
}

function isShow(item) {
  var typeVal = pick(item.subjectType, item.type, item.subject_type);
  var typeNum = asNumber(typeVal);
  if (typeNum === 2) return true;
  if (typeNum === 1) return false;
  return !!(item.seNum || item.episodeCount || item.seasonCount ||
    (Array.isArray(item.seasons) && item.seasons.length) ||
    (Array.isArray(item.seasonList) && item.seasonList.length));
}

function ratingOf(item) {
  var raw = pick(item.imdbRatingValue, item.imdbRate, item.starRating, item.score, item.rating);
  if (raw === null) return null;
  var value = String(raw).trim();
  if (value === '0' || value === '0.0') return null;
  return value;
}

function yearOf(item) {
  var raw = pick(item.releaseDate, item.releaseTime, item.year);
  if (!raw) return null;
  var s = String(raw).trim();
  return /^\d{4}/.test(s) ? s.substring(0, 4) : null;
}

function durationOf(item) {
  var raw = pick(item.duration, item.runtime, item.minute);
  if (raw === null) return null;
  var s = String(raw).trim();
  /* The Android adapter treats 0 as "unknown", not as a zero-length title. */
  if (s === '0' || s === '0.0' || s === '') return null;
  if (/^\d+$/.test(s)) return s + ' min';
  return s;
}

/** List/card payload: small, no description, no streams. */
function toCard(item) {
  var id = String(pick(item.subjectId, item.id) || '');
  if (!id) return null;
  var langs = languagesOf(item);
  return {
    id: id,
    name: String(pick(item.title, item.name, item.subjectName, item.titleName, item.show_name) || 'Untitled'),
    poster: posterOf(item, 'card'),
    year: yearOf(item),
    rating: ratingOf(item),
    isTvShow: isShow(item),
    duration: durationOf(item),
    language: langs.length ? langs[0] : null,
    languages: langs.slice(0, 6),
    ott: null
  };
}

function toSubject(item) {
  var card = toCard(item);
  if (!card) return null;
  card.description = String(pick(item.description, item.desc, item.summary) || '');
  card.backdrop = backdropOf(item);
  card.genres = genresOf(item);
  card.audioLanguages = dubsOf(item);
  card.seasons = seasonsSummary(item);
  return card;
}

function seasonsSummary(item) {
  var raw = pick(item.seasons, item.seasonList);
  if (!Array.isArray(raw)) {
    var count = asNumber(pick(item.seasonCount, item.seNum));
    return count > 1 ? [{ season: 1, episodeCount: 0 }].concat([]) : [];
  }
  return raw.map(function (s) {
    var season = asNumber(pick(s.se, s.seasonNumber, s.season)) || 1;
    var eps = episodePool(s);
    return { season: season, episodeCount: eps.length };
  }).sort(function (a, b) { return a.season - b.season; });
}

/** Audio language options. Each dubbed version is its own provider subject. */
function dubsOf(item) {
  var raw = pick(item.dubs, item.audioList);
  var out = [];
  if (!Array.isArray(raw)) return out;
  raw.forEach(function (d) {
    if (!d || typeof d !== 'object') return;
    var language = pick(d.lanName, d.name, d.language);
    var subjectId = pick(d.subjectId, d.id);
    if (!language || !subjectId) return;
    out.push({
      language: String(language),
      subjectId: String(subjectId),
      resourceId: d.resourceId ? String(d.resourceId) : null,
      original: d.original === true || /orig/i.test(String(d.lanName || ''))
    });
  });
  return out;
}

function episodePool(season) {
  var pool = pick(season.allEp, season.epList, season.episodeList, season.episodes, season.list, season.items);
  var out = [];
  if (typeof pool === 'string') {
    pool.split(',').forEach(function (v) {
      var n = asNumber(v);
      if (n) out.push({ episode: n, title: 'Episode ' + n, duration: '' });
    });
  } else if (Array.isArray(pool)) {
    pool.forEach(function (e) {
      if (e && typeof e === 'object') {
        var n = asNumber(pick(e.ep, e.episodeNumber, e.episode_number, e.episode));
        if (!n) return;
        out.push({
          episode: n,
          title: String(pick(e.title, e.name) || ('Episode ' + n)),
          duration: String(pick(e.duration, e.runtime) || '')
        });
      } else {
        var num = asNumber(e);
        if (num) out.push({ episode: num, title: 'Episode ' + num, duration: '' });
      }
    });
  }
  if (!out.length) {
    // Fall back to the counts the provider reports per resolution.
    var counts = pick(season.resolutionEpCounts, season.resEpCounts);
    var max = 0;
    if (counts && typeof counts === 'object') {
      Object.keys(counts).forEach(function (k) { max = Math.max(max, asNumber(counts[k])); });
    } else {
      var res = pick(season.resolutions);
      if (Array.isArray(res)) {
        res.forEach(function (r) {
          if (r && typeof r === 'object') max = Math.max(max, asNumber(pick(r.epNum, r.episodeCount)));
        });
      }
    }
    for (var i = 1; i <= max && i <= 400; i++) {
      out.push({ episode: i, title: 'Episode ' + i, duration: '' });
    }
  }
  out.sort(function (a, b) { return a.episode - b.episode; });
  return out;
}

/* ------------------------------------------------------- OTT classification */

var ottCache = new Map();

function tmdbRequest(path) {
  return new Promise(function (resolve) {
    if (!config.tmdb.apiKey) return resolve(null);
    var target = 'https://api.themoviedb.org/3/' + path +
      (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(config.tmdb.apiKey);
    var req = https.get(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'CineVaultTV/1.0' },
      timeout: 8000
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}

/**
 * Platform id for one title, only from a real TMDB watch-provider match.
 * Cached for a day; failures cache as null so a bad key costs one call, not one
 * per title.
 */
function ottFor(card) {
  if (!config.tmdb.apiKey) return Promise.resolve(null);
  var key = card.id;
  var hit = ottCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);

  var kind = card.isTvShow ? 'tv' : 'movie';
  var query = 'search/' + kind + '?query=' + encodeURIComponent(card.name) +
    (card.year ? '&year=' + card.year : '') + '&language=en-US';

  return tmdbRequest(query).then(function (search) {
    var first = search && search.results && search.results[0];
    if (!first) return null;
    return tmdbRequest(kind + '/' + first.id + '/watch/providers').then(function (providers) {
      var region = providers && providers.results && providers.results[config.tmdb.region];
      var list = (region && (region.flatrate || region.free || region.ads)) || [];
      var found = null;
      Object.keys(config.tmdb.providers).forEach(function (id) {
        if (found) return;
        var providerId = config.tmdb.providers[id];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].provider_id === providerId) {
            found = id;
            return;
          }
        }
      });
      return found;
    });
  }).then(function (value) {
    ottCache.set(key, { value: value, expires: Date.now() + config.tmdb.cacheTtlMs });
    if (ottCache.size > 600) {
      var firstKey = ottCache.keys().next().value;
      ottCache.delete(firstKey);
    }
    return value;
  });
}

function applyOtt(cards, filter) {
  if (!cards.length) return Promise.resolve(cards);
  if (!filter && !config.tmdb.apiKey) return Promise.resolve(cards);

  var slice = cards.slice(0, filter ? 24 : 14);
  var rest = cards.slice(slice.length);
  var index = 0;
  var workers = [];

  function worker() {
    if (index >= slice.length) return Promise.resolve();
    var card = slice[index++];
    return ottFor(card).then(function (platform) {
      card.ott = platform;
      return worker();
    });
  }
  for (var i = 0; i < 3; i++) workers.push(worker());

  return Promise.all(workers).then(function () {
    var all = slice.concat(rest);
    if (!filter) return all;
    return all.filter(function (c) {
      return filter === 'all' ? true : c.ott === filter;
    });
  });
}

/* --------------------------------------------------------------- catalogue */

function cardsFrom(json) {
  var data = (json && json.data) || {};
  var list = [];
  var pools = [data.list, data.items, data.subjects, data.sections, Array.isArray(data) ? data : null];
  for (var i = 0; i < pools.length; i++) {
    var pool = pools[i];
    if (!Array.isArray(pool)) continue;
    pool.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      if (Array.isArray(entry.items)) {
        entry.items.forEach(function (it) { list.push(it); });
      } else {
        list.push(entry.subject && typeof entry.subject === 'object' ? entry.subject : entry);
      }
    });
    if (list.length) break;
  }
  var seen = {};
  var out = [];
  list.forEach(function (item) {
    var card = toCard(item);
    if (!card || seen[card.id]) return;
    seen[card.id] = true;
    out.push(card);
  });
  return out;
}

function fetchTrending(pageSize) {
  return request('/wefeed-mobile-bff/subject-api/trending/v2?page=1&pageSize=' + pageSize)
    .then(cardsFrom);
}

function fetchCategory(categoryId, page, pageSize) {
  return request('/home/v2/get-list', {
    method: 'POST',
    body: { categoryId: categoryId, page: page, pageSize: pageSize }
  }).then(cardsFrom);
}

function fetchRanking(page, perPage) {
  return request('/wefeed-mobile-bff/tab/ranking-list?tabId=2&categoryType=all&page=' +
    page + '&perPage=' + perPage).then(cardsFrom);
}

function filterType(cards, type) {
  if (!type || type === 'all') return cards;
  if (type === 'movies') return cards.filter(function (c) { return !c.isTvShow; });
  return cards.filter(function (c) { return !!c.isTvShow; });
}

function dedupe(lists) {
  var seen = {};
  var out = [];
  lists.forEach(function (list) {
    (list || []).forEach(function (c) {
      if (seen[c.id]) return;
      seen[c.id] = true;
      out.push(c);
    });
  });
  return out;
}

function isLanguage(card, names) {
  var langs = card.languages || [];
  for (var i = 0; i < langs.length; i++) {
    var l = String(langs[i]).toLowerCase();
    for (var j = 0; j < names.length; j++) {
      if (l === names[j] || l.indexOf(names[j]) === 0) return true;
    }
  }
  return false;
}

function home(params) {
  var page = params.page || 1;
  var pageSize = Math.min(params.pageSize || config.pageSize, config.maxPageSize);
  var type = params.type || 'all';
  var ott = params.ott || '';

  // Four bounded upstream reads, in parallel. Nothing is fetched per card.
  // Configuration and authorisation failures are not swallowed: they must reach
  // the TV as a real error, never as an empty catalogue.
  return Promise.all([
    fetchTrending(pageSize),
    fetchCategory(config.moviebox.categoryMovies, page, pageSize),
    fetchCategory(config.moviebox.categorySeries, page, pageSize),
    page === 1 ? fetchRanking(1, pageSize) : Promise.resolve([])
  ].map(function (p) {
    return p.then(function (cards) { return { ok: true, cards: cards }; })
      .catch(function (e) { return { ok: false, error: e, cards: [] }; });
  }))
    .then(function (results) {
      var fatal = null;
      results.forEach(function (r) {
        if (r.ok || !r.error) return;
        if (r.error.code === 'provider_not_configured' || r.error.code === 'provider_unauthorized') fatal = r.error;
      });
      if (fatal) throw fatal;

      var trending = results[0].cards;
      var movies = results[1].cards;
      var series = results[2].cards;
      var ranking = results[3].cards;

      var latest = filterType(dedupe([ranking, movies, series]), type);
      var trending2 = filterType(trending, type);
      var malayalam = dedupe([latest, trending2]).filter(function (c) {
        return isLanguage(c, config.languageSections.malayalam);
      });

      if (!latest.length && !trending2.length) {
        var upstream = null;
        results.forEach(function (r) { if (!r.ok && r.error && !upstream) upstream = r.error; });
        if (upstream) throw upstream;
        throw fail('empty_catalogue', 'MovieBox returned no titles for this filter.', 502);
      }

      return applyOtt(dedupe([latest, trending2]).slice(0, 30), ott).then(function (withOtt) {
        var allowed = {};
        withOtt.forEach(function (c) { allowed[c.id] = true; });
        function keep(cards) {
          if (!ott) return cards;
          return cards.filter(function (c) { return allowed[c.id]; });
        }

        var sections = [];
        if (keep(latest).length) {
          sections.push({ id: 'latest', title: 'Latest Releases', items: keep(latest).slice(0, pageSize) });
        }
        if (keep(trending2).length) {
          sections.push({ id: 'trending', title: 'Trending Movies & Series', items: keep(trending2).slice(0, pageSize) });
        }
        var malayalamFiltered = keep(malayalam);
        if (malayalamFiltered.length) {
          sections.push({ id: 'malayalam', title: 'Malayalam Movies & Series', items: malayalamFiltered.slice(0, pageSize) });
        }
        if (keep(movies).length) {
          sections.push({ id: 'movies', title: 'Movies', items: keep(movies).slice(0, pageSize) });
        }
        if (keep(series).length) {
          sections.push({ id: 'series', title: 'Series', items: keep(series).slice(0, pageSize) });
        }

        return {
          sections: sections,
          page: page,
          hasMore: latest.length >= pageSize || trending2.length >= pageSize,
          provider: 'moviebox',
          ottFilterApplied: !!ott,
          ottUnavailable: !!ott && !config.tmdb.apiKey
            ? 'Platform filters need TMDB_API_KEY on the server; without it no title carries a platform badge.'
            : null
        };
      });
    });
}

function search(params) {
  var page = params.page || 1;
  var pageSize = params.pageSize || config.pageSize;
  // The newer API takes search as a signed POST body, not query parameters.
  // It also requires the host query like subject-api/get.
  return request('/wefeed-mobile-bff/subject-api/search' + query({ host: hostParam() }), {
    method: 'POST',
    body: { keyword: params.q, page: page, pageSize: pageSize },
    requiresToken: true
  }).then(function (json) {
    var cards = cardsFrom(json);
    return {
      items: cards,
      page: page,
      hasMore: cards.length >= pageSize,
      total: cards.length,
      provider: 'moviebox'
    };
  });
}

function detailRequest(id) {
  return request('/wefeed-mobile-bff/subject-api/get' + query({ subjectId: id, host: hostParam() }),
    { requiresToken: true })
    .then(function (json) {
      var data = (json && json.data) || json;
      if (!data || typeof data !== 'object') return null;
      return data.subject && typeof data.subject === 'object' ? data.subject : data;
    });
}

function hostParam() {
  if (config.moviebox.host) return config.moviebox.host;
  try {
    return new URL(config.moviebox.baseUrl).hostname;
  } catch (e) {
    return 'api.inmoviebox.com';
  }
}

function details(id) {
  return detailRequest(id).then(function (item) {
    return item ? toSubject(item) : null;
  });
}

function seasons(id) {
  return tryPaths(config.moviebox.seasonInfoPaths, { subjectId: id }, { requiresToken: true })
    .then(function (json) {
      var data = (json && json.data) || json || {};
      var raw = data.seasons || data.seasonList || data.list || [];
      return (Array.isArray(raw) ? raw : []).map(function (s) {
        return {
          season: asNumber(pick(s.se, s.seasonNumber, s.season)) || 1,
          episodes: episodePool(s)
        };
      }).sort(function (a, b) { return a.season - b.season; });
    })
    .catch(function (e) {
      // Series can be listed without season metadata; the caller reports it.
      if (e.code === STATUS.NOT_FOUND) return [];
      throw e;
    });
}

function episodes(id, seasonWanted) {
  return Promise.all([
    detailRequest(id),
    // A title can legitimately have no season metadata; the detail response is
    // then used to describe the seasons instead of failing the whole screen.
    seasons(id).catch(function () { return []; })
  ]).then(function (r) {
    var item = r[0];
    var list = r[1];
    if (!item) return null;

    if (!list.length) {
      var inline = seasonsSummary(item);
      if (!inline.length) {
        throw fail('episodes_unavailable',
          'MovieBox did not return season or episode data for this title.', 404);
      }
      list = inline.map(function (s) { return { season: s.season, episodes: [] }; });
    }

    var summary = list.map(function (s) {
      return { season: s.season, episodeCount: s.episodes.length };
    });
    var chosen = seasonWanted ? list.filter(function (s) { return s.season === seasonWanted; }) : [list[0]];
    if (!chosen.length) return null;

    return {
      id: id,
      name: String(pick(item.title, item.name, item.subjectName) || 'Series'),
      seasons: summary,
      season: chosen[0].season,
      episodes: chosen[0].episodes
    };
  });
}

/* ---------------------------------------------------------------- playback */

function bestDisplayQuality(raw) {
  var labels = String(raw || '').split(',').map(function (value) {
    return value.replace(/[^0-9kK]/g, '').trim();
  }).filter(Boolean);
  if (!labels.length) return '';
  labels.sort(function (a, b) { return rank(b) - rank(a); });
  return qualityLabel(labels[0]);
}

function qualityLabel(raw) {
  var n = asNumber(raw);
  if (n && config.moviebox.qualityLabels[n]) return config.moviebox.qualityLabels[n];
  if (n) return n + 'p';
  var s = String(raw || '').trim();
  if (/auto/i.test(s)) return 'Auto';
  if (/4k|2160/i.test(s)) return '4K';
  return s || 'Auto';
}

function flattenStreams(rawStreams) {
  var out = [];
  var seen = {};
  (rawStreams || []).forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    var nested = pick(s.resolutions, s.variants, s.qualities);
    if (Array.isArray(nested) && nested.length) {
      nested.forEach(function (v) {
        var url = String(pick(v.url, v.src) || '');
        if (!url || seen[url]) return;
        seen[url] = true;
        out.push({
          quality: qualityLabel(pick(v.resolution, v.quality, v.definition)),
          url: url,
          size: String(pick(v.size, v.fileSize) || ''),
          language: null
        });
      });
      return;
    }
    var direct = String(pick(s.url, s.src) || '');
    if (!direct || seen[direct]) return;
    seen[direct] = true;
    out.push({
      quality: qualityLabel(pick(s.quality, s.resolution, s.definition)),
      url: direct,
      size: String(pick(s.size, s.fileSize) || ''),
      language: s.lanName ? String(s.lanName) : null
    });
  });

  out.sort(function (a, b) { return rank(b.quality) - rank(a.quality); });
  return out;
}

function rank(label) {
  var n = asNumber(label);
  if (n) return n;
  if (/4k|2160/i.test(label)) return 2160;
  if (/auto/i.test(label)) return 1;
  return 0;
}

/* ----------------------------------------------------------- UGC fallback */

/*
 * MovieBox sometimes answers play-info with a single "please update" asset on
 * macdn.aoneroom.com (always 23 seconds, always the same file). The Android
 * client treats that as a dummy and resolves the real file through its UGC
 * endpoints. This is not an account-only path: the guest token can read it.
 */
var UGC_DUMMY_RE = /macdn\.aoneroom\.com|please_update|update_app|b164fbfb43/i;

function isDummyStream(stream) {
  return !stream || !stream.url || UGC_DUMMY_RE.test(String(stream.url));
}

function isDummyStreams(streams) {
  return !streams.length || streams.every(isDummyStream);
}

function qualityFromResource(res) {
  var raw = pick(res.resolutions, res.resolution, res.quality, res.definition);
  if (Array.isArray(raw)) raw = raw[0];
  return qualityLabel(String(raw || '').split(',')[0]);
}

function ugcStreamsFromResources(resources, seen) {
  var out = [];
  (resources || []).forEach(function (res) {
    if (!res || typeof res !== 'object') return;
    var raw = String(pick(res.url, res.src, res.downloadUrl) || '');
    if (!raw || UGC_DUMMY_RE.test(raw) || seen[raw]) return;
    // The TV plays progressive MP4 natively. HLS manifests would need a
    // separate segment rewriter, and MovieBox's UGC resources are MP4.
    if (/\.m3u8(\?|$)/i.test(raw)) return;
    seen[raw] = true;

    var headers = {};
    var cookie = String(res.signCookie || '');
    if (cookie && cookie.indexOf('urlprefix=') < 0) headers.Cookie = cookie;

    out.push({
      quality: qualityFromResource(res),
      url: mediaProxy.register(raw, headers),
      size: String(pick(res.size, res.fileSize) || ''),
      duration: asNumber(pick(res.duration, res.runtime)) || null,
      language: null
    });
  });
  return out;
}

function ugcRequest(pathname, params) {
  return request(pathname + query(params || {}), { requiresToken: true });
}

function seasonEpisodeOf(item) {
  var text = String(pick(item.epTitle, item.title, item.name) || '');
  var match = text.match(/S(?:eason)?\s*0*(\d+)\s*[-\s]*E(?:P|pisode)?\s*0*(\d+)/i);
  if (match) return { season: asNumber(match[1]), episode: asNumber(match[2]) };
  match = text.match(/Season\s*0*(\d+).*?Episode\s*0*(\d+)/i);
  if (match) return { season: asNumber(match[1]), episode: asNumber(match[2]) };
  return null;
}

function isTargetEpisode(item, season, episode) {
  var parsed = seasonEpisodeOf(item);
  if (parsed) return parsed.season === season && parsed.episode === episode;
  var number = asNumber(pick(item.episode, item.ep, item.episodeNumber, item.order, item.seq));
  // Without a season label the number is only safe for season 1.
  return season === 1 && number === episode;
}

function firstTargetEpisode(items, season, episode) {
  for (var i = 0; i < items.length; i++) {
    if (isTargetEpisode(items[i], season, episode)) return items[i];
  }
  return null;
}

function collectionStreams(collectionId, videoNum, season, episode, seen) {
  var totalPages = Math.min(12, Math.max(1, Math.ceil((asNumber(videoNum) || 0) / 50)));
  var start = Math.min(totalPages, Math.max(1, Math.floor((episode - 1) / 50) + 1));
  var pages = [start];
  for (var p = 1; p <= totalPages; p++) {
    if (pages.indexOf(p) < 0) pages.push(p);
  }

  var index = 0;
  function nextPage() {
    if (index >= pages.length) return Promise.resolve([]);
    var page = pages[index++];
    return ugcRequest('/wefeed-mobile-bff/ugc/collection/download-list', {
      collectionId: collectionId,
      page: page,
      perPage: 50
    }).then(function (json) {
      var data = (json && json.data) || {};
      var items = data.items || data.list || [];
      var item = firstTargetEpisode(items, season, episode);
      if (!item && season === 1 && episode === 1 && items.length) item = items[0];
      if (item) return ugcStreamsFromResources(item.resources || [], seen);
      return nextPage();
    }).catch(function () {
      return nextPage();
    });
  }
  return nextPage();
}

function singleVideoStreams(ugcVideoId, seen) {
  return ugcRequest('/wefeed-mobile-bff/ugc/video/download', { ugcVideoId: ugcVideoId })
    .then(function (json) {
      var data = (json && json.data) || {};
      var items = data.items || data.list || [];
      var out = [];
      items.forEach(function (item) {
        out = out.concat(ugcStreamsFromResources(item.resources || [], seen));
      });
      return out;
    }).catch(function () { return []; });
}

function sniffedStreams(subjectId, isMovie, episode, seen) {
  var page = isMovie ? 0 : Math.max(0, Math.floor((episode - 1) / 20));
  var pages = [page, page + 1, page + 2];
  var index = 0;

  function nextPage() {
    if (index >= pages.length) return Promise.resolve([]);
    var current = pages[index++];
    return ugcRequest('/wefeed-mobile-bff/subject-api/resource', {
      subjectId: subjectId,
      page: current,
      perPage: 20,
      pagerMode: 0
    }).then(function (json) {
      var data = (json && json.data) || {};
      var items = data.list || data.items || [];
      var candidates = items.filter(function (item) {
        return isMovie || asNumber(pick(item.ep, item.episode)) === episode;
      });
      var out = [];
      var tried = 0;

      function nextItem() {
        if (!candidates.length || tried >= 4) return Promise.resolve(out);
        var item = candidates.shift();
        tried++;
        var sourceUrl = String(pick(item.sourceUrl, item.resourceLink) || '');
        if (!sourceUrl || UGC_DUMMY_RE.test(sourceUrl)) return nextItem();
        return ugcRequest('/wefeed-mobile-bff/sniff/config', {
          linkUrl: sourceUrl,
          subjectId: subjectId
        }).then(function (sniff) {
          var download = String(((sniff && sniff.data) || {}).downloadUrl || '');
          if (download && !UGC_DUMMY_RE.test(download)) {
            out = out.concat(ugcStreamsFromResources([{
              url: download,
              resolutions: pick(item.resolution, item.resolutions),
              size: item.size,
              duration: item.duration,
              codecName: item.codecName
            }], seen));
          }
          return nextItem();
        }).catch(function () { return nextItem(); });
      }

      return nextItem().then(function (found) {
        return found.length ? found : nextPage();
      });
    }).catch(function () { return nextPage(); });
  }
  return nextPage();
}

function ugcForSubject(subjectId, context, seen) {
  return ugcRequest('/wefeed-mobile-bff/ugc/video/first-by-subject', { subjectId: subjectId })
    .then(function (json) {
      var data = (json && json.data) || {};
      var collection = data.belongToCollection || {};
      var collectionId = collection.collectionId;
      if (collectionId) {
        return collectionStreams(collectionId, collection.videoNum, context.season, context.episode, seen)
          .then(function (streams) {
            if (streams.length) return streams;
            if (data.ugcVideoId) return singleVideoStreams(data.ugcVideoId, seen);
            return [];
          });
      }
      if (data.ugcVideoId) return singleVideoStreams(data.ugcVideoId, seen);
      return [];
    }).then(function (streams) {
      if (streams.length) return streams;
      return sniffedStreams(subjectId, context.isMovie, context.episode, seen);
    }).catch(function () {
      return sniffedStreams(subjectId, context.isMovie, context.episode, seen);
    });
}

function resolveUgcStreams(context) {
  var ids = [];
  [context.subjectId].concat(context.candidateIds || []).forEach(function (id) {
    var value = String(id || '');
    if (value && ids.indexOf(value) < 0) ids.push(value);
  });
  var seen = {};
  var index = 0;

  function next() {
    if (index >= ids.length) {
      throw fail('no_stream',
        'MovieBox returned only an update placeholder and no full stream was available.', 404);
    }
    var id = ids[index++];
    return ugcForSubject(id, context, seen).then(function (streams) {
      return streams.length ? streams : next();
    });
  }

  return Promise.resolve().then(next).then(function (streams) {
    streams.sort(function (a, b) { return rank(b.quality) - rank(a.quality); });
    return streams;
  });
}

var LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', ml: 'Malayalam', ta: 'Tamil', te: 'Telugu',
  kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati',
  ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', pt: 'Portuguese',
  it: 'Italian', tr: 'Turkish', th: 'Thai', id: 'Indonesian', vi: 'Vietnamese'
};

function languageLabel(s) {
  var name = String(pick(s.lanName, s.language, s.name) || '').trim();
  var code = String(pick(s.lan, s.lang) || '').trim().toLowerCase();
  if (!name || name.length <= 3 || /^[A-Z]{2}$/.test(name)) {
    if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
    if (code) return code.toUpperCase();
  }
  return name || 'Unknown';
}

function subtitleEntries(list) {
  var out = [];
  var seen = {};
  (list || []).forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    var sourceUrl = String(pick(s.url, s.src, s.caption) || '');
    if (!sourceUrl || seen[sourceUrl]) return;
    seen[sourceUrl] = true;
    var format = /\.vtt(\?|$)/i.test(sourceUrl) ? 'vtt' : 'srt';
    // Caption CDNs are cross-origin just like the video CDN, so send them
    // through the same registered same-origin proxy. Relative fixture URLs
    // are already same-origin and stay untouched.
    var url = /^https?:\/\//i.test(sourceUrl) ? mediaProxy.register(sourceUrl, null) : sourceUrl;
    out.push({
      language: languageLabel(s),
      lang: String(pick(s.lan, s.lang, s.language) || ''),
      url: url,
      format: format
    });
  });
  return out;
}

function extCaptionsFor(params) {
  var path = '/wefeed-mobile-bff/subject-api/get-ext-captions' + query({
    subjectId: params.subjectId,
    resourceId: params.resourceId,
    se: params.season,
    ep: params.episode,
    episode: params.episode,
    lan: params.lan
  });
  return request(path, { requiresToken: true }).then(function (json) {
    var data = (json && json.data) || {};
    return subtitleEntries(data.extCaptions || data.list || data.captions || []);
  }).catch(function () {
    return [];   // subtitles are optional; playback continues without them
  });
}

function streamCaptionsFor(params) {
  var path = '/wefeed-mobile-bff/subject-api/get-stream-captions' + query({
    subjectId: params.subjectId,
    streamId: params.streamId
  });
  return request(path, { requiresToken: true }).then(function (json) {
    var data = (json && json.data) || {};
    return subtitleEntries(data.extCaptions || data.list || data.captions || []);
  }).catch(function () {
    return [];
  });
}

/**
 * The play-info stream id is what get-stream-captions expects. The older
 * get-ext-captions path uses a resource id; the two are not interchangeable.
 */
function captionsFor(params) {
  var streamIds = params.streamIds || [];
  var byStream = streamIds.length
    ? streamCaptionsFor({ subjectId: params.subjectId, streamId: streamIds[0] })
    : Promise.resolve([]);
  return byStream.then(function (list) {
    if (list.length) return list;
    // Some episodes have no stream-caption row; get-ext-captions also accepts
    // the stream id as its resourceId.
    var fallbackId = params.resourceId || streamIds[0];
    if (!fallbackId) return [];
    return extCaptionsFor({
      subjectId: params.subjectId,
      resourceId: fallbackId,
      season: params.season,
      episode: params.episode
    });
  }).catch(function () {
    return [];
  });
}

/** IDs accepted by get-stream-captions live on play-info's stream objects. */
function streamCaptionIds(data) {
  var out = [];
  function add(value) {
    var id = String(value || '');
    if (id && out.indexOf(id) < 0) out.push(id);
  }
  function visit(stream) {
    if (!stream || typeof stream !== 'object') return;
    add(pick(stream.streamId, stream.resourceId, stream.id));
    var nested = pick(stream.resolutions, stream.variants, stream.qualities);
    if (Array.isArray(nested)) nested.forEach(visit);
  }
  (data.streams || data.streamList || []).forEach(visit);
  return out;
}

function playback(params) {
  var subjectId = params.id;
  var season = params.season || 1;
  var episode = params.episode || 1;
  var quality = params.quality || '1080p';

  return detailRequest(params.id).then(function (item) {
    var subject = item ? toSubject(item) : null;
    var audioLanguages = subject ? subject.audioLanguages : [];

    // A language switch is only honoured if the provider listed it.
    var useSubjectId = subjectId;
    var useResourceId = params.resourceId || null;
    if (params.audioSubjectId && audioLanguages.length) {
      var match = audioLanguages.filter(function (a) { return a.subjectId === params.audioSubjectId; })[0];
      if (!match) throw fail('bad_audio', 'Unknown audio language for this title.', 400);
      useSubjectId = match.subjectId;
      useResourceId = match.resourceId || useResourceId;
    }

    var playParams = {
      subjectId: useSubjectId,
      se: subject && subject.isTvShow ? season : undefined,
      ep: subject && subject.isTvShow ? episode : undefined,
      quality: quality,
      resourceId: useResourceId
    };

    return tryPaths(config.moviebox.playInfoPaths, playParams,
      { noRetry: true, requiresToken: true }).then(function (json) {
      var data = (json && json.data) || json || {};
      var directStreams = flattenStreams(data.streamList || data.streams || []);

      // The newer API returns one direct file per format and lists its display
      // resolutions separately. Use the best label when the stream has none.
      // A dummy stream is discarded here; it must never reach the television.
      directStreams = directStreams.filter(function (s) { return !isDummyStream(s); });
      var displayQuality = bestDisplayQuality(data.displayResolutions);
      if (displayQuality) {
        directStreams.forEach(function (s) {
          if (s.quality === 'Auto') s.quality = displayQuality;
        });
      }

      var candidateIds = [subjectId, useSubjectId].concat(audioLanguages.map(function (a) {
        return a.subjectId;
      }));
      var streamPromise = directStreams.length
        ? Promise.resolve(directStreams)
        : resolveUgcStreams({
            subjectId: useSubjectId,
            candidateIds: candidateIds,
            isMovie: !(subject && subject.isTvShow),
            season: season,
            episode: episode
          });

      return streamPromise.then(function (streams) {
        if (!streams.length) {
          throw fail('no_stream', 'MovieBox returned no playable stream for this title.', 404);
        }

        var inline = subtitleEntries(data.subtitles || data.subTitleList || data.extCaptions || []);
        var resourceId = String(pick(data.resourceId, useResourceId) || '');
        var ownCaptions = captionsFor({
          subjectId: useSubjectId,
          resourceId: resourceId,
          streamIds: streamCaptionIds(data),
          season: subject && subject.isTvShow ? season : undefined,
          episode: subject && subject.isTvShow ? episode : undefined
        });

        return ownCaptions.then(function (extra) {
          var subs = inline.slice(0);
          extra.forEach(function (s) {
            var dup = subs.some(function (x) { return x.url === s.url; });
            if (!dup) subs.push(s);
          });
          // English first, then alphabetical: the frontend prefers English, this
          // just makes the list stable between episodes.
          subs.sort(function (a, b) {
            var ae = /^english$/i.test(a.language) ? 0 : 1;
            var be = /^english$/i.test(b.language) ? 0 : 1;
            if (ae !== be) return ae - be;
            return a.language.localeCompare(b.language);
          });

          return {
            id: params.id,
            name: subject ? subject.name : '',
            isTvShow: subject ? subject.isTvShow : false,
            season: subject && subject.isTvShow ? season : 0,
            episode: subject && subject.isTvShow ? episode : 0,
            live: false,
            provider: 'moviebox',
            streams: streams,
            subtitles: subs,
            audioLanguages: audioLanguages.map(function (a) {
              return { language: a.language, subjectId: a.subjectId, original: a.original };
            }),
            audioSubjectId: useSubjectId
          };
        });
      });
    });
  });
}

/* ------------------------------------------------------------- live TV */

var channelsCache = null;

function channelData() {
  if (!channelsCache) {
    channelsCache = JSON.parse(
      require('fs').readFileSync(require('path').join(config.dataDir, 'channels.json'), 'utf8')
    );
  }
  return channelsCache;
}

function channels(params) {
  var data = channelData();
  var q = (params.q || '').toLowerCase();
  var list = data.channels.filter(function (c) {
    if (params.country && params.country !== 'ALL' && c.country !== params.country) return false;
    if (params.category && params.category !== 'All' && params.category !== 'Favourites' &&
      c.category.toLowerCase() !== String(params.category).toLowerCase()) return false;
    if (q && c.name.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var categories = {};
  data.channels.forEach(function (c) { categories[c.category] = true; });
  return {
    countries: data.countries,
    categories: Object.keys(categories).sort(),
    channels: list.map(function (c) {
      return { id: c.id, name: c.name, logo: c.logo || null, category: c.category, country: c.country };
    }),
    provider: 'moviebox',
    note: 'Live TV streams are configured separately and are not part of the MovieBox catalogue.'
  };
}

function channelStream(id) {
  var data = channelData();
  for (var i = 0; i < data.channels.length; i++) {
    if (data.channels[i].id !== id) continue;
    var c = data.channels[i];
    return {
      id: c.id,
      name: c.name,
      live: true,
      hls: !!c.hls,
      streams: [{ quality: 'Auto (HLS)', url: c.url, size: '' }],
      subtitles: [],
      audioLanguages: []
    };
  }
  return null;
}

/* ---------------------------------------------------------------- contract */

module.exports = {
  meta: function () {
    return {
      provider: 'moviebox',
      demo: false,
      configured: configured(),
      missing: missing(),
      signing: auth.describe(),
      session: session.describe(),
      ottFilters: config.ottFilters,
      ottEnabled: !!config.tmdb.apiKey
    };
  },
  home: home,
  search: search,
  details: details,
  episodes: episodes,
  playback: playback,
  channels: channels,
  channelStream: channelStream,
  // exported for tests
  qualityRank: rank,
  __internals: {
    sign: auth.sign,
    canonicalQuery: auth.canonicalQuery,
    canonicalPath: auth.canonicalPath,
    clientInfo: auth.clientInfo,
    md5: auth.md5,
    query: query,
    STATUS: STATUS
  },
  normalize: {
    imageUrl: imageUrl,
    toCard: toCard,
    toSubject: toSubject,
    episodePool: episodePool,
    flattenStreams: flattenStreams
  }
};
