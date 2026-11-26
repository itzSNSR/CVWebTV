'use strict';

/**
 * Same-origin media proxy.
 *
 * MovieBox's CDN files are direct MP4s, but the browser's Referer/Origin can
 * make the CDN answer HTTP 429. The television <video> element cannot set
 * request headers, so the provider registers the real URL here and hands the
 * TV a short local path instead. This module fetches the file with neutral
 * headers and forwards Range requests, so seeking still works.
 *
 * Only URLs registered by the provider can be fetched: the id is random and
 * the URL is never accepted from the client.
 */

var crypto = require('crypto');
var http = require('http');
var https = require('https');

var config = require('./config/config');

var entries = new Map();
var TTL_MS = 6 * 60 * 60 * 1000;
var MAX_ENTRIES = 800;

function cleanup() {
  var now = Date.now();
  entries.forEach(function (entry, id) {
    if (entry.expires < now) entries.delete(id);
  });
}

/** Registers one provider URL and returns the path the TV should use. */
function register(url, headers) {
  if (!url) return '';
  cleanup();
  var id = crypto.randomBytes(18).toString('hex');
  entries.set(id, {
    url: String(url),
    headers: headers && typeof headers === 'object' ? headers : {},
    expires: Date.now() + TTL_MS
  });
  if (entries.size > MAX_ENTRIES) {
    var oldest = entries.keys().next().value;
    entries.delete(oldest);
  }
  var prefix = config.publicOrigin ? String(config.publicOrigin).replace(/\/+$/, '') : '';
  return prefix + '/api/media/' + id;
}

function get(id) {
  var entry = entries.get(id);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    entries.delete(id);
    return null;
  }
  return entry;
}

function fail(res, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = 502;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message || 'Media unavailable');
}

function proxy(req, res, id) {
  var entry = get(id);
  if (!entry) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Media link expired');
    return;
  }

  var target;
  try {
    target = new URL(entry.url);
  } catch (e) {
    return fail(res, 'Invalid media URL');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return fail(res, 'Unsupported media URL');
  }

  var headers = {
    'User-Agent': 'MovieBox/4.0.02 (Android 14; Pixel 6)',
    Accept: '*/*',
    'Accept-Encoding': 'identity'
  };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  Object.keys(entry.headers).forEach(function (key) {
    // Only the provider can register these; never forward browser headers.
    if (/^cookie$/i.test(key)) headers.Cookie = entry.headers[key];
  });

  var redirects = 0;

  function go(next) {
    var lib = next.protocol === 'https:' ? https : http;
    var upstream = lib.request({
      protocol: next.protocol,
      hostname: next.hostname,
      port: next.port || (next.protocol === 'https:' ? 443 : 80),
      path: next.pathname + next.search,
      method: req.method,
      headers: headers,
      timeout: 60000
    }, function (upstreamRes) {
      if ([301, 302, 303, 307, 308].indexOf(upstreamRes.statusCode) >= 0 &&
          upstreamRes.headers.location && redirects < 4) {
        redirects++;
        upstreamRes.resume();
        var redirectTarget;
        try {
          redirectTarget = new URL(upstreamRes.headers.location, next);
        } catch (e) {
          return fail(res, 'Invalid media redirect');
        }
        return go(redirectTarget);
      }

      res.statusCode = upstreamRes.statusCode;
      var pass = ['content-type', 'content-length', 'content-range',
        'accept-ranges', 'etag', 'last-modified'];
      pass.forEach(function (name) {
        if (upstreamRes.headers[name]) res.setHeader(name, upstreamRes.headers[name]);
      });
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/octet-stream');
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Access-Control-Expose-Headers',
        'Content-Range, Content-Length, Accept-Ranges');

      if (req.method === 'HEAD') {
        upstreamRes.resume();
        res.end();
        return;
      }

      upstreamRes.on('error', function () { res.destroy(); });
      upstreamRes.pipe(res);
    });

    upstream.on('timeout', function () {
      upstream.destroy(new Error('timeout'));
    });
    upstream.on('error', function () {
      fail(res, 'Media unavailable');
    });
    req.on('close', function () {
      upstream.destroy();
    });
    upstream.end();
  }

  go(target);
}

module.exports = {
  register: register,
  get: get,
  proxy: proxy
};
