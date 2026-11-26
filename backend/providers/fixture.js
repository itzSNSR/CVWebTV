'use strict';

/**
 * Fixture provider — TEST DOUBLE ONLY.
 *
 * It is never selected unless CVTV_PROVIDER=fixture is set explicitly, and it
 * is not part of the production catalogue. Its purpose is to exercise the real
 * MovieBox adapter code paths (poster normalisation, card/detail mapping,
 * episode pooling, stream flattening, caption merging) and the whole frontend
 * with deterministic data, because live MovieBox access requires credentials
 * this project does not ship.
 *
 * The JSON below is deliberately written in MovieBox's own raw field names
 * (subjectId, poster{url,webpUrl,thumbUrl}, subjectType, seasonList,
 * resolutionEpCounts, streamList[].resolutions, extCaptions[]) and is parsed by
 * backend/providers/moviebox.js — so a parser bug shows up here too.
 */

var moviebox = require('./moviebox');
var config = require('../config/config');

var n = moviebox.normalize;

var MP4 = {
  bbb1080: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
  bbb720: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
  bbb360: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  sintel: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
  bunny: 'https://media.w3.org/2010/05/bunny/movie.mp4'
};

var SUBJECTS = [
  {
    subjectId: 'demo-bbb',
    title: 'Big Buck Bunny',
    // '//' prefix proves protocol-relative normalisation, thumbUrl the small variant.
    poster: { url: '//localhost:8787/assets/posters/bbb.svg', thumbUrl: 'assets/posters/bbb.svg' },
    description: 'Public test media used to exercise quality switching, subtitles and playback.',
    imdbRatingValue: '8.0',
    releaseDate: '2008-05-10',
    subjectType: 1,
    duration: '10 min',
    dubs: [{ lanName: 'English', subjectId: 'demo-bbb' }, { lanName: 'Malayalam', subjectId: 'demo-bbb-ml' }],
    genres: ['Animation', 'Comedy'],
    streams: [
      { url: MP4.bbb720, resolution: 720 },
      { url: MP4.bbb1080, resolution: 1080 },
      { url: MP4.bbb360, resolution: 360 },
      { url: MP4.bbb720, resolution: 720 }   // duplicate URL: must be collapsed
    ],
    captions: [
      { lan: 'en', lanName: 'English', url: '/media/subs/demo-english.vtt' },
      { lan: 'ml', lanName: 'Malayalam', url: '/media/subs/demo-malayalam.srt' }
    ]
  },
  {
    subjectId: 'demo-sintel',
    title: 'Sintel (Trailer)',
    poster: { thumbUrl: 'assets/posters/sintel.svg' },
    description: 'Single-quality source: the player must fall back below the 1080p preference.',
    imdbRatingValue: '7.6',
    releaseDate: '2010-09-27',
    subjectType: 1,
    dubs: [{ lanName: 'English', subjectId: 'demo-sintel' }],
    genres: ['Animation'],
    streams: [{ url: MP4.sintel, resolution: 480 }],
    captions: [{ lan: 'en', lanName: 'English', url: '/media/subs/demo-english.vtt' }]
  },
  {
    subjectId: 'demo-bunny',
    title: 'Bunny (Short)',
    poster: { thumbUrl: 'assets/posters/bunny.svg' },
    description: 'Sixty second source used for resume, audio-language and Continue Watching tests.',
    imdbRatingValue: '6.9',
    releaseDate: '2008-01-01',
    subjectType: 1,
    dubs: [{ lanName: 'English', subjectId: 'demo-bunny' }, { lanName: 'Malayalam', subjectId: 'demo-bunny-ml' }],
    genres: ['Animation'],
    streams: [{ url: MP4.bunny, resolution: 480 }],
    captions: []
  },
  {
    subjectId: 'demo-broken',
    title: 'Broken Poster (test)',
    poster: { thumbUrl: 'assets/posters/does-not-exist.svg' },
    description: 'Proves the poster error path: the card falls back to the local placeholder once.',
    releaseDate: '2021-01-01',
    subjectType: 1,
    streams: [{ url: MP4.bunny, resolution: 480 }],
    captions: []
  },
  {
    subjectId: 'demo-ml-movie',
    title: 'Malayalam Test Movie',
    poster: { thumbUrl: 'assets/posters/series.svg' },
    description: 'Carries a Malayalam language tag so the language section can be tested.',
    releaseDate: '2019-03-02',
    subjectType: 1,
    dubs: [{ lanName: 'Malayalam', subjectId: 'demo-ml-movie' }, { lanName: 'English', subjectId: 'demo-ml-movie-en' }],
    streams: [{ url: MP4.bunny, resolution: 480 }],
    captions: [{ lan: 'ml', lanName: 'Malayalam', url: '/media/subs/demo-malayalam.srt' }]
  },
  {
    subjectId: 'demo-wide',
    title: 'Wide Poster (aspect test)',
    // 1200x630 artwork in a 2:3 card: proves cropping instead of stretching.
    poster: { thumbUrl: 'assets/test/wide-poster.png' },
    description: 'Deliberately non-2:3 artwork to verify the card crops instead of distorting.',
    releaseDate: '2022-01-01',
    subjectType: 1,
    streams: [{ url: MP4.bunny, resolution: 480 }],
    captions: []
  },
  {
    subjectId: 'demo-series',
    title: 'Open Movie Series (Test)',
    poster: { thumbUrl: 'assets/posters/series.svg' },
    description: 'Two seasons: season 1 reports explicit episode numbers, season 2 only per-resolution counts.',
    imdbRatingValue: '7.2',
    releaseDate: '2020-06-01',
    subjectType: 2,
    seasonCount: 2,
    dubs: [{ lanName: 'English', subjectId: 'demo-series' }],
    genres: ['Documentary'],
    seasons: [
      { se: 1, allEp: '1,2,3', resolutions: [{ resolution: 1080, epNum: 3 }] },
      { se: 2, resolutions: [{ resolution: 720, epNum: 2 }], resolutionEpCounts: { '720': 2 } }
    ],
    episodeStreams: {
      '1-1': [{ url: MP4.bbb1080, resolution: 1080 }, { url: MP4.bbb720, resolution: 720 }],
      '1-2': [{ url: MP4.sintel, resolution: 480 }],
      '1-3': [{ url: MP4.bunny, resolution: 480 }],
      '2-1': [{ url: MP4.bbb720, resolution: 720 }],
      '2-2': [{ url: MP4.sintel, resolution: 480 }]
    },
    episodeCaptions: {
      '1-1': [{ lan: 'en', lanName: 'English', url: '/media/subs/demo-english.vtt' }],
      '1-2': [{ lan: 'en', lanName: 'English', url: '/media/subs/demo-english.vtt' },
              { lan: 'ml', lanName: 'Malayalam', url: '/media/subs/demo-malayalam.srt' }],
      '1-3': [],
      '2-1': [],
      '2-2': [{ lan: 'en', lanName: 'English', url: '/media/subs/demo-english.vtt' }]
    }
  }
];

