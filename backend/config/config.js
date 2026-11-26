'use strict';

/**
 * CineVault TV backend configuration.
 *
 * Every value that could identify the provider account comes from the
 * environment. Nothing here is ever sent to the television, and nothing here
 * contains a credential. See .env.example for the full list.
 */

var env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

module.exports = {
  // 'moviebox' (production) or 'fixture' (automated tests only, no live data).
  // There is no silent fallback: if MovieBox is selected and unconfigured,
  // every catalogue route answers 503 provider_not_configured and the TV
  // shows an error with a Retry button.
  provider: (env.CVTV_PROVIDER || 'moviebox').toLowerCase(),

  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '0.0.0.0',

  // backend/config -> project root
  staticRoot: require('path').join(__dirname, '..', '..'),
  dataDir: require('path').join(__dirname, '..', 'data'),
  fixtureDir: require('path').join(__dirname, '..', 'fixtures'),

  // Public origin used when the backend has to hand the TV an absolute URL.
  publicOrigin: env.CVTV_PUBLIC_ORIGIN || '',

  // Origins allowed to call the API from a browser. Same-origin deployment
  // needs nothing here; set it when the frontend sits on another host.
  allowedOrigins: (env.CVTV_ALLOWED_ORIGINS || '').split(',').filter(Boolean),

  requestTimeoutMs: 12000,
  retryDelayMs: 400,
  cacheTtlMs: 120000,
  maxCacheEntries: 160,
  pageSize: 20,
  maxPageSize: 40,

  rateLimit: { windowMs: 60000, max: 90 },

  /**
   * MovieBox. The signing key is a provider-issued secret and is read from the
   * environment only. Without base URL and key the adapter is inert.
   */
  moviebox: {
    // Newer host used by the APK local server. Search is a signed POST here;
    // the older api6 host answers 404/407 for it.
    baseUrl: env.MOVIEBOX_BASE_URL || 'https://api.inmoviebox.com/',
    // Provider-issued application signing key. Required unless signing is
    // explicitly disabled for a local mock endpoint.
    appKey: env.MOVIEBOX_APP_KEY || '',
    // Request-signing controls consumed by backend/auth/movieboxSigner.js.
    signing: {
      enabled: bool(env.MOVIEBOX_SIGNING_ENABLED, true),
      scheme: (env.MOVIEBOX_SIGNING_SCHEME || 'hmac-md5').toLowerCase(),
      version: env.MOVIEBOX_SIGNATURE_VERSION || '2',
      keyEncoding: (env.MOVIEBOX_APP_KEY_ENCODING || 'auto').toLowerCase()
    },
    session: env.MOVIEBOX_SESSION || '',
    region: (env.MOVIEBOX_REGION || 'IN').toUpperCase(),
    // Value of the `host` query parameter the Android client sends with
    // subject-api/get. Default matches the client.
    host: env.MOVIEBOX_HOST || 'api.inmoviebox.com',
    version: env.MOVIEBOX_VERSION || '16.2.1',
    referer: env.MOVIEBOX_REFERER || '',
    // Device identity used in X-Client-Info; the Android defaults are public
    // constants, not account data.
    deviceId: env.MOVIEBOX_DEVICE_ID || '8c5da15be6ca34e724a27bc102cd8bcf',
    gaid: env.MOVIEBOX_GAID || '4b6c3748-8dfa-4fb6-bda9-163a98e8dfa9',
    spCode: env.MOVIEBOX_SP_CODE || '40401',
    // Newer request profile used by the APK local server. Details and playback
    // need a visitor token obtained from authBaseUrl; catalogue calls do not.
    appId: env.MOVIEBOX_APP_ID || '4U01pxRu278GqCZKY9',
    officialVersion: env.MOVIEBOX_OFFICIAL_VERSION || '4.0.02',
    officialVersionCode: parseInt(env.MOVIEBOX_OFFICIAL_VERSION_CODE || '50020126', 10),
    osVersion: env.MOVIEBOX_OS_VERSION || '14',
    apiSpCode: env.MOVIEBOX_API_SP_CODE || '404',
    guestLogin: bool(env.MOVIEBOX_GUEST_LOGIN, true),
    // Optional logged-in account token (user_auth_token from the APK). The
    // guest token plus the provider's UGC fallback covers the normal catalogue;
    // an account token is only needed for account-gated titles.
    userToken: env.MOVIEBOX_USER_TOKEN || '',
    authBaseUrl: env.MOVIEBOX_AUTH_BASE_URL || 'https://api.inmoviebox.com/',
    authHost: env.MOVIEBOX_AUTH_HOST || 'api.inmoviebox.com',
    // Catalogue category ids (see MovieBoxApi.kt / LocalMovieBoxServer.kt).
    categoryMovies: parseInt(env.MOVIEBOX_CAT_MOVIES || '2', 10),
    categorySeries: parseInt(env.MOVIEBOX_CAT_SERIES || '5', 10),
    // Endpoint paths. The Retrofit interface uses play-info; the reference
    // server implementation uses play-info/v2, so both are tried in order.
    playInfoPaths: ['wefeed-mobile-bff/subject-api/play-info', 'wefeed-mobile-bff/subject-api/play-info/v2'],
    seasonInfoPaths: ['wefeed-mobile-bff/subject-api/season-info/v2', 'wefeed-mobile-bff/subject-api/season-info'],
    qualityLabels: { 360: '360p', 480: '480p', 720: '720p', 1080: '1080p', 2160: '4K' }
  },

  /**
   * Optional TMDB enrichment for the OTT platform filters. Only used to attach
   * a platform badge when a reliable provider id comes back; a title with no
   * match keeps no platform, and the OTT filters then legitimately return
   * nothing instead of guessing.
   */
  tmdb: {
    apiKey: env.TMDB_API_KEY || '',
    region: (env.TMDB_REGION || 'IN').toUpperCase(),
    // MediaType-specific watch provider ids for the region above.
    providers: {
      netflix: 8,
      prime: 119,
      hotstar: 2336,
      appletv: 350
    },
    cacheTtlMs: 24 * 60 * 60 * 1000
  },

  ottFilters: [
    { id: 'netflix', name: 'Netflix' },
    { id: 'prime', name: 'Prime Video' },
    { id: 'hotstar', name: 'JioHotstar' },
    { id: 'appletv', name: 'Apple TV+' }
  ],

  // Malayalam sections are produced only from items whose provider metadata
  // names the language. No guessing by title.
  languageSections: {
    malayalam: ['malayalam', 'mal', 'ml']
  }
};
