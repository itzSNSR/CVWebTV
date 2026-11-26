'use strict';

/**
 * MovieBox guest session.
 *
 * Catalogue browsing works with the signed application key alone, but details,
 * seasons, captions and playback answer HTTP 441 "miss token" until the request
 * carries a visitor JWT. The Android app's LocalMovieBoxServer obtains one:
 *
 *   POST /wefeed-mobile-bff/user-api/visitor-login
 *   body: {"device_id":"...","deviceId":"..."}
 *
 * then sends `Authorization: Bearer <token>` and `X-Client-Status: 0`.
 *
 * The token is cached in memory only, refreshed shortly before its JWT `exp`,
 * and never logged, persisted or returned to the television.
 */

var http = require('http');
var https = require('https');

var auth = require('./movieboxSigner');

var token = '';
var expiresAt = 0;
var pending = null;
// A configured account token is preferred once; if the provider rejects it,
// fall back to the guest token for the rest of this process.
var accountRejected = false;

var EXPIRY_MARGIN_MS = 60000;
var FALLBACK_TTL_MS = 30 * 60 * 1000;

function settings() {
  return require('../config/config').moviebox;
}

function accountToken() {
  return String(settings().userToken || '').trim();
}

function accountUsable() {
  if (accountRejected) return false;
  var value = accountToken();
  if (!value) return false;
  var exp = tokenExpiry(value);
  return !exp || exp - EXPIRY_MARGIN_MS > Date.now();
}

function enabled() {
  var mb = settings();
  return accountUsable() || (mb.guestLogin !== false && !!mb.authBaseUrl);
}

function sessionError(message) {
  var err = new Error(message);
  err.code = 'provider_session_unavailable';
  err.status = 502;
  return err;
}

/** Reads `exp` from a JWT without verifying it (the provider verifies it). */
function tokenExpiry(value) {
  try {
    var parts = String(value || '').split('.');
    if (parts.length < 2) return 0;
    var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    var decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded && typeof decoded.exp === 'number' ? decoded.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

function peekToken() {
  if (accountUsable()) return accountToken();
  if (!token) return '';
  if (expiresAt && expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
    token = '';
    expiresAt = 0;
    return '';
  }
  return token;
}

function clear() {
  token = '';
  expiresAt = 0;
}

function login() {
  var mb = settings();
  return new Promise(function (resolve, reject) {
    var target;
    try {
      target = new URL('/wefeed-mobile-bff/user-api/visitor-login', mb.authBaseUrl);
    } catch (e) {
      return reject(sessionError('MOVIEBOX_AUTH_BASE_URL is not a valid URL.'));
    }
    target.searchParams.set('host', mb.authHost || target.hostname);

    var body = JSON.stringify({
      device_id: mb.deviceId,
      deviceId: mb.deviceId
    });
    var signer = auth.create(Object.assign({}, mb, { baseUrl: mb.authBaseUrl }));
    var headers;
    try {
      headers = signer.signOfficial('POST', target.pathname + target.search, body, '', null);
    } catch (e) {
      return reject(e);
    }

    var lib = target.protocol === 'http:' ? http : https;
    var req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      headers: headers,
      timeout: 12000
    }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* handled below */ }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          var reason = json && (json.message || json.reason)
            ? ' (' + String(json.message || json.reason).slice(0, 120) + ')'
            : '';
          return reject(sessionError(
            'MovieBox visitor login failed with HTTP ' + res.statusCode + reason + '.'));
        }

        var value = json && json.data && json.data.token;
        if (typeof value !== 'string' || value.length < 16) {
          return reject(sessionError('MovieBox visitor login did not return a token.'));
        }

        token = value;
        expiresAt = tokenExpiry(value) || Date.now() + FALLBACK_TTL_MS;
        resolve(token);
      });
    });

    req.on('timeout', function () {
      req.destroy(new Error('timeout'));
    });
    req.on('error', function (e) {
      var timedOut = /timeout/i.test(e.message || '');
      reject(sessionError(timedOut
        ? 'MovieBox visitor login timed out.'
        : 'Could not reach the MovieBox visitor login endpoint.'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Returns a valid visitor token, logging in at most once at a time.
 * @param {boolean} [force] ignore the cached token
 */
function getToken(force) {
  // The provider rejected the configured account token: use the guest token
  // instead of retrying the same value. The catalogue and details still work;
  // playback will be the guest preview until the token is refreshed.
  if (force && accountToken() && !accountRejected) accountRejected = true;
  if (!force) {
    var current = peekToken();
    if (current) return Promise.resolve(current);
  }
  if (!enabled()) {
    return Promise.reject(sessionError(accountToken()
      ? 'MovieBox rejected MOVIEBOX_USER_TOKEN and guest login is disabled.'
      : 'MovieBox guest login is disabled (MOVIEBOX_GUEST_LOGIN=false).'));
  }
  if (pending) return pending;

  pending = login().then(function (value) {
    pending = null;
    return value;
  }, function (err) {
    pending = null;
    throw err;
  });
  return pending;
}

/** Secret-free state for /api/meta and logs. */
function describe() {
  var account = accountUsable();
  return {
    enabled: enabled(),
    mode: account ? 'account' : 'guest',
    accountConfigured: !!accountToken(),
    cached: !!peekToken(),
    expiresAt: account
      ? (tokenExpiry(accountToken()) || null)
      : (expiresAt || null)
  };
}

module.exports = {
  enabled: enabled,
  getToken: getToken,
  peekToken: peekToken,
  clear: clear,
  describe: describe,
  __internals: {
    tokenExpiry: tokenExpiry,
    accountToken: accountToken
  }
};
