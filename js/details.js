/* CineVault TV — details.js
   One season is rendered at a time; switching seasons drops the previous
   episode list from the DOM. Nothing starts playing on its own. */

var CV = window.CV || {};
window.CV = CV;

CV.details = (function () {

  var u = CV.util;
  var current = null;      /* subject */
  var currentSeason = 1;
  var lastFocus = null;
  var episodesToken = 0;

  function mount(id, focusTarget) {
    lastFocus = focusTarget || null;
    var body = u.clear(u.byId('details-body'));
    body.appendChild(CV.ui.loading());

    CV.api.get('/api/details', { id: id }, function (err, data) {
      if (err) {
        u.clear(body).appendChild(CV.ui.notice(err.message || 'Unable to load this title.', {
          error: true,
          actions: [
            CV.ui.button('Retry', { primary: true, onActivate: function () { mount(id); } }),
            CV.ui.button('Back', { onActivate: function () { CV.router.back(); } })
          ]
        }));
        CV.focus.refresh();
        return;
      }
      current = data;
      currentSeason = 1;
      render();
    });
  }

  function resumeRecord() {
    if (!current) return null;
    if (current.isTvShow) {
      return CV.resume.get(current.id, currentSeason, 0) || CV.resume.get(current.id);
    }
    return CV.resume.get(current.id);
  }

  function render() {
    var body = u.clear(u.byId('details-body'));
    var subject = current;
    var record = resumeRecord();

    var top = u.el('div', 'detail-top');
    top.appendChild(CV.ui.posterImg(subject, 'detail-poster'));

    var info = u.el('div', 'detail-body');
    info.appendChild(u.el('div', 'detail-title', subject.name));

    var bits = [];
    if (subject.year) bits.push(subject.year);
    if (subject.duration) bits.push(subject.duration);
    if (subject.rating) bits.push('Rating ' + subject.rating);
    var langs = subject.languages && subject.languages.length
      ? subject.languages
      : (subject.language ? [subject.language] : []);
    if (langs.length) bits.push(langs.slice(0, 3).join(' / '));
    if (subject.genres && subject.genres.length) bits.push(subject.genres.slice(0, 3).join(', '));
    if (subject.isTvShow && subject.seasons && subject.seasons.length) {
      bits.push(subject.seasons.length + (subject.seasons.length === 1 ? ' season' : ' seasons'));
    }
    info.appendChild(u.el('div', 'detail-sub', bits.join('  \u00B7  ')));

    if (subject.description) {
      info.appendChild(u.el('div', 'detail-desc', subject.description));
    }

    var actions = u.el('div', 'detail-actions');

    var playLabel = subject.isTvShow ? 'Play S' + currentSeason + 'E1' : 'Play';
    actions.appendChild(CV.ui.button(playLabel, {
      primary: true,
      onActivate: function () {
        playEpisode(subject.isTvShow ? { season: currentSeason, episode: 1 } : null, 0);
      }
    }));

    if (record && record.time > 0) {
      actions.appendChild(resumeButton(record));
    }

    var inList = CV.watchlist.has(subject.id);
    var watchBtn = CV.ui.button(inList ? 'Remove from Watchlist' : 'Add to Watchlist', {
      onActivate: function () {
        var added = CV.watchlist.toggle(subject);
        watchBtn.firstChild.nodeValue = added ? 'Remove from Watchlist' : 'Add to Watchlist';
        CV.router.touchLibrary();
      }
    });
    actions.appendChild(watchBtn);

    actions.appendChild(CV.ui.button('Back', {
      onActivate: function () { CV.router.back(); }
    }));

    info.appendChild(actions);

    if (subject.isTvShow) {
      info.appendChild(seasonBar());
      info.appendChild(episodeSearchBar());
    }

    top.appendChild(info);
    body.appendChild(top);

    if (subject.isTvShow) {
      var listHost = u.el('div', 'ep-list');
      listHost.id = 'episode-list';
      body.appendChild(listHost);
      loadEpisodes(currentSeason);
    } else {
      CV.focus.refresh(lastFocus);
      lastFocus = null;
    }
  }

  function resumeButton(record) {
    var btn = CV.ui.button('Resume ' + timeLabel(record.time), {
      onActivate: function () {
        playEpisode(
          current.isTvShow ? { season: record.season || 1, episode: record.episode || 1 } : null,
          record.time
        );
      }
    });
    btn.id = 'btn-resume';
    return btn;
  }

  /**
   * After the player closes, the stored position changes. The details screen
   * is updated in place so returning from playback does not jump to the top
   * or refetch anything.
   */
  function afterPlayback() {
    if (!current) return;
    var record = resumeRecord();
    var existing = u.byId('btn-resume');
    var actions = document.querySelector('#view-details .detail-actions');
    if (!actions) return;

    if (record && record.time > 0) {
      if (existing) {
        existing.innerHTML = '';
        existing.appendChild(document.createTextNode('Resume ' + timeLabel(record.time)));
      } else {
        var fresh = resumeButton(record);
        actions.insertBefore(fresh, actions.childNodes[1] || null);
      }
    } else if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function timeLabel(seconds) {
    var s = Math.floor(seconds || 0);
    var m = Math.floor(s / 60);
    return (m > 0 ? m + ' min' : s + ' s');
  }

  function seasonBar() {
    var bar = u.el('div', 'season-bar');
    var seasons = current.seasons || [];
    if (!seasons.length) {
      bar.appendChild(u.el('span', 'screen-note', 'No seasons listed.'));
      return bar;
    }
    for (var i = 0; i < seasons.length; i++) {
      bar.appendChild(CV.ui.chip('Season ' + seasons[i].season, {
        on: seasons[i].season === currentSeason,
        id: 's' + seasons[i].season,
        onActivate: pickSeason(seasons[i].season)
      }));
    }
    return bar;
  }

  function pickSeason(season) {
    return function () {
      if (season === currentSeason) return;
      currentSeason = season;
      render();
      CV.focus.refresh();
    };
  }

  function episodeSearchBar() {
    var bar = u.el('div', 'season-bar');
    var input = u.el('input', 'text-input');
    input.id = 'episode-search';
    input.type = 'text';
    input.setAttribute('placeholder', 'Find episode number or name');
    input.setAttribute('data-enter', '1');
    u.on(input, 'click', function () { input.focus(); });
    u.on(input, 'keydown', function (e) {
      var code = CV.keys.normalize(e);
      if (code === 'back') {
        input.blur();
        CV.focus.focus(input);
        u.stop(e);
      }
    });
    var onText = function () { filterEpisodes(u.trim(input.value)); };
    u.on(input, 'keyup', onText);
    u.on(input, 'input', onText);
    bar.appendChild(input);
    return bar;
  }

  function loadEpisodes(season) {
    var host = u.byId('episode-list');
    if (!host) return;
    episodesToken++;
    var token = episodesToken;
    u.clear(host).appendChild(CV.ui.loading());

    CV.api.get('/api/episodes', { id: current.id, season: season }, function (err, data) {
      if (token !== episodesToken) return;   /* a newer season already started */
      if (err) {
        u.clear(host).appendChild(CV.ui.notice('Unable to load episodes.', {
          error: true,
          actions: [CV.ui.button('Retry', { primary: true, onActivate: function () { loadEpisodes(season); } })]
        }));
        CV.focus.refresh();
        return;
      }
      renderEpisodes(data.episodes || []);
      CV.focus.refresh(lastFocus);
      lastFocus = null;
    });
  }

  function renderEpisodes(list) {
    var host = u.clear(u.byId('episode-list'));
    if (!list.length) {
      host.appendChild(u.el('div', 'notice', 'No episodes listed for this season.'));
      return;
    }
    host.appendChild(CV.ui.sectionTitle('Episodes', list.length));
    for (var i = 0; i < list.length; i++) {
      host.appendChild(episodeRow(list[i]));
    }
  }

  function episodeRow(ep) {
    var row = u.el('div', 'ep-row');
    row.setAttribute('data-enter', '1');
    row.setAttribute('data-ep', String(ep.episode));
    row.setAttribute('data-title', (ep.title || '').toLowerCase());

    row.appendChild(u.el('span', 'ep-num', 'E' + ep.episode));
    row.appendChild(u.el('span', 'ep-title', ep.title || ('Episode ' + ep.episode)));

    var record = CV.resume.get(current.id, currentSeason, ep.episode);
    if (record && record.time > 0) {
      row.appendChild(u.el('span', 'ep-live', 'Resume ' + timeLabel(record.time)));
    } else if (ep.duration) {
      row.appendChild(u.el('span', 'ep-dur', ep.duration));
    }

    u.on(row, 'click', function () {
      lastFocus = row;
      var rec = CV.resume.get(current.id, currentSeason, ep.episode);
      playEpisode({ season: currentSeason, episode: ep.episode }, rec && rec.time > 0 ? rec.time : 0);
    });
    return row;
  }

  function filterEpisodes(text) {
    var host = u.byId('episode-list');
    if (!host) return;
    var rows = host.getElementsByTagName('div');
    var q = text.toLowerCase();
    for (var i = 0; i < rows.length; i++) {
      if (!u.hasClass(rows[i], 'ep-row')) continue;
      var num = rows[i].getAttribute('data-ep');
      var title = rows[i].getAttribute('data-title') || '';
      var match = !q || num.indexOf(q) >= 0 || title.indexOf(q) >= 0;
      rows[i].style.display = match ? '' : 'none';
    }
    CV.focus.refresh();
  }

  /** Resolves playback info, then hands it to the player. Never autoplays. */
  function playEpisode(which, startAt) {
    if (!current) return;
    var focused = CV.focus.current();
    if (focused && insideDetails(focused)) {
      lastFocus = focused;
    } else if (!lastFocus) {
      lastFocus = defaultAction();
    }

    var season = which ? which.season : 0;
    var episode = which ? which.episode : 0;
    var params = { id: current.id };
    if (season) params.season = season;
    if (episode) params.episode = episode;

    CV.player.loadAndOpen({
      subject: current,
      season: season,
      episode: episode,
      startAt: startAt || 0,
      params: params,
      next: nextAfter(season, episode),
      onExit: function () {
        CV.router.refocusDetails();
      }
    });
  }

  function defaultAction() {
    var actions = document.querySelector('#view-details .detail-actions');
    return actions && actions.firstChild ? actions.firstChild : null;
  }

  function insideDetails(node) {
    var box = node;
    while (box && box.nodeType === 1) {
      if (box.id === 'view-details') return true;
      box = box.parentNode;
    }
    return false;
  }

  /** The next episode in the rendered season list, or the next season's E1. */
  function nextAfter(season, episode) {
    if (!current || !current.isTvShow) return null;
    var host = u.byId('episode-list');
    var numbers = [];
    if (host) {
      var rows = host.getElementsByTagName('div');
      for (var i = 0; i < rows.length; i++) {
        if (u.hasClass(rows[i], 'ep-row')) numbers.push(Number(rows[i].getAttribute('data-ep')));
      }
    }
    for (var j = 0; j < numbers.length; j++) {
      if (numbers[j] === episode + 1) {
        return { season: season, episode: episode + 1, title: 'Episode ' + (episode + 1) };
      }
    }
    var seasons = current.seasons || [];
    for (var k = 0; k < seasons.length; k++) {
      if (seasons[k].season === season + 1) {
        return { season: season + 1, episode: 1, title: 'Season ' + (season + 1) + ' Episode 1' };
      }
    }
    return null;
  }

  /** Used by the player's manual "Play next episode" button. */
  function playNext(target) {
    if (!current || !target) return;
    currentSeason = target.season;
    render();
    playEpisode({ season: target.season, episode: target.episode }, 0);
  }

  function currentSubject() {
    return current;
  }

  function focusTarget() {
    return lastFocus;
  }

  return {
    mount: mount,
    playNext: playNext,
    afterPlayback: afterPlayback,
    currentSubject: currentSubject,
    focusTarget: focusTarget,
    setFocusTarget: function (n) { lastFocus = n; }
  };
})();
