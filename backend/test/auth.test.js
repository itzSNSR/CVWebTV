'use strict';

/**
 * Unit tests for backend/auth/movieboxSigner.js.
 *
 * These use explicit test credentials and no network. The expected signature
 * is derived again here from the provider specification so the module is not
 * compared with itself.
 *
 *   node --test backend/test/*.test.js
 */

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('crypto');

var auth = require('../auth/movieboxSigner');
var credentials = require('./fixtures/test-credentials');

var BASE_OPTIONS = {
  baseUrl: 'https://api.example.test/',
  appKey: credentials.appKey,
  appKeyEncoding: 'base64',
  version: '16.2.1',
  region: 'IN',
  signing: { enabled: true, scheme: 'hmac-md5', version: '2' }
};

function referenceSignature(method, canonicalPath, bodyString, timestamp, keyBytes) {
  var body = bodyString ? Buffer.from(bodyString, 'utf8') : Buffer.alloc(0);
  var bodyLength = body.length ? String(body.length) : '';
  var bodyHash = body.length
    ? crypto.createHash('md5').update(body.slice(0, Math.min(body.length, 102400))).digest('hex')
    : '';
  var canonical = [
    method, 'application/json', 'application/json;charset=UTF-8',
    bodyLength, String(timestamp), bodyHash, canonicalPath
  ].join('\n');
  return crypto.createHmac('md5', keyBytes).update(canonical, 'utf8').digest('base64');
}

test('canonical query is decoded and sorted by name', function () {
  assert.strictEqual(
    auth.canonicalQuery('?subjectId=42&se=1&quality=1080p&ep=2'),
    'ep=2&quality=1080p&se=1&subjectId=42');
  assert.strictEqual(auth.canonicalQuery(''), '');
  assert.strictEqual(auth.canonicalQuery('?q=big%20buck'), 'q=big buck');
});

test('canonical path sorts any query the caller passes', function () {
  assert.strictEqual(
    auth.canonicalPath('/wefeed-mobile-bff/subject-api/get?subjectId=9&host=api6.aoneroom.com'),
    '/wefeed-mobile-bff/subject-api/get?host=api6.aoneroom.com&subjectId=9');
  assert.strictEqual(auth.canonicalPath('/home/v2/get-list'), '/home/v2/get-list');
});

test('signature matches the provider specification for a GET', function () {
  var signer = auth.create(BASE_OPTIONS);
  var timestamp = 1700000000000;
  var path = '/wefeed-mobile-bff/subject-api/play-info?subjectId=42&se=1&ep=2&quality=1080p';
  var headers = signer.sign('GET', path, null, timestamp);
  var expected = '1700000000000|2|' + referenceSignature(
    'GET', '/wefeed-mobile-bff/subject-api/play-info?ep=2&quality=1080p&se=1&subjectId=42',
    null, timestamp, Buffer.from(credentials.appKey, 'base64'));

  assert.strictEqual(headers['x-tr-signature'], expected);
  assert.strictEqual(headers['X-Client-Token'], timestamp + ',' +
    crypto.createHash('md5').update(String(timestamp).split('').reverse().join('')).digest('hex'));
});

test('body length and body hash are part of the POST signature', function () {
  var signer = auth.create(BASE_OPTIONS);
  var timestamp = 1700000000123;
  var body = JSON.stringify({ categoryId: 2, page: 1, pageSize: 20 });
  var headers = signer.sign('POST', '/home/v2/get-list', body, timestamp);
  var expected = '1700000000123|2|' + referenceSignature(
    'POST', '/home/v2/get-list', body, timestamp,
    Buffer.from(credentials.appKey, 'base64'));

  assert.strictEqual(headers['x-tr-signature'], expected);
  assert.strictEqual(headers.Accept, 'application/json');
  assert.strictEqual(headers['Content-Type'], 'application/json;charset=UTF-8');
});

test('signature version is configurable through the signing options', function () {
  var signer = auth.create({
    baseUrl: BASE_OPTIONS.baseUrl,
    appKey: credentials.appKey,
    appKeyEncoding: 'base64',
    signing: { enabled: true, scheme: 'hmac-md5', version: '7' }
  });
  var header = signer.sign('GET', '/x', null, 1700000000000)['x-tr-signature'];
  assert.strictEqual(header.split('|')[1], '7');
});

