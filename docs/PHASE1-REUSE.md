# Phase 1 — Repository inspection, reusable components, browser limits

Inspected: `C:\Users\Sabari Nadh S R\Desktop\CineVault-Classic` (CineVault 4.8,
`app.cinevault.classic`, Kotlin / Jetpack Compose). Nothing in that project was
modified, built or published.

## 1. Files read and what was taken from each

| File | Size | What is reusable in the TV edition |
|---|---|---|
| `data/model/MovieModels.kt` | 543 lines | Subject / season / episode / `PlayInfo` shapes; the field-alias rules in `MovieSubjectAdapter` (id from `subjectId`\|`id`, name from 12 fallbacks, poster from `poster`\|`cover`\|`horizontalPoster`, rating normalization that drops `0`/`"0.0"`/`null`, year = first 4 chars of `releaseDate`, `isTvShow` = `subjectType == 2` or presence of `episodeCount`/`seasonCount`, `seasonList[].episodeList[]`, `resourceDetectors`) |
| `data/network/MovieBoxApi.kt` | 688 lines | Endpoint *shapes* only (search / detail / play-info / trending / ranking), the response->model rewrites (`flattenCategoryJson`, `rewriteTrendingJson`, `rewriteStreamJson`, `rewriteDetailJson`), and the quality granularity rule (`1080p / 720p / 480p / 360p`) |
| `data/repository/MovieRepository.kt` | 1028 lines | Section concept (`CategorySection(title, type, items)`), section ordering, trending/ranking composition, search paging |
| `data/model/LiveTvModels.kt` | 82 lines | `UnifiedChannel(id, name, logo, category, streamUrl, favoriteId)` and `CountryItem(name, code, flag)` — clean, portable |
| `ui/screens/LiveTvScreen.kt` | 2388 lines | Country selector, category normalization (`sports -> Sports`, blank -> `Indian TV`), Favourites pseudo-category, local name filtering, "All" grouping by category, single-channel-at-a-time guard |
| `ui/viewmodel/PlayerViewModel.kt` | 65 lines | Resume record fields (`subjectId, name, poster, isTvShow, season, episode, seeTime, totalTime`), progress save on pause/exit |
| `ui/viewmodel/MovieViewModel.kt` | — | Quality-preference and subtitle-preference plumbing |
| `data/preferences/PreferencesManager.kt` | 143 lines | Preference keys and defaults (quality `1080p`, subtitle language `English`) |

## 2. Sanitized web models (adopted)

```
Subject  { id, name, poster, year, rating, duration, language, description,
           isTvShow, genres[], ott, seasons[] }
Season   { season, episodes[] }
Episode  { episode, title, duration }
PlayInfo { streams:[{quality, url, size}], subtitles:[{language, url, format}] }
Channel  { id, name, logo, category, country, url, hls }
```

Differences from Android, deliberate:

- `cookie` from `StreamItem` is **removed** from the wire format. If a provider
  ever needs a cookie to fetch media, the backend resolves it into a signed
  short-lived media URL instead. No credentials reach the TV.
- `cast`, `dubs`, `blurHash`, `averageHue`, `backdrop`, `resourceDetectors`,
  `resolutionEpCounts`, watchlist OTP/auth models, download models: dropped.
  Not displayed on a TV and they cost JSON bytes.
- Season resolution counts are dropped; the player asks for real streams and
  only lists qualities that come back.

## 3. What is NOT carried over, and why

- **MovieBox network integration.** `MovieBoxSignatureInterceptor` signs every
  request with HMAC-MD5 over an application key and a device-identity JSON
  blob. That key is a third-party application secret. Putting it in a browser
  JS file publishes it; putting it in a public repo leaks it. It is therefore
  **not** in the frontend and **not** committed. The backend now ships the full
  `moviebox` adapter plus a separate `backend/auth/movieboxSigner.js` module;
  credentials come from `backend/.env` (or real environment variables), are
  never returned by the API, and the adapter answers
  `provider_not_configured` while they are missing.
- Live TV sources used by Android (JioTV-style workers, SonyLIV style
  `*_keyId`/`_key` ClearKey sessions, Fancode). These carry DRM keys and
  redistribution terms that do not extend to a public web page. Only
  self-published public test channels are wired up, behind a config file.
- Everything in the "explicitly removed" list: downloads, offline, ExoPlayer,
  Compose, Liquid Glass, cast, PiP, watchdog services, APK updater.

## 4. Browser limitations versus Android capabilities

Recorded before writing any code, because the architecture depends on them.

| Android capability | Browser on a 2016–2018 Hisense/VU Linux TV | Consequence for 1.0 |
|---|---|---|
| Custom HTTP headers + cookies per request (`okhttp` interceptor) | `video.currentSrc` requests cannot carry headers; `xhr` can, but not for media | Any media needing auth headers must be resolved to a token-in-URL by the backend |
| MKV / HEVC / AC3 / EAC3 / DTS playback via ExoPlayer + software fallbacks | Decoder list is fixed by the TV firmware. Typically H.264 High + AAC; AC3 only on licensed sets; DTS almost never; HEVC on the SoC but not exposed to `<video>` | Prefer H.264/AAC MP4. Advertise nothing that the compat page did not verify on the actual TV |
| HLS through Media3 | `canPlayType('application/vnd.apple.mpegurl')` returns `""` on Chromium-family TV browsers without native HLS | Detect once, show "HLS unsupported on this TV", keep the Reload action. No library added in 1.0 |
| Subtitle rendering via ExoPlayer `SubtitleView` | `<track>` + WebVTT is the only native path; `TextTrack` API is patchy on older engines | Native `<track>` first, minimal text overlay fallback, SRT->VTT conversion on the backend |
| Audio-track selection via ExoPlayer `TrackSelectionParameters` | No API at all in the HTML5 media stack | Audio selector is hidden unless the browser proves `audioTracks` support |
| Byte-range seeks via downloaded HLS/DASH | `<video>` seek needs `Accept-Ranges: bytes`; TV browsers also need the server to answer `Range` with `206` | Backend serves its own subtitle/segment files with range support |
| Frame-exact 8x fast-forward | `playbackRate` up to 16 is legal but the decoder may drop to audio-only or stall | Try 8x muted; if the `ratechange` did not take effect, fall back to +30 s repeated seeks |
| Custom player overlay / hardware key capture | `keydown` on `document` gets arrows/OK/Back/media keys on most Hisense builds, but not always | Central key handler + a diagnostics page that prints raw `keyCode`/`key` so the real map can be recorded |
| Background/resume behaviour | Unloading the page kills playback; a sleeping TV panel does not | Save position every 15 s while playing, and on pause/exit/`visibilitychange` |

## 5. Performance budget adopted

- One `<video>` element, created once, reused, `preload="none"`, no `<source>`
  children, `src` set and cleared explicitly.
- Sidebar + one content region. Screens are rebuilt on navigation from small
  templates, old nodes removed.
- 12 cards per row, 20 items per API page, four concurrent poster requests
  (queue), `loading="lazy"` where available plus an IntersectionObserver-free
  "load next page" button as fallback.
- No CSS animation/transition/rAF loop anywhere; no `setInterval` except the
  single 15 s resume-save timer that exists only while playing.
- Target: `css + js` under 100 KB uncompressed.
