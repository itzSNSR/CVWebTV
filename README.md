# CineVault TV 1.0

A lightweight, remote-controlled television edition of CineVault for older Smart TVs
(VU / Hisense on J0821 firmware is the reference device). Plain HTML, plain CSS, ES5
JavaScript, one native `<video>` element, and a small Node backend. No framework, no
player library, no download manager, no account.

The catalogue is served by the **MovieBox provider adapter**. The Android repository
(`CineVault-Classic`) was used as the reference for endpoint shapes and data mapping and
was not modified.

---

## 1. Run it

```bash
cd CineVault-TV
copy backend\.env.example backend\.env     # then edit MOVIEBOX_APP_KEY in it
node backend/server.js                     # http://localhost:8787/
```

Node 18+. **No npm dependencies** — the backend uses only the Node standard library.

**Where the credentials go:** `backend/.env`, variable `MOVIEBOX_APP_KEY` (and
`MOVIEBOX_SESSION` / `MOVIEBOX_BASE_URL` if your authorised access needs them). That file
is read at startup, is git-ignored, and is never served to the browser. Real environment
variables override it, so a service manager can inject the same values instead.

`MOVIEBOX_BASE_URL` already defaults to `https://api.inmoviebox.com/` — the host used by
the APK's local MovieBox server for catalogue, search, details and playback — so in the
normal case the key is the only value you have to supply.

Request signing lives in a separate module, `backend/auth/movieboxSigner.js`, and is
configured entirely by these values. The local `backend/.env` is git-ignored and currently
holds the signing key imported from the Android repository; replace it if you rotate keys.
Details and playback additionally use a visitor token that the backend obtains and caches
automatically (see below).

Windows shortcut: `start-server.bat` (checks for Node, opens the browser, keeps the log
window open).

If the key is missing the app starts and **says so**: every catalogue route answers
`503 provider_not_configured` naming the missing variable, the server log prints
`MISSING : MOVIEBOX_APP_KEY`, and Home shows that message with a Retry button. There is no
demonstration fallback.

## 2. What the provider integration does

`backend/providers/moviebox.js` implements the operations by calling the same endpoints the
Android client uses (nothing invented):

| Operation | Upstream call |
|---|---|
| Trending | `GET wefeed-mobile-bff/subject-api/trending/v2` |
| Latest / Movies / Series | `POST home/v2/get-list` with the category ids from `MovieBoxApi.kt` |
| Ranking | `GET wefeed-mobile-bff/tab/ranking-list` |
| Search | `GET wefeed-mobile-bff/subject-api/search` |
| Details | `GET wefeed-mobile-bff/subject-api/get` |
| Seasons / episodes | `GET wefeed-mobile-bff/subject-api/season-info/v2` |
| Playback + qualities | `GET wefeed-mobile-bff/subject-api/play-info/v2` |
| Subtitles | `GET …/get-ext-captions` (and `…/get-stream-captions` when a stream id is present) |

Details of the mapping:

- **Signing** — `backend/auth/movieboxSigner.js` is a separate authentication module (Node
  `crypto` only) implementing `MovieBoxSignatureInterceptor`: canonical string
  `METHOD\naccept\ncontent-type\nbodyLength\ntimestamp\nbodyMd5\npath?sortedQuery`, HMAC-MD5
  with the base64-decoded key, `x-tr-signature: <ts>|<version>|<base64>`, plus
  `X-Client-Token`, the full `X-Client-Info` device JSON (whitespace stripped, `sp_code`
  and the US/non-US timezone switch, as the client does) and `X-Play-Mode: 2`. The signed
  query string is **sorted by name and decoded**, exactly like OkHttp
  (`url.queryParameterNames.sorted()`), not the encoded URL. `backend/test/contract.test.js`
  re-implements the Kotlin algorithm independently and asserts the two signatures match.
  Signing is configured in `backend/.env` by `MOVIEBOX_APP_KEY`,
  `MOVIEBOX_APP_KEY_ENCODING`, `MOVIEBOX_SIGNING_SCHEME`, `MOVIEBOX_SIGNATURE_VERSION` and
  `MOVIEBOX_SIGNING_ENABLED`; the key is never returned by `/api/meta` or any other route.
