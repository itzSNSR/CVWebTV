'use strict';

/**
 * Contract tests: request construction and response mapping.
 *
 * These need no network and no credentials. They exist because the live
 * integration cannot be exercised in this project: the signing algorithm is
 * re-implemented here straight from MovieBoxApi.kt and compared with what the
 * backend produces, and the response mappers are fed raw payloads written in
 * MovieBox's own field names.
 *
 *   node --test backend/test/*.test.js
 */

var test = require('node:test');
var assert = require('node:assert');

process.env.MOVIEBOX_APP_KEY = process.env.MOVIEBOX_APP_KEY || 'contract-test-key-value';
process.env.MOVIEBOX_BASE_URL = process.env.MOVIEBOX_BASE_URL || 'https://api6.aoneroom.com/';

var crypto = require('crypto');
var mb = require('../providers/moviebox');
var n = mb.normalize;

/* ---------------------------------------------------- reference implementation */

/** Straight port of MovieBoxSignatureInterceptor, written independently. */
function kotlinSignature(method, encodedPath, sortedQueryString, bodyString, timestamp, keyStr) {
  var accept = 'application/json';
  var contentType = 'application/json;charset=UTF-8';
  var bytes = bodyString ? Buffer.from(bodyString, 'utf8') : Buffer.alloc(0);
  var bodyLength = bytes.length ? String(bytes.length) : '';
  var bodyHash = '';
  if (bytes.length) {
    bodyHash = crypto.createHash('md5')
      .update(bytes.slice(0, Math.min(bytes.length, 102400)))
      .digest('hex');
  }
  var canonicalPath = encodedPath + (sortedQueryString ? '?' + sortedQueryString : '');
  var canonical = [method, accept, contentType, bodyLength, String(timestamp), bodyHash, canonicalPath].join('\n');
  var keyBytes;
  try {
    var decoded = Buffer.from(keyStr, 'base64');
    keyBytes = decoded.length >= 8 ? decoded : Buffer.from(keyStr, 'utf8');
  } catch (e) {
    keyBytes = Buffer.from(keyStr, 'utf8');
  }
  var digest = crypto.createHmac('md5', keyBytes).update(canonical, 'utf8').digest('base64');
  return String(timestamp) + '|2|' + digest;
}

/* ------------------------------------------------------------------- signing */

test('canonical query is sorted by name and decoded, like OkHttp', function () {
  var sorted = mb.__internals.canonicalQuery('?page=2&q=big%20buck%20bunny&pageSize=20&quality=1080p');
  assert.strictEqual(sorted, 'page=2&pageSize=20&q=big buck bunny&quality=1080p');
});

test('empty query produces no question mark', function () {
  assert.strictEqual(mb.__internals.canonicalQuery(''), '');
  assert.strictEqual(mb.__internals.canonicalQuery('?'), '');
});

test('signature matches the Android interceptor for a GET', function () {
  var timestamp = 1700000000000;
  var headers = mb.__internals.sign('GET',
    'wefeed-mobile-bff/subject-api/play-info?ep=1&quality=1080p&se=2&subjectId=12345',
    null, timestamp);
  var expected = kotlinSignature('GET',
    'wefeed-mobile-bff/subject-api/play-info',
    'ep=1&quality=1080p&se=2&subjectId=12345',
    null, timestamp, process.env.MOVIEBOX_APP_KEY);
  assert.strictEqual(headers['x-tr-signature'], expected);
});

test('signature matches the Android interceptor for a POST body', function () {
  var timestamp = 1700000000123;
  var body = JSON.stringify({ categoryId: 2, page: 1, pageSize: 20 });
  var headers = mb.__internals.sign('POST', 'home/v2/get-list', body, timestamp);
  var expected = kotlinSignature('POST', 'home/v2/get-list', '', body, timestamp,
    process.env.MOVIEBOX_APP_KEY);
  assert.strictEqual(headers['x-tr-signature'], expected);
});

test('client token is timestamp + md5(reversed timestamp)', function () {
  var timestamp = 1700000000456;
  var headers = mb.__internals.sign('GET', 'wefeed-mobile-bff/subject-api/trending/v2?page=1', null, timestamp);
  var reversed = String(timestamp).split('').reverse().join('');
  assert.strictEqual(headers['X-Client-Token'], timestamp + ',' +
    crypto.createHash('md5').update(reversed, 'utf8').digest('hex'));
});

test('device headers carry the fields the client sends', function () {
  var info = JSON.parse(mb.__internals.clientInfo());
  ['package_name', 'version_name', 'version_code', 'os', 'os_version', 'install_ch',
    'device_id', 'install_store', 'gaid', 'brand', 'model', 'system_language', 'net',
    'region', 'timezone', 'sp_code', 'X-Play-Mode'].forEach(function (key) {
    assert.ok(Object.prototype.hasOwnProperty.call(info, key), 'missing ' + key);
  });
  assert.strictEqual(info.package_name, 'com.community.oneroom');
  assert.strictEqual(info.version_code, 50020042);
  assert.strictEqual(info.timezone, 'Asia/Kolkata');
  assert.ok(mb.__internals.clientInfo().indexOf(' ') < 0, 'client info must not contain whitespace');
});

