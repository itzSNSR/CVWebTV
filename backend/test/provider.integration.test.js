'use strict';

/**
 * Integration tests for the real MovieBox adapter against the local mock
 * provider. Every request must pass the mock's independent signature check,
 * and the catalogue, search, details, episode, thumbnail and playback paths
 * are exercised with fixtures and test credentials only.
 *
 *   node --test backend/test/*.test.js
 */

var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');

var credentials = require('./fixtures/test-credentials');
var startMockMoviebox = require('./support/mock-moviebox').start;

var mock;
var provider;
var api;

test.before(async function () {
  mock = await startMockMoviebox({ appKey: credentials.appKey });

  process.env.MOVIEBOX_BASE_URL = mock.url;
  process.env.MOVIEBOX_APP_KEY = credentials.appKey;
  process.env.MOVIEBOX_APP_KEY_ENCODING = 'auto';
  process.env.MOVIEBOX_SIGNING_ENABLED = 'true';
  process.env.MOVIEBOX_SIGNING_SCHEME = 'hmac-md5';
  process.env.MOVIEBOX_SIGNATURE_VERSION = '2';
  process.env.MOVIEBOX_GUEST_LOGIN = 'true';
  process.env.MOVIEBOX_AUTH_BASE_URL = mock.url;
  process.env.MOVIEBOX_AUTH_HOST = '127.0.0.1';
  process.env.TMDB_API_KEY = '';

  provider = require('../providers/moviebox');
  api = require('../routes/api');
});

test.after(async function () {
  if (mock) await mock.close();
});