- **Guest session** — details, seasons, captions and playback require a MovieBox visitor
  JWT; catalogue browsing does not. `backend/auth/movieboxSession.js` obtains it from
  `POST wefeed-mobile-bff/user-api/visitor-login` with the same signed device body the APK
  uses, caches it in memory, refreshes it before its JWT `exp`, and sends
  `Authorization: Bearer …` plus `X-Client-Status: 0`. The token is never written to disk,
  logged or sent to the television. Configure with `MOVIEBOX_GUEST_LOGIN`,
  `MOVIEBOX_AUTH_BASE_URL` and `MOVIEBOX_AUTH_HOST`. `MOVIEBOX_USER_TOKEN` is optional
  for account-gated titles; the guest token is enough for the normal catalogue.
  An expired or rejected account token falls back to the guest token, and the
  token is never returned by the API.
- **Update-placeholder fallback (UGC)** — some `play-info` responses return one shared
  23-second file on `macdn.aoneroom.com` (MovieBox's "old version / service update"
  notice) instead of the title. The adapter detects that dummy pattern and resolves the
  real file through the same UGC path the APK uses: `ugc/video/first-by-subject`,
  `ugc/collection/download-list`, `ugc/video/download`, and `subject-api/resource` +
  `sniff/config`. The tested movie and episodes resolve as full-length files with the
  guest token.
- **Media proxy** — the real CDN files answer HTTP 429 when a browser sends its
  `Referer`, and a `<video>` element cannot set request headers. `backend/mediaProxy.js`
  registers each real URL under a random same-origin path and streams it with neutral
  headers while forwarding `Range` requests. Playback URLs in the API therefore look like
  `/api/media/<id>`. Set `CVTV_PUBLIC_ORIGIN` when the frontend is on a different origin
  so those URLs are absolute.
- **Endpoint variants** — the Retrofit interface names `play-info`, while the reference
  server implementation uses `play-info/v2` (same for `season-info`). The adapter tries the
  documented path first and moves to the sibling variant on a 404, rather than assuming
  one.
- **Posters** — `poster`/`cover`/`horizontalPoster` may be strings or objects; cards take
  the smallest variant (`thumbUrl` → `webpUrl` → `url`), details take the largest,
  protocol-relative URLs are upgraded to `https`, and relative paths are passed through
  for the client to resolve against the API origin.
- **Ratings and durations** — `"0"`/`"0.0"`/`null` become `null` instead of "0 min",
  matching the Android adapter's normalisation.
- **Qualities** — `streamList` (and nested `resolutions[]`) are flattened to real
  `1080p/720p/480p/360p` labels, sorted high to low, and **de-duplicated by URL**, so one
  file can never appear under two quality names.
- **Subtitles** — `extCaptions`/`subtitles` from the playback response are merged with
  `get-ext-captions` for that exact `se`/`ep`, de-duplicated, English first. The frontend
  attaches them per episode and rejects late responses from a previous episode.
- **Audio languages** — `dubs[]` from the details response, each with its own provider
  `subjectId`. Selecting one re-resolves playback for that subject and keeps position,
  paused state, quality and subtitle choice. If the new language resolves to the same
  media URL the player does not reload at all.
- **OTT badges** — only from a real TMDB watch-provider match (optional `TMDB_API_KEY`).
  Without a key the platform filters legitimately return nothing and the UI says why.
- **Malayalam sections** — built only from items whose provider metadata names the
  language (`dubs`/`languages`). No guessing from titles; the section is omitted when the
  provider supplies no such metadata.
