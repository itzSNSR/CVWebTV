'use strict';

/**
 * Local MovieBox mock provider for signing tests.
 *
 * It implements the provider's request checks independently of
 * backend/auth/movieboxSigner.js: the canonical string, HMAC-MD5 signature,
 * X-Client-Token and X-Client-Info are re-derived here. A bug in the signer
 * therefore shows up as a 401 instead of being masked, and the adapter,
 * catalogue, search, details, episode and playback paths can be exercised
 * without a live credential.
 */

var http = require('http');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'moviebox-api.json'), 'utf8'));

var ACCEPT = 'application/json';
var CONTENT_TYPE = 'application/json;charset=UTF-8';
var BODY_HASH_LIMIT = 102400;

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function keyBytes(appKey) {
  var decoded = Buffer.from(String(appKey || ''), 'base64');
  return decoded.length >= 8 ? decoded : Buffer.from(String(appKey || ''), 'utf8');
}

function canonicalQuery(search) {
  var raw = String(search || '');
  if (raw.charAt(0) === '?') raw = raw.substring(1);
  if (!raw) return '';
  var pairs = [];
  raw.split('&').forEach(function (part) {
    if (!part) return;
    var i = part.indexOf('=');
    var name = i < 0 ? part : part.substring(0, i);
    var value = i < 0 ? '' : part.substring(i + 1);
    try {
      name = decodeURIComponent(name);
      value = decodeURIComponent(value);
    } catch (e) { /* keep raw */ }
    pairs.push({ name: name, value: value });
  });
  pairs.sort(function (a, b) {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return pairs.map(function (p) { return p.name + '=' + p.value; }).join('&');
}

function safeEqual(a, b) {
  var left = Buffer.from(String(a), 'utf8');
  var right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function fail(reason) {
  return { ok: false, reason: reason };
}

function verify(req, url, body, appKey) {
  var header = req.headers['x-tr-signature'];
  if (!header) return fail('missing x-tr-signature');

  var parts = String(header).split('|');
  if (parts.length !== 3) return fail('malformed x-tr-signature');
  var timestamp = parts[0];
  var version = parts[1];
  var provided = parts[2];
  if (!/^\d{1,16}$/.test(timestamp)) return fail('bad signature timestamp');
  if (version !== '2') return fail('unsupported signature version ' + version);

  var token = req.headers['x-client-token'];
  var expectedToken = timestamp + ',' + md5(String(timestamp).split('').reverse().join(''));
  if (!token || !safeEqual(token, expectedToken)) return fail('bad X-Client-Token');

  var info = req.headers['x-client-info'];
  if (!info) return fail('missing X-Client-Info');
  try {
    if (JSON.parse(info).package_name !== 'com.community.oneroom') {
      return fail('bad X-Client-Info package_name');
    }
  } catch (e) {
    return fail('unparseable X-Client-Info');
  }

  var bodyLength = body.length ? String(body.length) : '';
  var bodyHash = body.length ? md5(body.slice(0, Math.min(body.length, BODY_HASH_LIMIT))) : '';
  var query = canonicalQuery(url.search);
  var canonical = [
    req.method,
    ACCEPT,
    CONTENT_TYPE,
    bodyLength,
    timestamp,
    bodyHash,
    url.pathname + (query ? '?' + query : '')
  ].join('\n');
  var expected = crypto.createHmac('md5', keyBytes(appKey))
    .update(canonical, 'utf8')
    .digest('base64');

  return safeEqual(provided, expected) ? { ok: true } : fail('signature mismatch');
}

function send(res, status, body) {
  var text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function subjects(ids) {
  return ids.map(function (id) { return FIXTURES.subjects[id]; }).filter(Boolean);
}

function authorized(req, expectedToken) {
  return !!expectedToken && req.headers.authorization === 'Bearer ' + expectedToken;
}

function route(req, res, url, expectedToken) {
  var endpoint = url.pathname.replace(/^\/+/, '');

  if (endpoint === 'wefeed-mobile-bff/user-api/visitor-login') {
    return send(res, 200, { code: 0, message: 'ok', data: { token: expectedToken } });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/trending/v2') {
    return send(res, 200, { code: 200, data: { list: subjects(FIXTURES.lists.trending) } });
  }

  if (endpoint === 'home/v2/get-list') {
    return send(res, 200, { code: 200, data: { items: subjects(FIXTURES.lists.category) } });
  }

  if (endpoint === 'wefeed-mobile-bff/tab/ranking-list') {
    return send(res, 200, { code: 200, data: { list: subjects(FIXTURES.lists.ranking) } });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/search') {
    var q = String(url.searchParams.get('q') || '').toLowerCase();
    var hits = Object.keys(FIXTURES.subjects).map(function (id) {
      return FIXTURES.subjects[id];
    }).filter(function (item) {
      return String(item.title).toLowerCase().indexOf(q) >= 0;
    });
    return send(res, 200, { code: 200, data: { list: hits } });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/get') {
    if (!authorized(req, expectedToken)) {
      return send(res, 441, { code: 441, reason: 'UNAUTHORIZED', message: 'miss token' });
    }
    var subject = FIXTURES.subjects[url.searchParams.get('subjectId')];
    if (!subject) return send(res, 404, { code: 404, message: 'subject not found' });
    return send(res, 200, { code: 200, data: subject });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/season-info/v2') {
    if (!authorized(req, expectedToken)) {
      return send(res, 441, { code: 441, reason: 'UNAUTHORIZED', message: 'miss token' });
    }
    var seasons = FIXTURES.seasons[url.searchParams.get('subjectId')] || [];
    return send(res, 200, { code: 200, data: { seasons: seasons } });
  }

  // The adapter tries the Retrofit path first; answering 404 here exercises the
  // documented fallback to the sibling variant.
  if (endpoint === 'wefeed-mobile-bff/subject-api/play-info') {
    return send(res, 404, { code: 404, message: 'use play-info/v2' });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/play-info/v2') {
    if (!authorized(req, expectedToken)) {
      return send(res, 441, { code: 441, reason: 'UNAUTHORIZED', message: 'miss token' });
    }
    var subjectId = url.searchParams.get('subjectId') || '';
    var se = url.searchParams.get('se') || '1';
    var ep = url.searchParams.get('ep') || '1';
    var play = FIXTURES.playback[subjectId + ':' + se + ':' + ep] ||
      FIXTURES.playback[subjectId];
    if (!play) return send(res, 404, { code: 404, message: 'playback not found' });
    return send(res, 200, { code: 200, data: play });
  }

  if (endpoint === 'wefeed-mobile-bff/subject-api/get-ext-captions') {
    if (!authorized(req, expectedToken)) {
      return send(res, 441, { code: 441, reason: 'UNAUTHORIZED', message: 'miss token' });
    }
    var captions = FIXTURES.captions[url.searchParams.get('subjectId')] || [];
    return send(res, 200, { code: 200, data: { extCaptions: captions } });
  }

  return send(res, 404, { code: 404, message: 'unknown mock route' });
}

/**
 * Starts the mock on an ephemeral loopback port.
 * @param {{appKey: string}} options
 * @returns {Promise<{url:string, port:number, requests:Array, close:Function}>}
 */
function startMockMoviebox(options) {
  options = options || {};
  var appKey = options.appKey || '';
  var issuedToken = options.visitorToken || 'mock-visitor-token';
  var requests = [];

  var server = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      var body = Buffer.concat(chunks);
      var url = new URL(req.url, 'http://moviebox.mock');
      var check = verify(req, url, body, appKey);
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        valid: check.ok,
        reason: check.reason || null
      });
      if (!check.ok) return send(res, 401, { code: 401, message: check.reason });
      route(req, res, url, issuedToken);
    });
  });

  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/',
        port: port,
        requests: requests,
        close: function () {
          return new Promise(function (done) { server.close(function () { done(); }); });
        }
      });
    });
  });
}

module.exports = {
  start: startMockMoviebox
};
