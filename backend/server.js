'use strict';

/**
 * CineVault TV backend + static host.
 *
 * Zero dependencies: node:http, node:fs, node:zlib only, so the whole server
 * can be dropped on any small VPS or free Node host.
 *
 *   node backend/server.js
 *
 * Environment: see backend/config/config.js. Nothing secret is required for
 * the demonstration provider.
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var zlib = require('zlib');

// backend/.env is read first (if present) so the server can be started with a
// plain `node backend/server.js`. Real environment variables always win.
var envInfo = require('./config/loadEnv')();

var config = require('./config/config');
var api = require('./routes/api');
var mediaProxy = require('./mediaProxy');

var ROOT = config.staticRoot;
var BLOCKED_DIRS = ['backend', 'node_modules', '.git', 'docs'];

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
};

var COMPRESSIBLE = ['.html', '.css', '.js', '.json', '.svg', '.vtt', '.srt', '.txt'];

/* ---------------------------------------------------------------- rate limit */

var buckets = new Map();

function rateLimited(ip) {
  var now = Date.now();
  var bucket = buckets.get(ip);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + config.rateLimit.windowMs };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  if (buckets.size > 5000) buckets.clear();
  return bucket.count > config.rateLimit.max;
}

/* -------------------------------------------------------------------- helpers */

function applyCors(req, res) {
  var origin = req.headers.origin;
  var allowed = config.allowedOrigins;
  if (!origin) return;
  if (allowed.length === 0 || allowed.indexOf(origin) >= 0) {
    res.setHeader('Access-Control-Allow-Origin', allowed.length ? origin : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(req, res, status, body) {
  var text = JSON.stringify(body);
  var buffer = Buffer.from(text, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status >= 400 ? 'no-store' : 'public, max-age=30');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (buffer.length > 1024 && (req.headers['accept-encoding'] || '').indexOf('gzip') >= 0) {
    buffer = zlib.gzipSync(buffer);
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Content-Length', buffer.length);
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

function serveStatic(req, res, pathname) {
  var rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  else if (rel.charAt(rel.length - 1) === '/') rel += 'index.html';

  var firstSegment = rel.split('/')[1];
  if (BLOCKED_DIRS.indexOf(firstSegment) >= 0) return notFound(res);

  var filePath = path.join(ROOT, path.normalize(rel));
  if (filePath.indexOf(path.resolve(ROOT)) !== 0) return notFound(res);

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) return notFound(res);

    var ext = path.extname(filePath).toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    var etag = 'W/"' + stat.size + '-' + Math.floor(stat.mtimeMs) + '"';

    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // css/js revalidate every load so a redeploy reaches the TV immediately;
    // images and subtitles can be cached, they carry their own version in the name.
    var cacheControl = 'public, max-age=3600';
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json') {
      cacheControl = 'no-cache';
    }
    res.setHeader('Cache-Control', cacheControl);

    var range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      var parts = range.replace('bytes=', '').split('-');
      var start = parts[0] === '' ? stat.size - Number(parts[1]) : Number(parts[0]);
      var end = parts[1] === '' || parts[0] === '' ? stat.size - 1 : Number(parts[1]);
      if (isNaN(start) || isNaN(end) || start < 0 || end >= stat.size || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', 'bytes */' + stat.size);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
    }

    var compressible = COMPRESSIBLE.indexOf(ext) >= 0 && stat.size > 1400 &&
      (req.headers['accept-encoding'] || '').indexOf('gzip') >= 0;

    if (compressible) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      if (req.method === 'HEAD') return res.end();
      var gz = zlib.createGzip({ level: 6 });
      return fs.createReadStream(filePath).pipe(gz).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

/* --------------------------------------------------------------------- server */

var server = http.createServer(function (req, res) {
  var parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  var pathname = parsed.pathname;
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || 'unknown';

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: 'Only GET is supported' } });
  }

  // Media is deliberately outside the JSON rate bucket: seeking can issue many
  // short Range requests and must not exhaust the API allowance.
  var media = pathname.match(/^\/api\/media\/([a-f0-9]{32,64})$/);
  if (media) {
    mediaProxy.proxy(req, res, media[1]);
    return;
  }

  if (pathname.indexOf('/api/') === 0) {
    if (rateLimited(ip)) {
      res.setHeader('Retry-After', Math.ceil(config.rateLimit.windowMs / 1000));
      return sendJson(req, res, 429, { error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    var params = {};
    parsed.searchParams.forEach(function (value, key) {
      if (key === 'id' && !params.id) params.id = value;
      else params[key] = value;
    });
    var route = pathname.replace(/\/+$/, '');
    Promise.resolve()
      .then(function () { return api.handle(route, params); })
      .then(function (result) {
        sendJson(req, res, result.status, result.body);
      })
      .catch(function (err) {
        var status = err.status || 500;
        if (status >= 500) {
          // Server-side detail only in the log; the TV gets one sentence.
          console.error('[api] ' + pathname + ' -> ' + (err.code || 'error') + ': ' + err.message);
        }
        var body = {
          error: {
            code: err.code || 'server_error',
            message: err.status && err.status < 500 ? err.message : err.message || 'The content service is unavailable right now.'
          }
        };
        if (err.code === 'provider_not_configured') {
          try {
            body.error.missing = require('./providers').active().meta().missing || [];
          } catch (e) {
            body.error.missing = [];
          }
        }
        sendJson(req, res, status, body);
      });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(config.port, config.host, function () {
  var meta = require('./providers').active().meta();
  console.log('CineVault TV  http://localhost:' + config.port + '/');
  console.log('  provider  : ' + meta.provider + (meta.demo ? ' (test fixture data)' : ''));
  console.log('  static    : ' + ROOT);
  if (envInfo.loaded) console.log('  env file  : backend/.env (' + envInfo.keys + ' values)');
  if (meta.signing) {
    console.log('  signing   : ' + (meta.signing.enabled
      ? meta.signing.scheme + ' v' + meta.signing.version + ' (' + meta.signing.keyEncoding + ' key)'
      : 'DISABLED — the live provider rejects unsigned requests'));
  }
  if (meta.session) {
    console.log('  session   : ' + (meta.session.enabled
      ? (meta.session.mode === 'account' ? 'account token (configured)' : 'visitor token (auto, in-memory)')
      : 'guest login disabled'));
  }
  if (meta.provider === 'moviebox' && !meta.configured) {
    console.log('  MISSING   : ' + (meta.missing || []).join(', ') +
      ' — catalogue routes answer 503 until these are set in backend/.env');
  }
});

process.on('SIGTERM', function () { server.close(); });