- **Errors** — `provider_unauthorized`, `provider_rate_limited`, `upstream_timeout`,
  `upstream_bad_json`, `empty_catalogue`, `no_stream`, `episodes_unavailable`, each mapped
  to one sentence on screen. One retry for reads, never for playback URLs.

## 3. Frontend changes

- **Demonstration content removed from production.** No Big Buck Bunny, Sintel, test
  series, fake thumbnails, demo badges or "demonstration catalogue" text on Home. The
  compatibility page still uses public test media, as required.
- **Real posters** — `js/lazy.js` loads provider artwork through `<img>`: ES5 viewport
  checks (no `IntersectionObserver` or `loading="lazy"` dependency), **max four requests in
  flight**, focused cards jump the queue, failed URLs fall back to the local placeholder
  once and are never retried, and every queued image is dropped on screen change.
  `object-fit: cover` crops odd aspect ratios instead of stretching them.
- **Home** — sections come from the provider, empty sections are dropped, a "More titles"
  row appears only when the provider reports another page.
- **Details** — real year, duration, rating, up to three languages, genres; series show
  season count and the selected season's episodes only.
- **Player** — unchanged architecture, plus the audio-language selector and a `safePlay()`
  guard so a pause that races a play cannot surface an AbortError.
- **Nav / Library / Settings / Live TV** unchanged.

## 4. What is verified, and what is not

**Automated tests** (`node --test backend/test/*.test.js`) — **33 / 33 pass**. They need no
network and no live credentials. `backend/test/contract.test.js` re-implements the Android
signing algorithm independently and compares it with the backend's header output for GET
and POST, asserts query sorting/decoding, checks the device header field by field, and
feeds the mappers raw payloads written in MovieBox's own field names (nested `resolutions`,
`dubs`, `seasonList`, `allEp` csv, `resolutionEpCounts`, protocol-relative artwork, `"0"`
ratings). A test also asserts the provider refuses to answer when the key is absent.

**Signing tests** (`backend/test/auth.test.js`, `backend/test/provider.integration.test.js`)
use the TEST credentials in `backend/test/fixtures/test-credentials.js` and a local mock
provider (`backend/test/support/mock-moviebox.js`) that re-derives the provider's canonical
string and HMAC-MD5 check. They cover key encodings, signature version, disabled signing
and fail-closed configuration, then drive the real adapter through Home, search, details,
seasons/episodes, thumbnails and movie/episode playback. The mock answers HTTP 441
`miss token` until a signed visitor-login token is supplied, so the guest-session wiring is
exercised too. Unsigned and wrongly signed requests must be rejected, the visitor token is
fetched once and cached, and no response may contain the signing key or token.

**Live provider check** — using the signing key from the Android repository, the real
`/api/home`, `/api/search`, `/api/details`, `/api/episodes` and `/api/playback` returned
live titles, artwork, metadata and full-length streams: a 2 h 56 min movie and 48–58 min
episodes, all through `/api/media/<id>`. The proxy answered `206 video/mp4` for Range
requests, and a browser decoded the 1920×1080 episode with no media error. The guest
token was sufficient; `MOVIEBOX_USER_TOKEN` remains optional for account-gated titles.

**Integration run** against the **fixture** provider (`CVTV_PROVIDER=fixture`), which pushes
the same raw MovieBox-shaped payloads through the real adapter code: **29 / 29 checks pass,
no JS errors.**

Covered: Home catalogue, sections (Latest / Trending / Malayalam), poster loading and
error fallback, image concurrency cap, search, movie details, description/metadata, movie
playback, 1080p default, genuine quality list, quality switch preserving position,
directional seek, subtitles attach, audio language list and switch (position preserved),
player teardown (source released, tracks removed, focus restored), resume record, series
seasons, season switching, episode search, episode playback, episode-scoped subtitles.

**Not verified — that is your live test:** whether the upstream responses match these
mappings for your account. Check in this order:

