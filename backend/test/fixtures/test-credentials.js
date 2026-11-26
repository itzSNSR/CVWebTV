'use strict';

/**
 * TEST-ONLY signing credentials.
 *
 * This is a made-up key used by backend/test/support/mock-moviebox.js. It is
 * never valid against the live provider and must never be used in production.
 * It exists so the complete signed request path can be exercised locally
 * without an authorised credential.
 *
 * The live key belongs in backend/.env as MOVIEBOX_APP_KEY.
 */

module.exports = {
  // Base64 form; MOVIEBOX_APP_KEY_ENCODING=auto decodes it to 32 bytes.
  appKey: 'Y2luZXZhdWx0LXR2LXRlc3Qtc2lnbmluZy1rZXktMDE=',
  // The same key as text, for explicit utf8-encoding tests.
  appKeyUtf8: 'cinevault-tv-test-signing-key-01'
};