function find(id) {
  for (var i = 0; i < SUBJECTS.length; i++) {
    if (SUBJECTS[i].subjectId === id) return SUBJECTS[i];
  }
  return null;
}

function cardOf(raw) {
  var card = n.toCard(raw);
  if (!card) return null;
  // Platform badges only where the fixture explicitly says so.
  card.ott = raw.platform || null;
  return card;
}

function cards(list) {
  return list.map(cardOf).filter(Boolean);
}

function matchesType(raw, type) {
  if (!type || type === 'all') return true;
  var card = n.toCard(raw);
  if (!card) return false;
  return type === 'movies' ? !card.isTvShow : card.isTvShow;
}

function pageOf(list, params) {
  var page = params.page || 1;
  var size = params.pageSize || config.pageSize;
  var start = (page - 1) * size;
  return list.slice(start, start + size);
}

function home(params) {
  var pool = SUBJECTS.filter(function (s) { return matchesType(s, params.type); });
  var trending = pool.filter(function (s) { return s.subjectId !== 'demo-ml-movie'; });
  var latest = pool.slice(0);
  var malayalam = pool.filter(function (s) {
    return (s.dubs || []).some(function (d) { return /malayalam/i.test(d.lanName); });
  });

  var sections = [
    { id: 'latest', title: 'Latest Releases', items: cards(pageOf(latest, params)) },
    { id: 'trending', title: 'Trending Movies & Series', items: cards(pageOf(trending, params)) },
    { id: 'malayalam', title: 'Malayalam Movies & Series', items: cards(malayalam) }
  ].filter(function (s) { return s.items.length; });

  if (params.ott) {
    var ott = params.ott;
    sections.forEach(function (s) {
      s.items = s.items.filter(function (c) { return c.ott === ott; });
    });
    sections = sections.filter(function (s) { return s.items.length; });
  }

  return {
    sections: sections,
    page: params.page || 1,
    hasMore: (params.page || 1) * (params.pageSize || config.pageSize) < latest.length,
    provider: 'fixture',
    fixture: true
  };
}