```bash
curl -s  http://localhost:8787/api/health                      # configured:true ?
curl -s  "http://localhost:8787/api/home" | head -c 600        # sections + cards
curl -s  "http://localhost:8787/api/search?q=<real title>"     # search
curl -s  "http://localhost:8787/api/details?id=<subjectId>"    # detail + dubs + seasons
curl -s  "http://localhost:8787/api/episodes?id=<seriesId>"    # season-info/v2
curl -s  "http://localhost:8787/api/playback?id=<subjectId>"   # streams + subtitles
```

If one of these disagrees, the server log names the endpoint and the HTTP status, and the
fix belongs in `backend/providers/moviebox.js` (`normalize.toCard` / `toSubject` /
`episodePool` / `flattenStreams` / `subtitleEntries`). No frontend change should be needed:
the API shape is fixed and the UI only consumes it.

**Not verified at all:** the physical VU television (codecs, HLS, remote key codes,
overscan, install via `hisense://debug`). Desktop results do not prove TV compatibility —
see §9.

## 5. Backend API

`/api/health`, `/api/meta`, `/api/home`, `/api/search`, `/api/details`, `/api/episodes`,
`/api/playback`, `/api/channels`, `/api/channel`.

All parameters validated and clamped; ids restricted to `[A-Za-z0-9_.:-]{1,64}`; per-IP
rate limit 90/min; 2-minute cache for catalogue reads, 15-second window for playback;
`{ error: { code, message, missing? } }` error contract.

## 6. Deployment

**Single origin (recommended).** `node backend/server.js` behind Caddy/nginx with TLS:

```bash
PORT=8787 HOST=127.0.0.1 CVTV_PUBLIC_ORIGIN=https://tv.example.com node backend/server.js
```

**Split.** Upload `index.html`, `css/`, `js/`, `assets/`, `media/`, `compatibility/` to
static hosting; host `backend/` separately; then set in `js/config.js`:
`window.CVTV_API_BASE = 'https://api.example.com'` and set `CVTV_ALLOWED_ORIGINS` on the
backend. `localhost` is never hardcoded as a production address.

**GitHub Pages (frontend only).** `https://itzsnsr.github.io/CVWebTV/` is built by
`.github/workflows/pages.yml`, which publishes the six static folders and nothing from
`backend/`. Pages cannot run Node, so the deployed page loads its shell and then reports
the content service as unreachable — that is expected, not a fault. To give it a working
catalogue, deploy `backend/` somewhere that runs Node and open the site with the origin:

```
https://itzsnsr.github.io/CVWebTV/?api=https://your-backend.example.com
```

`js/config.js` reads that `api` parameter (it only ever sets a base URL), the backend
needs `CVTV_ALLOWED_ORIGINS=https://itzsnsr.github.io` and `CVTV_PUBLIC_ORIGIN` set to
its own public origin so media links are absolute. Bookmarks without the parameter fall
back to same-origin, so they will show the offline message by design.