/* ------------------------------------------------------------------- mapping */

// One raw subject exactly as the provider names its fields.
var RAW = {
  subjectId: '987654',
  title: 'Raw Shape Movie',
  cover: {
    url: '//cdn.example.com/full/987654.jpg',
    webpUrl: 'https://cdn.example.com/webp/987654.webp',
    thumbUrl: 'https://cdn.example.com/thumb/987654.jpg'
  },
  horizontalPoster: { url: 'https://cdn.example.com/wide/987654.jpg' },
  description: 'A description from the provider.',
  imdbRatingValue: '0',
  releaseDate: '2019-08-15',
  subjectType: 2,
  duration: '0',
  dubs: [
    { lanName: 'Malayalam', subjectId: '987654', original: true },
    { lanName: 'Hindi', subjectId: '987654-hi' }
  ],
  genres: ['Drama', 'Thriller'],
  seasonList: [
    { se: 2, allEp: '1,2,3,4' },
    { se: 1, resolutions: [{ resolution: 1080, epNum: 6 }] }
  ]
};

test('cards use the small poster variant and normalise protocol-relative URLs', function () {
  var card = n.toCard(RAW);
  assert.strictEqual(card.id, '987654');
  assert.strictEqual(card.poster, 'https://cdn.example.com/thumb/987654.jpg');
  assert.strictEqual(card.isTvShow, true);
  assert.strictEqual(card.year, '2019');
  assert.strictEqual(card.rating, null, 'a rating of "0" is not a rating');
  assert.strictEqual(card.duration, null);
  assert.strictEqual(card.language, 'Malayalam');
});

test('details keep the large artwork and expose audio languages', function () {
  var subject = n.toSubject(RAW);
  assert.strictEqual(subject.backdrop, 'https://cdn.example.com/wide/987654.jpg');
  assert.strictEqual(subject.description, 'A description from the provider.');
  assert.deepStrictEqual(subject.genres, ['Drama', 'Thriller']);
  assert.strictEqual(subject.audioLanguages.length, 2);
  assert.strictEqual(subject.audioLanguages[0].subjectId, '987654');
  assert.strictEqual(subject.audioLanguages[0].original, true);
  assert.strictEqual(subject.audioLanguages[1].subjectId, '987654-hi');
});

test('season summary is sorted and counts episodes', function () {
  var subject = n.toSubject(RAW);
  assert.deepStrictEqual(subject.seasons, [
    { season: 1, episodeCount: 6 },
    { season: 2, episodeCount: 4 }
  ]);
});

test('episode pool handles csv, object lists and count fallback', function () {
  assert.deepStrictEqual(n.episodePool({ allEp: '1,2,3' }).map(function (e) { return e.episode; }), [1, 2, 3]);

  var objects = n.episodePool({
    episodeList: [{ ep: 1, title: 'Pilot' }, { episodeNumber: 2, title: 'Second' }]
  });
  assert.strictEqual(objects[1].title, 'Second');

  var fromCounts = n.episodePool({ resolutionEpCounts: { '720': 4, '1080': 2 } });
  assert.strictEqual(fromCounts.length, 4, 'falls back to the largest reported count');

  var fromResolutions = n.episodePool({ resolutions: [{ resolution: 1080, epNum: 3 }] });
  assert.strictEqual(fromResolutions.length, 3);
});

test('streams flatten nested resolutions, de-duplicate and sort high to low', function () {
  var raw = [
    { url: 'https://cdn/a-720.mp4', resolutions: [{ resolution: 720, url: 'https://cdn/a-720.mp4' }] },
    { url: 'https://cdn/a-1080.mp4', resolutions: [{ resolution: 1080, url: 'https://cdn/a-1080.mp4' },
      { resolution: 720, url: 'https://cdn/a-720.mp4' }] },
    { url: 'https://cdn/a-480.mp4', quality: '480p' }
  ];
  var streams = n.flattenStreams(raw);
  assert.deepStrictEqual(streams.map(function (s) { return s.quality; }), ['1080p', '720p', '480p']);
  assert.strictEqual(streams.length, 3, 'the duplicate 720p URL must collapse');
});

test('episode titles survive when the provider sends them', function () {
  var pool = n.episodePool({ epList: [{ ep: 1, title: 'The Forest', duration: '42 min' }] });
  assert.strictEqual(pool[0].title, 'The Forest');
  assert.strictEqual(pool[0].duration, '42 min');
});

/* -------------------------------------------------------------- no fallback */

test('an unconfigured provider refuses instead of inventing data', function () {
  var saved = process.env.MOVIEBOX_APP_KEY;
  delete process.env.MOVIEBOX_APP_KEY;
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../providers/moviebox')];
  var fresh = require('../providers/moviebox');
  assert.strictEqual(fresh.meta().configured, false);
  assert.deepStrictEqual(fresh.meta().missing, ['MOVIEBOX_APP_KEY']);
  process.env.MOVIEBOX_APP_KEY = saved;
});