function search(params) {
  var q = (params.q || '').trim().toLowerCase();
  var hits = SUBJECTS.filter(function (s) {
    if (!q) return false;
    return (String(s.title) + ' ' + (s.genres || []).join(' ')).toLowerCase().indexOf(q) >= 0;
  });
  return {
    items: cards(hits),
    page: params.page || 1,
    hasMore: false,
    total: hits.length,
    provider: 'fixture',
    fixture: true
  };
}

function details(id) {
  var raw = find(id);
  if (!raw) return null;
  var subject = n.toSubject(raw);
  subject.ott = raw.platform || null;
  subject.demo = true;
  return subject;
}

function seasons(id) {
  var raw = find(id);
  if (!raw) return null;
  return (raw.seasons || []).map(function (s) {
    return { season: s.se, episodes: n.episodePool(s) };
  });
}

function episodes(id, seasonWanted) {
  var raw = find(id);
  if (!raw) return null;
  var list = seasons(id);
  if (!list.length) return null;
  var summary = list.map(function (s) { return { season: s.season, episodeCount: s.episodes.length }; });
  var chosen = seasonWanted ? list.filter(function (s) { return s.season === seasonWanted; }) : [list[0]];
  if (!chosen.length) return null;
  return {
    id: id,
    name: String(raw.title),
    seasons: summary,
    season: chosen[0].season,
    episodes: chosen[0].episodes,
    fixture: true
  };
}

function playback(params) {
  var raw = find(params.id);
  if (!raw) return null;

  var streamsRaw = raw.streams || [];
  var captions = raw.captions || [];
  var season = params.season || 1;
  var episode = params.episode || 1;

  if (raw.subjectType === 2) {
    var key = season + '-' + episode;
    streamsRaw = (raw.episodeStreams || {})[key] || [];
    captions = (raw.episodeCaptions || {})[key] || [];
  }

  var streams = streamsRaw.map(function (s) {
    return { quality: '', url: s.url, resolutions: [{ resolution: s.resolution, url: s.url }] };
  });
  var flat = n.flattenStreams(streams);
  if (!flat.length) return null;

  return {
    id: params.id,
    name: String(raw.title),
    isTvShow: raw.subjectType === 2,
    season: raw.subjectType === 2 ? season : 0,
    episode: raw.subjectType === 2 ? episode : 0,
    live: false,
    provider: 'fixture',
    fixture: true,
    streams: flat,
    subtitles: captions.map(function (c) {
      return {
        language: c.lanName,
        lang: c.lan,
        url: c.url,
        format: /\.vtt$/i.test(c.url) ? 'vtt' : 'srt'
      };
    }),
    audioLanguages: (raw.dubs || []).map(function (d) {
      return { language: d.lanName, subjectId: d.subjectId, original: false };
    }),
    audioSubjectId: params.id
  };
}

module.exports = {
  meta: function () {
    return {
      provider: 'fixture',
      demo: true,
      configured: true,
      missing: [],
      ottFilters: config.ottFilters,
      ottEnabled: true,
      note: 'Fixture provider: deterministic test data, not a live catalogue.'
    };
  },
  home: home,
  search: search,
  details: details,
  episodes: episodes,
  playback: playback,
  channels: moviebox.channels,
  channelStream: moviebox.channelStream
};
