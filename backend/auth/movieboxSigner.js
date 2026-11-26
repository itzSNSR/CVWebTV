'use strict';

/**
 * MovieBox request authentication.
 *
 * The authorised provider API does not accept a plain API key. Every request
 * carries an HMAC-MD5 signature over this canonical string:
 *
 *   METHOD\naccept\ncontent-type\nbodyLength\ntimestamp\nbodyMd5\npath?sortedQuery
 *
 * x-tr-signature = <timestamp>|<version>|<base64 HMAC-MD5>
 *
 * The query string is sorted by parameter name and decoded before signing
 * (OkHttp's queryParameterNames.sorted()), not the encoded URL. The first
 * 102400 bytes of the body are hashed, exactly like the Android interceptor.
 *
 * This module uses only Node's built-in crypto module. Credentials come from
 * backend/.env through config.moviebox and never leave the server.
 *
 * Configuration (see backend/.env.example):
 *   MOVIEBOX_APP_KEY             provider-issued signing key (required)
 *   MOVIEBOX_APP_KEY_ENCODING    auto | base64 | utf8
 *   MOVIEBOX_SIGNING_SCHEME      hmac-md5 (the authorised scheme)
 *   MOVIEBOX_SIGNATURE_VERSION   x-tr-signature version, default 2
 *   MOVIEBOX_SIGNING_ENABLED     true for the live provider
 */

var crypto = require('crypto');

var ACCEPT = 'application/json';
var CONTENT_TYPE = 'application/json;charset=UTF-8';
var BODY_HASH_LIMIT = 102400;
var SUPPORTED_SCHEMES = ['hmac-md5'];
var SUPPORTED_KEY_ENCODINGS = ['auto', 'base64', 'utf8'];

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function decodeBase64(value) {
  return Buffer.from(String(value || ''), 'base64');
}