Full variable list: `backend/.env.example` — `MOVIEBOX_BASE_URL` (defaults to the APK
server's host), `MOVIEBOX_APP_KEY` (**required**), `MOVIEBOX_APP_KEY_ENCODING`
(`auto`/`base64`/`utf8`), `MOVIEBOX_SIGNING_SCHEME` (`hmac-md5`), `MOVIEBOX_SIGNATURE_VERSION`,
`MOVIEBOX_SIGNING_ENABLED`, `MOVIEBOX_GUEST_LOGIN`, `MOVIEBOX_AUTH_BASE_URL`,
`MOVIEBOX_AUTH_HOST`, `MOVIEBOX_USER_TOKEN`, `MOVIEBOX_SESSION`, `MOVIEBOX_REGION`, `MOVIEBOX_HOST`,
`MOVIEBOX_DEVICE_ID`, `MOVIEBOX_GAID`, `MOVIEBOX_SP_CODE`, `MOVIEBOX_CAT_MOVIES`,
`MOVIEBOX_CAT_SERIES`, `TMDB_API_KEY`, `TMDB_REGION`, `PORT`, `HOST`, `CVTV_PUBLIC_ORIGIN`,
`CVTV_ALLOWED_ORIGINS`. Copy it to `backend/.env` and fill in the key; the file is
git-ignored and is never served.

## 7. Install on the VU television

1. Open the TV browser, load the HTTPS URL once.
2. `hisense://debug` (some builds need the trailing slash).
3. Application name `CineVault`, then the HTTPS URL.
4. Register / install.
5. Launch from the TV's application list.

Updates are ordinary deployments: CSS/JS/HTML are served `no-cache` with ETags, artwork
caches for an hour.

## 8. Remote keys and local data

Unchanged from the previous build — see `js/navigation.js` (`CV.keys`) for the code table,
`?diag=1` for the on-screen key logger. Local storage: 6 resume slots, 20 watchlist items,
40 channel favourites, 4 preferences. No stream URLs, cookies or tokens are stored;
resuming always resolves a fresh playback session.

## 9. Still needs the physical television

Native HLS, AAC/AC3 audio, 1080p smoothness, real remote key codes, the on-screen keyboard,
WebVTT rendering and Malayalam glyphs, overscan, `hisense://debug` install, sleep/wake,
memory after an hour. Run `/compatibility/` on the set and keep the results.

## 10. Payload

| Part | Raw | gzip |
|---|---|---|
| `css/app.css` | 14.5 KB | 3.1 KB |
| `js/*.js` (14 files) | 118.3 KB | 27.9 KB |
| **frontend CSS + JS** | **132.8 KB** | **32.0 KB** |

## 11. Structure

```
index.html                 single page shell
css/app.css                all styling (no animation, no transition, no filter)
js/config.js               API origin (the only frontend setting)
js/lazy.js                 ES5 poster loader: 4 concurrent, focus first, no retries
js/util.js  storage.js  api.js  ui.js  navigation.js
js/home.js  search.js  details.js  subtitles.js  player.js  live-tv.js  library.js  app.js
assets/                    logo, TV icon, placeholder, channel marks
assets/test/               1200x630 artwork used by the aspect-ratio test card
media/subs/                demonstration VTT/SRT used by the compatibility page
compatibility/             20-test device page (public test media only)
backend/server.js          static host + API, zero dependencies
backend/config/config.js   ports, cache, rate limit, provider selection
backend/auth/movieboxSigner.js  HMAC-MD5 request signing (crypto only, server-side)
backend/auth/movieboxSession.js visitor-token login and in-memory session cache
backend/mediaProxy.js          same-origin media proxy (neutral headers + Range)
backend/providers/moviebox.js   the real adapter (catalogue, playback, captions, UGC)
backend/providers/fixture.js    deterministic test double (CVTV_PROVIDER=fixture only)
backend/providers/index.js      provider selection
backend/routes/api.js      validation, caching, error contract
backend/config/loadEnv.js  reads backend/.env at startup
backend/test/contract.test.js   signing + mapping contract tests (no credentials)
backend/test/auth.test.js       signer configuration and encoding tests
backend/test/provider.integration.test.js  real adapter against the signed mock
backend/test/support/mock-moviebox.js      local provider that verifies signatures
backend/test/fixtures/          TEST credentials and provider-shaped responses
backend/data/channels.json authorised Live TV streams (broadcaster-published)
backend/.env.example       configuration template, no credentials
docs/PHASE1-REUSE.md       what was reused from the Android app and what changed
```

## 12. Content and licensing

The application code is original. Live TV entries in `backend/data/channels.json` are
broadcaster-published free streams or official vendor test streams. The compatibility page
uses public test media (Blender open movies, Mux/Unified Streaming/W3C/test-videos test
assets). No catalogue data, credentials or DRM keys from MovieBox are included in this
repository: the adapter requires the operator's own authorised access.