function get(url, headers) {
  return new Promise(function (resolve, reject) {
    var req = http.request(url, { method: 'GET', headers: headers || {} }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('meta reports the signing configuration without the credential', function () {
  var meta = provider.meta();
  assert.strictEqual(meta.provider, 'moviebox');
  assert.strictEqual(meta.configured, true);
  assert.deepStrictEqual(meta.missing, []);
  assert.strictEqual(meta.signing.enabled, true);
  assert.strictEqual(meta.signing.scheme, 'hmac-md5');
  assert.strictEqual(meta.signing.version, '2');
  assert.strictEqual(meta.session.enabled, true);
  assert.strictEqual(meta.session.cached, false);
  assert.ok(JSON.stringify(meta).indexOf(credentials.appKey) < 0);
});

test('catalogue sections are served through signed requests', async function () {
  var home = await provider.home({ page: 1, pageSize: 20, type: 'all' });
  var ids = [];

  assert.ok(home.sections.length >= 3);
  home.sections.forEach(function (section) {
    section.items.forEach(function (item) {
      ids.push(item.id);
      assert.ok(item.poster, 'every card keeps its thumbnail');
    });
  });

  assert.ok(ids.indexOf('mock-movie-1') >= 0);
  assert.ok(ids.indexOf('mock-series-1') >= 0);
  assert.ok(mock.requests.length > 0, 'the adapter made upstream calls');
  mock.requests.forEach(function (request) {
    assert.ok(request.valid, request.method + ' ' + request.path + ': ' + request.reason);
  });
});

test('search keeps returning cards', async function () {
  var found = await provider.search({ q: 'Mock', page: 1, pageSize: 20 });
  assert.strictEqual(found.provider, 'moviebox');
  assert.strictEqual(found.total, 2);
  assert.deepStrictEqual(found.items.map(function (item) { return item.id; }).sort(),
    ['mock-movie-1', 'mock-series-1']);
});

test('details keep artwork, metadata and audio languages', async function () {
  var movie = await provider.details('mock-movie-1');
  assert.strictEqual(movie.name, 'Mock Horizon');
  assert.strictEqual(movie.poster, 'https://cdn.example.test/thumb/mock-movie-1.jpg');
  assert.strictEqual(movie.backdrop, 'https://cdn.example.test/wide/mock-movie-1.jpg');
  assert.strictEqual(movie.year, '2023');
  assert.strictEqual(movie.rating, '8.1');
  assert.deepStrictEqual(movie.genres, ['Drama', 'Thriller']);
  assert.strictEqual(movie.audioLanguages.length, 2);
});

test('episodes come from season-info', async function () {
  var series = await provider.episodes('mock-series-1');
  assert.deepStrictEqual(series.seasons, [{ season: 1, episodeCount: 2 }]);
  assert.strictEqual(series.season, 1);
  assert.deepStrictEqual(series.episodes.map(function (ep) { return ep.episode; }), [1, 2]);
});

test('movie playback keeps qualities, subtitles and audio options', async function () {
  var playback = await provider.playback({
    id: 'mock-movie-1', season: 1, episode: 1, quality: '1080p'
  });

  assert.strictEqual(playback.provider, 'moviebox');
  assert.strictEqual(playback.isTvShow, false);
  assert.deepStrictEqual(playback.streams.map(function (s) { return s.quality; }),
    ['1080p', '720p']);
  assert.ok(playback.subtitles.some(function (s) { return s.language === 'English'; }));
  assert.ok(playback.subtitles.some(function (s) { return s.language === 'Malayalam'; }));
  assert.strictEqual(playback.audioLanguages.length, 2);
  assert.ok(JSON.stringify(playback).indexOf(credentials.appKey) < 0);
});

test('episode playback resolves the series stream', async function () {
  var playback = await provider.playback({
    id: 'mock-series-1', season: 1, episode: 1, quality: '720p'
  });
  assert.strictEqual(playback.isTvShow, true);
  assert.strictEqual(playback.season, 1);
  assert.strictEqual(playback.episode, 1);
  assert.deepStrictEqual(playback.streams.map(function (s) { return s.quality; }), ['720p']);
});

test('the API layer still serves the same contract', async function () {
  var home = await api.handle('/api/home', {});
  assert.strictEqual(home.status, 200);
  assert.ok(home.body.sections.length >= 3);

  var details = await api.handle('/api/details', { id: 'mock-movie-1' });
  assert.strictEqual(details.status, 200);
  assert.strictEqual(details.body.name, 'Mock Horizon');

  var episodes = await api.handle('/api/episodes', { id: 'mock-series-1' });
  assert.strictEqual(episodes.status, 200);
  assert.strictEqual(episodes.body.episodes.length, 2);

  var playback = await api.handle('/api/playback', { id: 'mock-movie-1', quality: '1080p' });
  assert.strictEqual(playback.status, 200);
  assert.strictEqual(playback.body.streams.length, 2);
});

test('the visitor token is obtained once and never returned to the client', async function () {
  var logins = mock.requests.filter(function (request) {
    return request.path === '/wefeed-mobile-bff/user-api/visitor-login';
  });
  assert.strictEqual(logins.length, 1, 'the visitor token must be cached, not re-fetched');
  assert.strictEqual(logins[0].valid, true, 'visitor-login must be signed');
  assert.strictEqual(mock.requests.length > 0, true);
  mock.requests.forEach(function (request) {
    assert.strictEqual(request.valid, true, request.method + ' ' + request.path + ': ' + request.reason);
  });

  var meta = provider.meta();
  assert.strictEqual(meta.session.cached, true);
  assert.ok(JSON.stringify(meta).indexOf('mock-visitor-token') < 0);
});

test('unsigned and wrongly signed requests are rejected upstream', async function () {
  var unsigned = await get(mock.url + 'wefeed-mobile-bff/subject-api/trending/v2?page=1');
  assert.strictEqual(unsigned.status, 401);

  var signer = require('../auth/movieboxSigner').create({
    baseUrl: mock.url,
    appKey: 'd3JvbmctdGVzdC1rZXktMDAx',
    appKeyEncoding: 'utf8',
    signing: { enabled: true, scheme: 'hmac-md5', version: '2' }
  });
  var path = '/wefeed-mobile-bff/subject-api/trending/v2?page=1';
  var wrong = await get(mock.url + path.substring(1), signer.sign('GET', path, null));
  assert.strictEqual(wrong.status, 401);
});
