/* CineVault TV — player.js
   One native <video>, native buffering, no player library. Controls are
   static text and solid fills; nothing fades, nothing animates. */

var CV = window.CV || {};
window.CV = CV;

CV.player = (function () {

  var u = CV.util;
  var dom = {};
  var state = null;
  var hideTimer = null;
  var hideDeadline = 0;
  var controlsWatchdog = null;
  var optionCooldownUntil = 0;
  var progressTimer = null;
  var lastSeekAt = 0;
  var lastTimePaint = 0;
  var switchToken = 0;

  var HIDE_AFTER = 5000;
  var PREFS_QUALITY_ORDER = ['2160', '1080', '720', '480', '360'];

  /* ------------------------------------------------------------------ setup */

  function init() {
    if (dom.video) return;
    dom.player = u.byId('player');
    dom.video = u.byId('video');
    dom.layer = u.byId('player-layer');
    dom.title = u.byId('player-title');
    dom.opts = u.byId('player-opts');
    dom.seekWrap = u.byId('seek-wrap');
    dom.seekFill = u.byId('seek-fill');
    dom.seekKnob = u.byId('seek-knob');
    dom.current = u.byId('time-current');
    dom.total = u.byId('time-total');
    dom.msg = u.byId('player-msg');
    dom.center = u.byId('player-center');

    u.on(dom.video, 'loadedmetadata', onMetadata);
    u.on(dom.video, 'timeupdate', onTimeUpdate);
    u.on(dom.video, 'play', onPlay);
    u.on(dom.video, 'pause', onPause);
    u.on(dom.video, 'ended', onEnded);
    u.on(dom.video, 'error', onError);
    u.on(dom.video, 'waiting', function () { centreText('Buffering...'); });
    u.on(dom.video, 'playing', function () { quiet(); });

    u.on(dom.seekWrap, 'click', function () { toggle(); });
    dom.seekWrap.setAttribute('data-enter', '1');
  }

  /* ------------------------------------------------------------ open / close */

  function loadAndOpen(options) {
    init();
    var requestToken = ++switchToken;
    var params = options.params || { id: options.subject.id };
    showBootMessage('Loading stream...');

    CV.api.get('/api/playback', params, function (err, payload) {
      if (requestToken !== switchToken) return;
      if (err) {
        openError(options, err.message || 'Unable to start playback.');
        return;
      }
      if (!payload.streams || !payload.streams.length) {
        openError(options, 'No playable stream was returned for this title.');
        return;
      }
      open({
        subject: options.subject,
        payload: payload,
        season: options.season || 0,
        episode: options.episode || 0,
        startAt: options.startAt || 0,
        next: options.next || null,
        live: !!payload.live,
        onExit: options.onExit
      });
    });
  }

  function openLive(options) {
    init();
    open({
      subject: null,
      payload: options.payload,
      season: 0,
      episode: 0,
      startAt: 0,
      next: null,
      live: true,
      channel: options.channel,
      onExit: options.onExit
    });
  }

  /** Calls the API again after a failure, without losing the user's place. */
  function openError(options, message) {
    init();
    state = {
      options: options,
      live: false,
      controls: true
    };
    u.show(dom.player, true);
    dom.title.innerHTML = '';
    dom.title.appendChild(document.createTextNode(options.subject ? options.subject.name : 'Playback'));
    u.clear(dom.opts);
    u.show(dom.layer, true);
    u.show(dom.center, false);
    showMessage(message);
    clearCenter();
    var retry = dom.center;
    u.clear(retry);
    retry.appendChild(noticeInline(options, message));
    u.show(retry, true);
    CV.focus.setScope(dom.player);
  }

  function noticeInline(options, message) {
    var box = u.el('div', 'notice error');
    box.appendChild(u.el('div', null, message));
    var actions = u.el('div', 'actions');
    var retryBtn = CV.ui.button('Retry', {
      primary: true,
      onActivate: function () {
        closeState();
        loadAndOpen(options);
      }
    });
    var backBtn = CV.ui.button('Back', {
      onActivate: function () {
        closeState();
        if (options.onExit) options.onExit();
      }
    });
    actions.appendChild(retryBtn);
    actions.appendChild(backBtn);
    box.appendChild(actions);
    return box;
  }

  function showBootMessage(text) {
    init();
    u.show(dom.player, true);
    u.show(dom.layer, false);
    u.show(dom.center, true);
    u.clear(dom.center);
    dom.center.appendChild(u.el('span', null, text));
  }

  function open(opts) {
    init();
    state = {
      subject: opts.subject,
      payload: opts.payload,
      title: (opts.channel ? opts.channel.name : (opts.payload.name || (opts.subject && opts.subject.name) || 'Playback')),
      season: opts.season || 0,
      episode: opts.episode || 0,
      live: !!opts.live,
      channel: opts.channel || null,
      startAt: opts.startAt || 0,
      next: opts.next || null,
      onExit: opts.onExit,
      stream: null,
      quality: '',
      controls: false,
      pausedByUser: false,
      ffLevel: 0,
      resumeAt: opts.startAt || 0,
      restorePlay: false,
      optionList: null,
      seekLock: false
    };

    u.show(dom.player, true);
    u.show(dom.layer, false);
    u.show(dom.center, true);
    clearCenter();
    centreText('Loading...');
    showMessage('');
    dom.title.innerHTML = '';
    dom.title.appendChild(document.createTextNode(state.title));
    u.clear(dom.opts);
    startControlsWatchdog();

    if (state.live) {
      paintLive();
    } else {
      paintTimes(0, 0);
      dom.total.firstChild.nodeValue = '--:--:--';
    }

    var stream = pickStream(state.payload.streams, CV.prefs.get('quality'));
    if (!stream) {
      openError({ subject: state.subject, params: { id: state.subject ? state.subject.id : '' }, onExit: state.onExit },
        'No playable stream is available.');
      return;
    }

    setSource(stream, state.startAt, true);
    CV.subs.attach(dom.video, state.payload.subtitles || [], CV.prefs.get('subtitleLang'), paintSubsPill);
    CV.subs.setSize(CV.prefs.get('subtitleSize'));
    buildOptions();
    startProgressTimer();
  }

  /* --------------------------------------------------------------- streaming */

  /** play() that never leaves an unhandled AbortError behind. */
  function safePlay() {
    try {
      var p = dom.video.play();
      if (p && p['catch']) {
        p['catch'](function (e) {
          if (e && e.name === 'AbortError') return;   /* a pause raced the play */
          if (state && !state.failed) centreText('Press Play to start');
        });
      }
      return p;
    } catch (e) {
      return null;
    }
  }

  function qualityRank(quality) {
    var q = String(quality || '').toLowerCase();
    if (q.indexOf('2160') === 0 || q.indexOf('4k') === 0) return 2160;
    if (q.indexOf('1080') === 0) return 1080;
    if (q.indexOf('720') === 0) return 720;
    if (q.indexOf('480') === 0) return 480;
    if (q.indexOf('360') === 0) return 360;
    if (q.indexOf('auto') === 0) return 1;
    if (q.indexOf('source') === 0) return 1;
    return 0;
  }

  /**
   * Preferred quality is 1080p; if the source does not have it, the highest
   * available quality below it is used. 4K is never forced on this TV.
   */
  function pickStream(streams, preferred) {
    if (!streams || !streams.length) return null;
    var want = qualityRank(preferred || '1080p');
    var exact = null;
    var below = null;
    var above = null;
    var auto = null;
    for (var i = 0; i < streams.length; i++) {
      var rank = qualityRank(streams[i].quality);
      if (rank === want) exact = streams[i];
      else if (rank === 1 && !auto) auto = streams[i];
      else if (rank < want && (!below || rank > qualityRank(below.quality))) below = streams[i];
      else if (rank > want && rank < 2160 && (!above || rank < qualityRank(above.quality))) above = streams[i];
    }
    return exact || below || above || auto || streams[0];
  }

  function setSource(stream, resumeAt, restore) {
    state.stream = stream;
    state.quality = stream.quality;
    state.resumeAt = resumeAt || 0;
    state.restorePlay = !!restore;
    state.pausedByUser = !restore;
    state.ffLevel = 0;

    try {
      dom.video.playbackRate = 1;
      dom.video.muted = false;
      dom.video.setAttribute('preload', 'metadata');
      dom.video.src = stream.url;
      dom.video.load();
    } catch (e) {
      onError();
      return;
    }
    /* Reachable after a paused quality switch too: update the pill before the
       early return that skips autoplay. */
    paintQualityPill();
    if (!state) return;
    if (state.restorePlay) safePlay();
  }

  function onMetadata() {
    var v = dom.video;
    if (state && state.resumeAt > 0) {
      try {
        v.currentTime = state.resumeAt;
      } catch (e) { /* ignore */ }
    }
    paintTimes(v.currentTime || 0, v.duration || 0);
    if (state && !state.live && v.duration) {
      dom.total.firstChild.nodeValue = u.formatTime(v.duration);
    }
    if (state && state.restorePlay) {
      state.restorePlay = false;
      safePlay();
    } else if (state && state.pausedByUser) {
      try {
        v.pause();
      } catch (e) { /* ignore */ }
    }
  }

  function onPlay() {
    quiet();
    startProgressTimer();
    if (state) state.pausedByUser = false;
  }

  function onPause() {
    if (state) state.pausedByUser = true;
    saveProgress();
  }

  function onEnded() {
    if (!state) return;
    if (state.live) {
      centreText('Stream ended');
      showControls();
      return;
    }
    if (state.subject) {
      if (state.next) {
        CV.resume.put(recordFor(0, 0, true));
        showNextEpisode();
      } else {
        CV.resume.remove(state.subject.id);
      }
    }
    showControls();
  }

  function recordFor(position, duration, complete) {
    var subject = state.subject;
    var out = {
      id: subject.id,
      type: subject.isTvShow ? 'series' : 'movie',
      title: subject.name,
      poster: subject.poster,
      season: state.season,
      episode: state.episode,
      episodeTitle: '',
      time: complete ? 0 : Math.floor(position),
      duration: Math.floor(duration || 0)
    };
    return out;
  }

  function showNextEpisode() {
    var next = state.next;
    clearCenter();
    var box = u.el('div');
    box.appendChild(u.el('div', null, 'Episode finished.'));
    var sub = u.el('div');
    sub.appendChild(document.createTextNode((next.title ? next.title : ('Episode ' + next.episode)) + ' is next.'));
    sub.style.color = '#AAAAAA';
    sub.style.margin = '0.4rem 0 0.8rem 0';
    box.appendChild(sub);
    box.appendChild(CV.ui.button('Play next episode', {
      primary: true,
      onActivate: function () {
        var target = state.next;
        close();
        if (CV.details.playNext) CV.details.playNext(target);
      }
    }));
    box.appendChild(CV.ui.button('Back to series', { onActivate: function () { close(); } }));
    dom.center.appendChild(box);
    u.show(dom.center, true);
    CV.focus.setScope(dom.player, box.getElementsByTagName('span')[0]);
  }

  function onError() {
    if (!state) return;
    state.failed = true;
    if (state.live) {
      var canHls = false;
      try {
        canHls = !!dom.video.canPlayType && dom.video.canPlayType('application/vnd.apple.mpegurl') !== '';
      } catch (e) {
        canHls = false;
      }
      showMessage(state.failed && !canHls
        ? 'This television browser reports no native HLS support, so live channels cannot play here.'
        : 'Stream unavailable. Press Reload to try again.');
      centreText('Stream unavailable');
      showControls();
      return;
    }
    showMessage('Video format unsupported or stream unavailable.');
    centreText('Stream unavailable');
    showControls();
  }

  /* -------------------------------------------------------------- UI paint */

  function centreText(text) {
    u.show(dom.center, true);
    u.clear(dom.center);
    dom.center.appendChild(u.el('span', null, text));
  }

  function clearCenter() {
    u.clear(dom.center);
    u.show(dom.center, false);
  }

  function quiet() {
    if (dom.center && state && state.payload && state.payload.live) {
      /* live keeps a LIVE marker, nothing else */
      return;
    }
    clearCenter();
  }

  function showMessage(text) {
    if (!text) {
      u.show(dom.msg, false);
      dom.msg.innerHTML = '';
      return;
    }
    dom.msg.innerHTML = '';
    dom.msg.appendChild(document.createTextNode(text));
    u.show(dom.msg, true);
  }

  function paintTimes(current, duration) {
    dom.current.firstChild.nodeValue = u.formatTime(current);
    if (duration) dom.total.firstChild.nodeValue = u.formatTime(duration);
  }

  function paintLive() {
    dom.seekWrap.style.visibility = 'hidden';
    dom.current.firstChild.nodeValue = 'LIVE';
    dom.total.firstChild.nodeValue = '';
  }

  function paintProgress() {
    if (!state || state.live) return;
    var v = dom.video;
    var d = v.duration || 0;
    var c = v.currentTime || 0;
    var pct = d > 0 ? (c / d) : 0;
    if (pct < 0) pct = 0;
    if (pct > 1) pct = 1;
    dom.seekFill.style.width = (pct * 100) + '%';
    dom.seekKnob.style.left = (pct * 100) + '%';
    paintTimes(c, d);
  }

  function onTimeUpdate() {
    var now = new Date().getTime();
    if (now - lastTimePaint < 400) return;
    lastTimePaint = now;
    paintProgress();
  }

  /* --------------------------------------------------------------- controls */

  function showControls() {
    if (!state) return;
    state.controls = true;
    u.show(dom.layer, true);
    if (state.live) dom.seekWrap.style.visibility = 'hidden';
    CV.focus.setScope(dom.layer);
    restartHideTimer();
  }

  /** The layer's class is the source of truth, not a duplicated flag. */
  function controlsVisible() {
    return !CV.util.hasClass(dom.layer, 'hidden');
  }

  function hideControls() {
    if (!state) return;
    if (state.optionList) {
      /* A closed menu must not leave its flag behind and block hiding. */
      if (u.byId('option-list')) return;
      state.optionList = null;
    }
    state.controls = false;
    hideDeadline = 0;
    u.show(dom.layer, false);
    CV.ui.focusNode(null);
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function restartHideTimer() {
    if (hideTimer) clearTimeout(hideTimer);
    hideDeadline = new Date().getTime() + HIDE_AFTER;
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (state && state.optionList) {
        restartHideTimer();
        return;
      }
      hideControls();
    }, HIDE_AFTER);
  }

  /** Backstop for a lost timeout (or a menu removed without its flag). */
  function startControlsWatchdog() {
    if (controlsWatchdog) return;
    controlsWatchdog = setInterval(function () {
      if (!state || !state.controls || !controlsVisible()) return;
      if (state.optionList) {
        if (u.byId('option-list')) return;
        state.optionList = null;
      }
      if (hideDeadline && new Date().getTime() >= hideDeadline) hideControls();
    }, 1000);
  }

  function stopControlsWatchdog() {
    if (controlsWatchdog) {
      clearInterval(controlsWatchdog);
      controlsWatchdog = null;
    }
  }

  function buildOptions() {
    u.clear(dom.opts);

    var qPill = u.el('span', 'pill', 'Quality: ' + (state.quality || 'Auto'));
    qPill.id = 'pill-quality';
    qPill.setAttribute('data-enter', '1');
    u.on(qPill, 'click', function () { openOptionList('quality'); });
    dom.opts.appendChild(qPill);

    var subs = state.payload.subtitles || [];
    if (subs.length) {
      var cPill = u.el('span', 'pill', 'CC: Off');
      cPill.id = 'pill-subs';
      cPill.setAttribute('data-enter', '1');
      u.on(cPill, 'click', function () { openOptionList('subs'); });
      dom.opts.appendChild(cPill);
      paintSubsPill();
    }

    var audioChoices = audioLanguages();
    if (audioChoices.length > 1 || audioTracksAvailable()) {
      var aPill = u.el('span', 'pill', audioPillLabel(audioChoices));
      aPill.id = 'pill-audio';
      aPill.setAttribute('data-enter', '1');
      u.on(aPill, 'click', function () { openOptionList('audio'); });
      dom.opts.appendChild(aPill);
    }

    if (state.live && state.channel) {
      var favPill = u.el('span', 'pill', CV.favs.has(state.channel.id) ? 'Favourite: yes' : 'Favourite: no');
      favPill.id = 'pill-fav';
      favPill.setAttribute('data-enter', '1');
      u.on(favPill, 'click', function () {
        var added = CV.favs.toggle(state.channel.id);
        favPill.innerHTML = '';
        favPill.appendChild(document.createTextNode(added ? 'Favourite: yes' : 'Favourite: no'));
      });
      dom.opts.appendChild(favPill);
    }

    if (state.live) {
      var rPill = u.el('span', 'pill', 'Reload');
      rPill.id = 'pill-reload';
      rPill.setAttribute('data-enter', '1');
      u.on(rPill, 'click', function () {
        var ch = state.channel;
        close();
        if (ch && CV.live && CV.live.playChannel) CV.live.playChannel(ch);
      });
      dom.opts.appendChild(rPill);
    }
  }

  function paintQualityPill() {
    var pill = u.byId('pill-quality');
    if (!pill || !state) return;
    pill.innerHTML = '';
    pill.appendChild(document.createTextNode('Quality: ' + (state.quality || 'Auto')));
  }

  function paintSubsPill() {
    var pill = u.byId('pill-subs');
    if (!pill) return;
    var active = CV.subs.active();
    pill.innerHTML = '';
    pill.appendChild(document.createTextNode(active ? 'CC: ' + active : 'CC: Off'));
  }

  function audioTracksAvailable() {
    try {
      return !!(dom.video && dom.video.audioTracks && dom.video.audioTracks.length > 1);
    } catch (e) {
      return false;
    }
  }

  /** Separate dubbed versions the provider offers for this title. */
  function audioLanguages() {
    if (!state || !state.payload || state.live) return [];
    return state.payload.audioLanguages || [];
  }

  function currentAudio() {
    var list = audioLanguages();
    var activeId = state && state.payload ? state.payload.audioSubjectId : null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].subjectId === activeId) return list[i];
    }
    return list.length ? list[0] : null;
  }

  function audioPillLabel(list) {
    var active = currentAudio();
    if (active && list.length > 1) return 'Audio: ' + active.language;
    return 'Audio';
  }

  function paintAudioPill() {
    var pill = u.byId('pill-audio');
    if (!pill) return;
    pill.innerHTML = '';
    pill.appendChild(document.createTextNode(audioPillLabel(audioLanguages())));
  }

  function openOptionList(kind) {
    if (!state) return;
    /* A repeated OK from the remote must not reopen the menu it just closed. */
    if (new Date().getTime() < optionCooldownUntil) return;
    /* Never stack two option lists; a second open replaces the first. */
    removeOptionLists();
    state.optionList = kind;
    var list = u.el('div');
    list.id = 'option-list';
    list.className = 'option-list';
    list.style.marginTop = '0.6rem';

    if (kind === 'quality') {
      var streams = state.payload.streams || [];
      var seenQuality = {};
      for (var i = 0; i < streams.length; i++) {
        var qualityName = String(streams[i].quality || '');
        var qualityKey = 'q:' + qualityName;
        if (seenQuality[qualityKey]) continue;
        seenQuality[qualityKey] = true;
        list.appendChild(optionChip(qualityName, qualityName === state.quality, function () {
          switchQuality(this.getAttribute('data-q'));
        }, 'data-q', qualityName));
      }
    } else if (kind === 'audio') {
      var choices = audioLanguages();
      var active = currentAudio();
      for (var a = 0; a < choices.length; a++) {
        list.appendChild(optionChip(choices[a].language, active && active.subjectId === choices[a].subjectId,
          function () { switchAudio(this.getAttribute('data-q')); }, 'data-q', choices[a].subjectId));
      }
      if (audioTracksAvailable()) {
        for (var t = 0; t < dom.video.audioTracks.length; t++) {
          (function (index) {
            var label = dom.video.audioTracks[index].language || ('Track ' + (index + 1));
            list.appendChild(optionChip(label, index === 0, function () {
              try {
                for (var k = 0; k < dom.video.audioTracks.length; k++) {
                  dom.video.audioTracks[k].enabled = (k === index);
                }
              } catch (e) { /* ignore */ }
              closeOptionList();
            }, 'data-q', '__track' + index));
          })(t);
        }
      }
      if (list.firstChild && !list.firstChild.firstChild) {
        /* nothing selectable */
      }
    } else if (kind === 'subs') {
      var langs = CV.subs.langList();
      for (var j = 0; j < langs.length; j++) {
        list.appendChild(optionChip(langs[j].language, langs[j].language === (CV.subs.active() || 'Off'), function () {
          applySubtitle(this.getAttribute('data-q'));
        }, 'data-q', langs[j].language));
      }
      list.appendChild(optionChip('Size: ' + CV.prefs.get('subtitleSize'), false, function () {
        cycleSubSize();
      }, 'data-q', '__size'));
    }

    if (!list.firstChild) {
      state.optionList = null;
      return;
    }
    dom.opts.appendChild(list);
    var first = list.firstChild;
    CV.focus.setScope(dom.layer, first);
    restartHideTimer();
  }

  function optionChip(label, active, onClick, attr, value) {
    var node = u.el('span', 'pill' + (active ? ' on' : ''), label);
    node.setAttribute(attr, value);
    node.setAttribute('data-enter', '1');
    u.on(node, 'click', onClick);
    return node;
  }

  function removeOptionLists() {
    if (!dom.opts) return;
    /* Remove every direct child menu, including duplicates with the same id. */
    var children = dom.opts.childNodes;
    for (var i = children.length - 1; i >= 0; i--) {
      var child = children[i];
      if (child.nodeType === 1 && (child.id === 'option-list' || u.hasClass(child, 'option-list'))) {
        dom.opts.removeChild(child);
      }
    }
  }

  function closeOptionList() {
    removeOptionLists();
    if (state) state.optionList = null;
    optionCooldownUntil = new Date().getTime() + 800;
    CV.focus.refresh();
    restartHideTimer();
  }

  function applySubtitle(lang) {
    CV.subs.setLang(lang);
    paintSubsPill();
    closeOptionList();
  }

  function cycleSubSize() {
    var order = ['Small', 'Medium', 'Large'];
    var current = CV.prefs.get('subtitleSize');
    var next = order[(u.indexOf(order, current) + 1) % order.length];
    CV.prefs.set('subtitleSize', next);
    CV.subs.setSize(next);
    closeOptionList();
    openOptionList('subs');
  }

  /* ------------------------------------------------------------ quality swap */

  function switchQuality(quality) {
    if (!state || quality === state.quality) {
      closeOptionList();
      return;
    }
    var streams = state.payload.streams || [];
    var target = null;
    for (var i = 0; i < streams.length; i++) {
      if (streams[i].quality === quality) {
        target = streams[i];
        break;
      }
    }
    if (!target) {
      closeOptionList();
      return;
    }

    var keepTime = dom.video.currentTime || 0;
    var keepPaused = dom.video.paused;
    var keepSub = CV.subs.active();
    var wasRate = dom.video.playbackRate;

    closeOptionList();
    showMessage('Switching to ' + quality + '...');
    centreText('Switching to ' + quality + '...');

    state.restorePlay = !keepPaused;
    state.resumeAt = keepTime;
    setSource(target, keepTime, !keepPaused);
    if (keepSub) {
      CV.subs.setLang(keepSub);
    }
    dom.video.playbackRate = wasRate > 1 ? wasRate : 1;
    showControls();

    var failTimer = setTimeout(function () {
      if (dom.video.readyState < 1) {
        showMessage('Could not switch quality. Previous quality kept.');
        centreText('');
        u.show(dom.center, false);
      }
    }, 9000);
    u.on(dom.video, 'loadedmetadata', function once() {
      clearTimeout(failTimer);
      u.off(dom.video, 'loadedmetadata', once);
      showMessage('');
    });
  }

  /**
   * Audio language switch. Each dubbed version is its own provider subject, so
   * this resolves a fresh playback session for the chosen language and keeps
   * the position, the paused state, the quality and the subtitle choice.
   */
  function switchAudio(audioSubjectId) {
    if (!state || state.live || !state.subject) {
      closeOptionList();
      return;
    }
    var keepTime = dom.video.currentTime || 0;
    var keepPaused = dom.video.paused;
    var keepSub = CV.subs.active();
    var keepQuality = state.quality;

    closeOptionList();
    showMessage('Switching audio...');

    var params = {
      id: state.subject.id,
      season: state.season || undefined,
      episode: state.episode || undefined,
      quality: keepQuality,
      audioSubjectId: audioSubjectId
    };

    CV.api.get('/api/playback', params, function (err, payload) {
      if (!state) return;
      if (err || !payload || !payload.streams || !payload.streams.length) {
        showMessage('Could not switch audio. The current track is kept.');
        restartHideTimer();
        return;
      }
      state.payload = payload;
      var stream = null;
      for (var i = 0; i < payload.streams.length; i++) {
        if (payload.streams[i].quality === keepQuality) stream = payload.streams[i];
      }
      if (!stream) stream = pickStream(payload.streams, CV.prefs.get('quality'));

      /* Same media behind the new language (common when the provider returns one
         file with several dubs): keep playing untouched instead of re-loading. */
      if (state.stream && state.stream.url === stream.url) {
        state.payload = payload;
        buildOptions();
        restartHideTimer();
        showMessage('');
        return;
      }

      setSource(stream, keepTime, !keepPaused);
      CV.subs.attach(dom.video, payload.subtitles || [], CV.prefs.get('subtitleLang'), paintSubsPill);
      if (keepSub) CV.subs.setLang(keepSub);
      buildOptions();
      restartHideTimer();
    });
  }

  /* ------------------------------------------------------------------ keys */

  function handle(code) {
    if (!state) return false;

    /* In the failure state only the notice's own buttons matter. */
    if (state.options) {
      if (code === 'back') {
        var exit = state.options.onExit;
        closeState();
        if (exit) exit();
        return true;
      }
      if (code === 'left' || code === 'right' || code === 'up' || code === 'down') {
        CV.focus.move(code);
        return true;
      }
      if (code === 'ok') {
        CV.focus.enter();
        return true;
      }
      return true;
    }

    if (!controlsVisible()) {
      /* Hidden controls: media keys act, and any navigation wakes the UI. */
      if (code === 'ok') { toggle(); return true; }
      if (code === 'play') { play(); return true; }
      if (code === 'pause') { pause(); return true; }
      if (code === 'playpause') { toggle(); return true; }
      if (code === 'ff') { fastForward(); return true; }
      if (code === 'rew') { rewind(); return true; }
      if (code === 'stop') { close(); return true; }
      if (code === 'chup') { channelStep(1); return true; }
      if (code === 'chdown') { channelStep(-1); return true; }
      if (code === 'back') { close(); return true; }
      if (code === 'left') { stepSeek(-10); showControls(); return true; }
      if (code === 'right') { stepSeek(10); showControls(); return true; }
      showControls();
      return true;
    }

    /* Controls visible */
    if (code === 'back') {
      if (state.optionList) {
        closeOptionList();
        if (state.centerOpen) u.show(dom.center, false);
        return true;
      }
      hideControls();
      return true;
    }
    if (code === 'play') { play(); return true; }
    if (code === 'pause') { pause(); return true; }
    if (code === 'playpause') { toggle(); return true; }
    if (code === 'ff') { fastForward(); return true; }
    if (code === 'rew') { rewind(); return true; }
    if (code === 'stop') { close(); return true; }
    if (code === 'chup') { channelStep(1); return true; }
    if (code === 'chdown') { channelStep(-1); return true; }

    restartHideTimer();

    if (code === 'up' || code === 'down') {
      CV.focus.move(code);
      return true;
    }
    if (code === 'left' || code === 'right') {
      var focused = CV.focus.current();
      if (!focused || focused === dom.seekWrap) {
        stepSeek(code === 'left' ? -10 : 10);
        return true;
      }
      CV.focus.move(code);
      return true;
    }
    if (code === 'ok') {
      var node = CV.focus.current();
      if (!node) {
        showControls();
        return true;
      }
      if (node === dom.seekWrap) {
        toggle();
        return true;
      }
      CV.focus.enter();
      return true;
    }
    return true;
  }

  /* ---------------------------------------------------------- playback ops */

  function play() {
    safePlay();
    setRate(1);
  }

  function pause() {
    try { dom.video.pause(); } catch (e) { /* ignore */ }
    setRate(1);
  }

  function toggle() {
    if (!state) return;
    if (dom.video.paused) play();
    else pause();
    if (controlsVisible()) restartHideTimer();
  }

  /**
   * 8x is attempted with audio muted. If the engine ignores playbackRate the
   * key still does something useful: it jumps forward by 30 seconds.
   */
  function fastForward() {
    if (!state) return;
    if (state.live) {
      showMessage('Live stream: fast-forward is not available.');
      return;
    }
    var v = dom.video;
    if (state.ffLevel) {
      setRate(1);
      showMessage('');
      return;
    }
    var before = v.playbackRate;
    v.muted = true;
    try { v.playbackRate = 8; } catch (e) { /* ignore */ }
    state.ffLevel = 8;
    setTimeout(function () {
      if (!state) return;
      if (v.playbackRate === before) {
        /* Rate not honoured: fall back to a forward jump. */
        state.ffLevel = 0;
        stepSeek(30);
        v.muted = false;
        showMessage('Fast-forward needs to be pressed repeatedly on this TV.');
      } else {
        showMessage('8x (muted) \u2014 press Play to resume normal speed');
      }
    }, 400);
  }

  function rewind() {
    if (!state) return;
    if (state.live) {
      showMessage('Live stream: rewind is not available.');
      return;
    }
    stepSeek(-30);
  }

  function stepSeek(delta) {
    if (!state || state.live) return;
    var now = new Date().getTime();
    if (now - lastSeekAt < 350) return;
    lastSeekAt = now;
    var v = dom.video;
    var duration = v.duration || 0;
    var target = (v.currentTime || 0) + delta;
    if (target < 0) target = 0;
    if (duration && target > duration - 1) target = duration - 1;
    try {
      v.currentTime = target;
    } catch (e) { /* ignore */ }
    paintProgress();
    restartHideTimer();
  }

  function setRate(rate) {
    if (!state) return;
    var v = dom.video;
    try { v.playbackRate = rate; } catch (e) { /* ignore */ }
    if (rate === 1 && state.ffLevel) {
      state.ffLevel = 0;
      v.muted = false;
      showMessage('');
    }
  }

  function channelStep(dir) {
    if (!state || !state.live) return;
    if (CV.live && CV.live.channelStep) {
      var channel = CV.live.channelStep(dir);
      if (channel) {
        close();
        CV.live.playChannel(channel);
      } else {
        showMessage('No other channel available.');
      }
    }
  }

  /* ------------------------------------------------------- resume progress */

  function saveProgress() {
    if (!state || !state.subject || state.live) return;
    var v = dom.video;
    var time = v.currentTime || 0;
    var duration = v.duration || 0;
    if (!time || time < 3) return;
    if (duration && time > duration - 5) {
      CV.resume.remove(state.subject.id);
      return;
    }
    CV.resume.put(recordFor(time, duration, false));
  }

  function startProgressTimer() {
    if (progressTimer) return;
    progressTimer = setInterval(saveProgress, 15000);
  }

  function stopProgressTimer() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  /* ------------------------------------------------------------- teardown */

  function close() {
    if (!state) return;
    saveProgress();
    var onExit = state.options ? null : state.onExit;
    closeState();
    if (onExit) onExit();
  }

  /** Releases every media resource without calling the exit callback twice. */
  function closeState() {
    switchToken++;
    stopProgressTimer();
    stopControlsWatchdog();
    hideDeadline = 0;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    CV.subs.clear(dom.video);
    try {
      dom.video.pause();
      dom.video.playbackRate = 1;
      dom.video.muted = false;
      dom.video.removeAttribute('src');
      dom.video.load();
    } catch (e) { /* ignore */ }
    CV.api.abortAll();
    state = null;
    u.show(dom.player, false);
    u.show(dom.layer, false);
    u.show(dom.center, false);
    u.clear(dom.center);
    u.clear(dom.opts);
    showMessage('');
  }

  function isOpen() {
    return !!state;
  }

  function liveInfo() {
    return state && state.live ? state.channel : null;
  }

  /* Keeps the last frame clean on navigation away / TV sleep. */
  function bindGlobalHooks() {
    u.on(window, 'beforeunload', function () { saveProgress(); });
    u.on(document, 'visibilitychange', function () {
      if (document.hidden) saveProgress();
    });
  }

  return {
    init: function () {
      init();
      bindGlobalHooks();
    },
    loadAndOpen: loadAndOpen,
    openLive: openLive,
    handle: handle,
    isOpen: isOpen,
    close: close,
    toggle: toggle,
    stepSeek: stepSeek,
    qualityRank: qualityRank,
    pickStream: pickStream,
    liveInfo: liveInfo,
    showControls: showControls
  };
})();