test('base64 and utf8 encodings of the same key produce the same signature', function () {
  var base64Signer = auth.create(BASE_OPTIONS);
  var utf8Signer = auth.create({
    baseUrl: BASE_OPTIONS.baseUrl,
    appKey: credentials.appKeyUtf8,
    appKeyEncoding: 'utf8',
    signing: { enabled: true, scheme: 'hmac-md5', version: '2' }
  });

  var base64Signature = base64Signer.sign('GET', '/x', null, 1700000000000)['x-tr-signature'];
  var utf8Signature = utf8Signer.sign('GET', '/x', null, 1700000000000)['x-tr-signature'];

  assert.strictEqual(base64Signature, utf8Signature);
  assert.strictEqual(base64Signature, '1700000000000|2|' + referenceSignature(
    'GET', '/x', null, 1700000000000, Buffer.from(credentials.appKeyUtf8, 'utf8')));

  var differentKey = auth.create({
    baseUrl: BASE_OPTIONS.baseUrl,
    appKey: 'ZGlmZmVyZW50LXRlc3Qta2V5LTAwMQ==',
    appKeyEncoding: 'base64',
    signing: { enabled: true, scheme: 'hmac-md5', version: '2' }
  }).sign('GET', '/x', null, 1700000000000)['x-tr-signature'];
  assert.notStrictEqual(differentKey, base64Signature);
});

test('official profile matches the newer APK request headers', function () {
  var signer = auth.create(BASE_OPTIONS);
  var path = '/wefeed-mobile-bff/user-api/visitor-login?host=api.inmoviebox.com';
  var body = '{"device_id":"test-device","deviceId":"test-device"}';
  var headers = signer.signOfficial('POST', path, body, '', 1700000000000);

  assert.strictEqual(headers.appid, '4U01pxRu278GqCZKY9');
  assert.strictEqual(headers['X-Sign-Version'], '2.0');
  assert.strictEqual(headers['X-Timestamp'], '1700000000000');
  assert.strictEqual(headers['X-Client-Status'], '1');
  assert.strictEqual(headers.Authorization, undefined);
  assert.strictEqual(headers['x-tr-signature'], '1700000000000|2|' +
    referenceSignature('POST', path, body, 1700000000000,
      Buffer.from(credentials.appKey, 'base64')));

  var info = JSON.parse(headers['X-Client-Info']);
  assert.strictEqual(info.version_name, '4.0.02');
  assert.strictEqual(info.version_code, 50020126);
  assert.strictEqual(info.sp_code, '404');
  assert.strictEqual(info.package_name, 'com.community.oneroom');

  var withToken = signer.signOfficial('GET', '/x', null, 'visitor-token', 1700000000000);
  assert.strictEqual(withToken['X-Client-Status'], '0');
  assert.strictEqual(withToken.Authorization, 'Bearer visitor-token');
});

test('signing disabled omits the signed headers but keeps the client headers', function () {
  var signer = auth.create({
    baseUrl: BASE_OPTIONS.baseUrl,
    appKey: '',
    signing: { enabled: false, scheme: 'hmac-md5', version: '2' }
  });
  var headers = signer.sign('GET', '/x', null, 1700000000000);

  assert.strictEqual(headers['x-tr-signature'], undefined);
  assert.strictEqual(headers['X-Client-Token'], undefined);
  assert.strictEqual(headers['X-Client-Info'].indexOf('com.community.oneroom') > 0, true);
  assert.deepStrictEqual(signer.missing(), []);
  assert.strictEqual(signer.configured(), true);
});

test('missing key, unknown scheme and unknown encoding fail closed', function () {
  var noKey = auth.create({ signing: { enabled: true, scheme: 'hmac-md5' } });
  assert.deepStrictEqual(noKey.missing(), ['MOVIEBOX_APP_KEY']);
  assert.throws(function () { noKey.sign('GET', '/x', null, 1); }, /MOVIEBOX_APP_KEY/);

  var badScheme = auth.create({
    appKey: credentials.appKey,
    signing: { enabled: true, scheme: 'plain' }
  });
  assert.deepStrictEqual(badScheme.missing(), ['MOVIEBOX_SIGNING_SCHEME']);

  var badEncoding = auth.create({
    appKey: credentials.appKey,
    signing: { enabled: true, scheme: 'hmac-md5', keyEncoding: 'hex' }
  });
  assert.deepStrictEqual(badEncoding.missing(), ['MOVIEBOX_APP_KEY_ENCODING']);
});

test('describe never returns the credential itself', function () {
  var signer = auth.create(BASE_OPTIONS);
  var described = signer.describe();
  assert.strictEqual(described.enabled, true);
  assert.strictEqual(described.scheme, 'hmac-md5');
  assert.strictEqual(described.version, '2');
  assert.strictEqual(described.keyEncoding, 'base64');
  assert.strictEqual(described.configured, true);
  assert.ok(JSON.stringify(described).indexOf(credentials.appKey) < 0);
});