/**
 * The canonical query is NOT the encoded search string: each value is
 * decoded, the pairs are sorted by name and joined "name=value".
 */
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
    } catch (e) { /* keep the raw pair, as the client does */ }
    pairs.push({ name: name, value: value });
  });

  pairs.sort(function (a, b) {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return pairs.map(function (p) { return p.name + '=' + p.value; }).join('&');
}

/** Path plus its decoded, name-sorted query, ready to sign. */
function canonicalPath(pathWithQuery) {
  var input = String(pathWithQuery || '');
  var hash = input.indexOf('#');
  if (hash >= 0) input = input.substring(0, hash);
  var q = input.indexOf('?');
  var pathname = q < 0 ? input : input.substring(0, q);
  var sorted = canonicalQuery(q < 0 ? '' : input.substring(q));
  return pathname + (sorted ? '?' + sorted : '');
}

function configError(missing) {
  var err = new Error('Request signing is not configured. Missing: ' +
    missing.join(', ') + '.');
  err.code = 'provider_not_configured';
  err.status = 503;
  return err;
}

function normalize(raw) {
  raw = raw || {};
  var signing = raw.signing || {};
  return {
    baseUrl: String(raw.baseUrl || ''),
    appKey: String(raw.appKey || ''),
    keyEncoding: String(raw.appKeyEncoding || signing.keyEncoding || 'auto').toLowerCase(),
    enabled: signing.enabled !== false,
    scheme: String(signing.scheme || 'hmac-md5').toLowerCase(),
    signatureVersion: String(signing.version || '2'),
    appVersion: String(raw.version || '16.2.1'),
    referer: String(raw.referer || ''),
    region: String(raw.region || 'IN').toUpperCase(),
    deviceId: String(raw.deviceId || '8c5da15be6ca34e724a27bc102cd8bcf'),
    gaid: String(raw.gaid || '4b6c3748-8dfa-4fb6-bda9-163a98e8dfa9'),
    spCode: String(raw.spCode || '40401'),
    // Newer request profile used by the APK's LocalMovieBoxServer. The app id
    // and device strings are public APK constants; the signing key stays
    // private in backend/.env.
    appId: String(raw.appId || '4U01pxRu278GqCZKY9'),
    officialVersion: String(raw.officialVersion || '4.0.02'),
    officialVersionCode: Number(raw.officialVersionCode || 50020126),
    osVersion: String(raw.osVersion || '14'),
    apiSpCode: String(raw.apiSpCode || '404'),
    authBaseUrl: String(raw.authBaseUrl || 'https://api.inmoviebox.com/'),
    authHost: String(raw.authHost || 'api.inmoviebox.com'),
    guestLogin: raw.guestLogin !== false
  };
}

/**
 * Builds an independent signer from a provider options object. The default
 * export wraps the live config; tests and local fixtures use create() with
 * their own test credentials.
 */
function create(raw) {
  var options = normalize(raw);

  function missing() {
    if (!options.enabled) return [];
    var out = [];
    if (!options.appKey) out.push('MOVIEBOX_APP_KEY');
    if (SUPPORTED_SCHEMES.indexOf(options.scheme) < 0) out.push('MOVIEBOX_SIGNING_SCHEME');
    if (SUPPORTED_KEY_ENCODINGS.indexOf(options.keyEncoding) < 0) out.push('MOVIEBOX_APP_KEY_ENCODING');
    return out;
  }

  function configured() {
    return missing().length === 0;
  }

  /**
   * auto keeps the Android behaviour: a value that base64-decodes to at least
   * eight bytes is treated as base64, otherwise it is used literally.
   */
  function keyBytes() {
    if (!options.appKey) throw configError(missing().length ? missing() : ['MOVIEBOX_APP_KEY']);
    if (options.keyEncoding === 'utf8') return Buffer.from(options.appKey, 'utf8');
    if (options.keyEncoding === 'base64') {
      var explicit = decodeBase64(options.appKey);
      if (!explicit.length) throw configError(['MOVIEBOX_APP_KEY']);
      return explicit;
    }
    var auto = decodeBase64(options.appKey);
    return auto.length >= 8 ? auto : Buffer.from(options.appKey, 'utf8');
  }

  /** Device metadata sent as X-Client-Info, whitespace stripped as the client does. */
  function clientInfo() {
    var info = {
      package_name: 'com.community.oneroom',
      version_name: '3.0.03.0529.03',
      version_code: 50020042,
      os: 'android',
      os_version: '12',
      install_ch: 'ps',
      device_id: options.deviceId,
      install_store: 'ps',
      gaid: options.gaid,
      brand: 'Google',
      model: 'Pixel 6',
      system_language: 'en',
      net: 'NETWORK_WIFI',
      region: options.region,
      timezone: options.region === 'US' ? 'America/New_York' : 'Asia/Kolkata',
      sp_code: options.spCode,
      'X-Play-Mode': '2'
    };
    return JSON.stringify(info).replace(/\s+/g, '');
  }

  function baseHeaders() {
    return {
      'User-Agent': 'MovieBoxPro/' + options.appVersion + ' (Android 12; Pixel 6)',
      'X-M-Version': options.appVersion,
      'X-Client-Info': clientInfo(),
      Accept: ACCEPT,
      'Content-Type': CONTENT_TYPE,
      Referer: options.referer || options.baseUrl,
      'X-Play-Mode': '2'
    };
  }

  function languageFor(region) {
    if (region === 'BR') return 'pt';
    if (region === 'RU') return 'ru';
    if (region === 'FR' || region === 'BE') return 'fr';
    if (region === 'IT') return 'it';
    return 'en';
  }

  function acceptLanguageFor(region) {
    var map = {
      IN: 'en-IN,hi-IN;q=0.9,en;q=0.8',
      US: 'en-US,en;q=0.9',
      BR: 'pt-BR,pt;q=0.9,en;q=0.8',
      RU: 'ru-RU,ru;q=0.9,en;q=0.8',
      FR: 'fr-FR,fr;q=0.9,en;q=0.8',
      BE: 'fr-BE,nl-BE,en;q=0.8',
      IT: 'it-IT,it;q=0.9,en;q=0.8'
    };
    return map[region] || 'en-US,en;q=0.9';
  }

  /** Device JSON of the newer APK profile (LocalMovieBoxServer). */
  function officialClientInfo() {
    var info = {
      package_name: 'com.community.oneroom',
      version_name: options.officialVersion,
      version_code: options.officialVersionCode,
      os: 'android',
      os_version: options.osVersion,
      install_ch: 'ps',
      device_id: options.deviceId,
      install_store: 'ps',
      gaid: '',
      brand: 'Google',
      model: 'Pixel 6',
      system_language: languageFor(options.region),
      net: 'wifi',
      region: options.region,
      timezone: options.region === 'US' ? 'America/New_York' : 'Asia/Kolkata',
      sp_code: options.apiSpCode
    };
    return JSON.stringify(info).replace(/\s+/g, '');
  }

  function canonicalFor(method, pathWithQuery, bodyString, timestamp) {
    var body = bodyString ? Buffer.from(String(bodyString), 'utf8') : Buffer.alloc(0);
    var bodyLength = body.length ? String(body.length) : '';
    var bodyHash = body.length
      ? md5(body.slice(0, Math.min(body.length, BODY_HASH_LIMIT)))
      : '';
    var path = canonicalPath(pathWithQuery);
    var value = [
      String(method || 'GET'), ACCEPT, CONTENT_TYPE, bodyLength,
      String(timestamp), bodyHash, path
    ].join('\n');
    return { value: value, path: path, bodyLength: bodyLength, bodyHash: bodyHash };
  }

  /**
   * Returns the header set for one request. Signing disabled is only useful
   * for a local mock endpoint; the live provider rejects unsigned requests.
   */
  function sign(method, pathWithQuery, bodyString, timestampOverride) {
    var timestamp = timestampOverride === undefined || timestampOverride === null
      ? String(Date.now())
      : String(timestampOverride);
    var headers = baseHeaders();
    if (!options.enabled) return headers;

    var miss = missing();
    if (miss.length) throw configError(miss);

    var canonical = canonicalFor(method, pathWithQuery, bodyString, timestamp);
    var signature = crypto.createHmac('md5', keyBytes())
      .update(canonical.value, 'utf8')
      .digest('base64');

    headers['X-Client-Token'] = timestamp + ',' + md5(timestamp.split('').reverse().join(''));
    headers['x-tr-signature'] = timestamp + '|' + options.signatureVersion + '|' + signature;
    return headers;
  }

  /**
   * Header set used by the newer provider profile. The canonical string and
   * HMAC are identical to sign(); only the client identity headers differ.
   * A visitor token, when present, is sent as a Bearer token and never logged.
   */
  function signOfficial(method, pathWithQuery, bodyString, token, timestampOverride) {
    var timestamp = timestampOverride === undefined || timestampOverride === null
      ? String(Date.now())
      : String(timestampOverride);
    var headers = {
      'User-Agent': 'MovieBox/' + options.officialVersion +
        ' (Android ' + options.osVersion + '; Pixel 6)',
      Accept: ACCEPT,
      'Accept-Language': acceptLanguageFor(options.region),
      'Content-Type': CONTENT_TYPE,
      'X-Sign-Version': '2.0',
      appid: options.appId,
      region: options.region,
      lang: languageFor(options.region),
      os: 'android',
      'X-Timestamp': timestamp,
      Referer: options.referer || options.baseUrl,
      'X-Play-Mode': '2',
      'X-Client-Info': officialClientInfo(),
      'X-Client-Status': token ? '0' : '1'
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (!options.enabled) return headers;

    var miss = missing();
    if (miss.length) throw configError(miss);

    var canonical = canonicalFor(method, pathWithQuery, bodyString, timestamp);
    var signature = crypto.createHmac('md5', keyBytes())
      .update(canonical.value, 'utf8')
      .digest('base64');

    headers['X-Client-Token'] = timestamp + ',' + md5(timestamp.split('').reverse().join(''));
    headers['x-tr-signature'] = timestamp + '|' + options.signatureVersion + '|' + signature;
    return headers;
  }

  /** Public, secret-free description for /api/meta and the server log. */
  function describe() {
    return {
      enabled: options.enabled,
      scheme: options.scheme,
      version: options.signatureVersion,
      keyEncoding: options.keyEncoding,
      configured: configured(),
      missing: missing()
    };
  }

  return {
    sign: sign,
    headers: sign,
    signOfficial: signOfficial,
    canonicalString: function (method, pathWithQuery, bodyString, timestamp) {
      return canonicalFor(method, pathWithQuery, bodyString,
        timestamp === undefined || timestamp === null ? Date.now() : timestamp).value;
    },
    clientInfo: clientInfo,
    officialClientInfo: officialClientInfo,
    keyBytes: keyBytes,
    missing: missing,
    configured: configured,
    describe: describe
  };
}

// Resolved on every call, so a reloaded config (tests, a supervisor) is never
// served a stale credential.
function currentOptions() {
  return require('../config/config').moviebox;
}

module.exports = {
  sign: function (method, pathWithQuery, bodyString, timestampOverride) {
    return create(currentOptions()).sign(method, pathWithQuery, bodyString, timestampOverride);
  },
  signOfficial: function (method, pathWithQuery, bodyString, token, timestampOverride) {
    return create(currentOptions()).signOfficial(method, pathWithQuery, bodyString, token, timestampOverride);
  },
  canonicalQuery: canonicalQuery,
  canonicalPath: canonicalPath,
  md5: md5,
  clientInfo: function () {
    return create(currentOptions()).clientInfo();
  },
  missing: function () {
    return create(currentOptions()).missing();
  },
  configured: function () {
    return create(currentOptions()).configured();
  },
  describe: function () {
    return create(currentOptions()).describe();
  },
  create: create
};
