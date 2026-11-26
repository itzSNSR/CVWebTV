/* CineVault TV — compatibility/tests.js
   ES5. Every playback claim here is measured on the device that runs the page. */

(function () {

  var video = document.getElementById('v');
  var rowsHost = document.getElementById('rows');
  var keyPanel = document.getElementById('keypanel');
  var keyNow = document.getElementById('keynow');
  var keyLog = document.getElementById('keylog');

  var MP4_1080 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4';
  var MP4_720 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4';
  var MP4_MED = 'https://media.w3.org/2010/05/bunny/movie.mp4';
  var HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  var VTT_URL = '../media/subs/demo-english.vtt';

  var results = {};

  /* -------------------------------------------------------------- framework */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.appendChild(document.createTextNode(String(text)));
    return n;
  }

  function badge(state) {
    var map = {
      idle: 'NOT RUN', running: 'RUNNING', pass: 'PASS', fail: 'FAIL', unsup: 'NOT SUPPORTED'
    };
    return el('span', 'badge ' + state, map[state] || state);
  }

  function setState(id, state, detail) {
    results[id] = { state: state, detail: detail || '' };
    var row = document.getElementById('test-' + id);
    if (!row) return;
    var stateCell = row.getElementsByTagName('td')[2];
    stateCell.innerHTML = '';
    stateCell.appendChild(badge(state));
    var detailCell = row.getElementsByTagName('td')[4];
    detailCell.innerHTML = '';
    if (detail) detailCell.appendChild(el('div', 'detail', detail));
  }

  var tests = [];

  function addTest(def) {
    tests.push(def);
    var row = el('tr');
    row.id = 'test-' + def.id;
    row.appendChild(el('td', 'num', String(tests.length)));
    row.appendChild(el('td', 'name', def.name));
    var stateCell = el('td', 'state');
    stateCell.appendChild(badge('idle'));
    row.appendChild(stateCell);
    var goCell = el('td', 'go');
    if (def.mode !== 'auto') {
      var btn = el('button', null, 'Run');
      btn.onclick = function () { start(def); };
      goCell.appendChild(btn);
    } else {
      goCell.appendChild(el('span', 'detail', 'auto'));
    }
    row.appendChild(goCell);
    row.appendChild(el('td', 'detail'));
    rowsHost.appendChild(row);
  }

  function start(def) {
    setState(def.id, 'running', '');
    try {
      def.run(function (state, detail) { setState(def.id, state, detail); onFinished(def); });
    } catch (e) {
      setState(def.id, 'fail', 'Test threw: ' + e.message);
      onFinished(def);
    }
  }

  var chain = null;

  function onFinished(def) {
    if (chain && chain.length) {
      var next = chain.shift();
      setTimeout(function () { start(next); }, 250);
    }
  }

  /* ------------------------------------------------------------ media utils */

  function unloadMedia(cb) {
    try {
      video.pause();
      video.playbackRate = 1;
      video.muted = false;
      var tracks = video.getElementsByTagName('track');
      while (tracks.length) video.removeChild(tracks[0]);
      video.removeAttribute('src');
      video.load();
    } catch (e) { /* ignore */ }
    setTimeout(function () { if (cb) cb(); }, 300);
  }

  /** Loads a source and reports what the device actually managed to do. */
  function probe(url, opts, cb) {
    var finished = false;
    var timer = setTimeout(function () {
      finish({ ok: false, reason: 'timeout after ' + ((opts && opts.waitMs) || 12000) + ' ms' });
    }, (opts && opts.waitMs) || 12000);

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      cb(result);
    }

    video.onloadedmetadata = function () {
      var info = {
        ok: true,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        canPlay: video.canPlayType ? video.canPlayType('video/mp4') : ''
      };
      video.onloadedmetadata = null;
      var p = video.play();
      var advanced = 0;
      var before = 0;
      var check = setInterval(function () {
        if (video.currentTime > 0) advanced = video.currentTime;
        if (advanced > 0.25) {
          clearInterval(check);
          info.playedTo = advanced;
          info.muted = video.muted;
          info.decodedAudioBytes = video.webkitAudioDecodedByteCount || 0;
          info.audioTracks = video.audioTracks ? video.audioTracks.length : null;
          finish(info);
        }
      }, 200);
      setTimeout(function () {
        clearInterval(check);
        if (!advanced) {
          info.playedTo = video.currentTime || 0;
          info.decodedAudioBytes = video.webkitAudioDecodedByteCount || 0;
          info.audioTracks = video.audioTracks ? video.audioTracks.length : null;
          finish(info);
        }
      }, 4000);
      if (p && p['catch']) p['catch'](function () { /* autoplay refused */ });
    };

    video.onerror = function () {
      var code = video.error ? video.error.code : 0;
      finish({ ok: false, reason: 'media error code ' + code });
    };

    try {
      video.setAttribute('preload', 'metadata');
      video.src = url;
      video.load();
    } catch (e) {
      finish({ ok: false, reason: e.message });
    }
  }

  function canPlayType(type) {
    try {
      return video.canPlayType ? video.canPlayType(type) : '';
    } catch (e) {
      return '';
    }
  }

  function xhrGet(url, headers, cb) {
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(err, status, text, hdrs) {
      if (done) return;
      done = true;
      cb(err, status, text, hdrs);
    }
    try {
      xhr.open('GET', url, true);
    } catch (e) {
      return cb('open failed: ' + e.message);
    }
    xhr.timeout = 12000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var h = '';
      try { h = xhr.getAllResponseHeaders() || ''; } catch (e) { h = ''; }
      finish(xhr.status === 0 ? 'network error' : null, xhr.status, xhr.responseText, h);
    };
    xhr.onerror = function () { finish('network error'); };
    xhr.ontimeout = function () { finish('timeout'); };
    if (headers) {
      for (var k in headers) {
        if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]);
      }
    }
    try { xhr.send(null); } catch (e) { finish('send failed'); }
  }

  /* -------------------------------------------------------- remote capture */

  var capture = null;   /* { id, want:{}, seen:{}, done:false } */

  var ARROWS = { 37: 'left', 39: 'right', 38: 'up', 40: 'down' };
  var NAME_ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  var OKS = { 13: 'ok' };
  var BACKS = { 8: 'back', 27: 'back', 461: 'back', 10009: 'back' };
  var MEDIA = { 415: 'play', 19: 'pause', 179: 'playpause', 10252: 'playpause', 417: 'ff', 412: 'rew', 413: 'stop' };

  function classify(e) {
    var c = e.keyCode || e.which || 0;
    var n = e.key || '';
    if (NAME_ARROWS[n]) return { group: 'arrow', name: NAME_ARROWS[n] };
    if (ARROWS[c]) return { group: 'arrow', name: ARROWS[c] };
    if (OKS[c] || n === 'Enter' || n === 'Accept') return { group: 'ok', name: 'ok' };
    if (BACKS[c] || n === 'Escape' || n === 'GoBack' || n === 'Back') return { group: 'back', name: 'back' };
    if (MEDIA[c]) return { group: 'media', name: MEDIA[c] };
    if (n.indexOf('Media') === 0) return { group: 'media', name: n };
    if (n === 'ChannelUp') return { group: 'media', name: 'chup' };
    if (n === 'ChannelDown') return { group: 'media', name: 'chdown' };
    return { group: 'other', name: '' };
  }

  function captureFor(id, groups, label) {
    var want = {};
    for (var i = 0; i < groups.length; i++) want[groups[i]] = true;
    capture = { id: id, groups: want, seen: {}, label: label };
    keyPanel.className = 'on';
    keyNow.innerHTML = '';
    keyNow.appendChild(document.createTextNode('Capturing for: ' + label));
    keyLog.innerHTML = '';
    setState(id, 'running', 'Waiting for remote buttons: ' + label);
  }

  function noteKey(e) {
    var info = classify(e);
    var line = el('div');
    line.appendChild(el('span', 'kb', 'keyCode ' + (e.keyCode || e.which || 0)));
    line.appendChild(document.createTextNode('key="' + (e.key || '') + '"  ' +
      (info.group === 'other' ? 'unmapped' : info.group + ':' + info.name)));
    keyLog.insertBefore(line, keyLog.firstChild);
    while (keyLog.childNodes.length > 14) keyLog.removeChild(keyLog.lastChild);

    if (!capture) return;
    if (info.group === 'other') return;
    capture.seen[info.group] = capture.seen[info.group] || {};
    capture.seen[info.group][info.name] = true;

    var groups = [];
    for (var g in capture.seen) {
      if (capture.seen.hasOwnProperty(g)) {
        var names = [];
        for (var n in capture.seen[g]) {
          if (capture.seen[g].hasOwnProperty(n)) names.push(n);
        }
        groups.push(g + '=' + names.join(','));
      }
    }
    setState(capture.id, 'running', 'Seen so far: ' + groups.join('  '));

    if (isSatisfied()) {
      setState(capture.id, 'pass', 'Confirmed on this device: ' + groups.join('  '));
      keyNow.innerHTML = '';
      keyNow.appendChild(document.createTextNode('Capture complete: ' + capture.label));
      capture = null;
    }
  }

  function isSatisfied() {
    if (!capture) return false;
    if (capture.groups.arrow) {
      var a = capture.seen.arrow || {};
      if (!(a.left && a.right && a.up && a.down)) return false;
    }
    if (capture.groups.ok && !(capture.seen.ok || {}).ok) return false;
    if (capture.groups.back && !(capture.seen.back || {}).back) return false;
    if (capture.groups.media) {
      var m = capture.seen.media || {};
      if (!(m.play || m.playpause || m.pause || m.ff || m.rew || m.stop)) return false;
    }
    return true;
  }

  document.addEventListener('keydown', function (e) {
    noteKey(e);
  }, false);

  /* ---------------------------------------------------------------- tests */

  addTest({
    id: 'render', name: 'HTML and CSS rendering', mode: 'auto',
    run: function (done) {
      var box = el('div');
      box.style.backgroundColor = '#8B5CF6';
      box.style.borderRadius = '4px';
      box.style.width = '20px';
      box.style.height = '20px';
      document.body.appendChild(box);
      var cs = window.getComputedStyle ? window.getComputedStyle(box, null) : null;
      var bg = cs ? (cs.backgroundColor || '') : '';
      var radius = cs ? (cs.borderTopLeftRadius || cs.borderRadius || '') : '';
      document.body.removeChild(box);
      var colourOk = bg.indexOf('139') >= 0 || bg.toLowerCase().indexOf('#8b5cf6') >= 0;
      if (colourOk && radius) done('pass', 'computed background=' + bg + ', border-radius=' + radius);
      else done('fail', 'computed background=' + bg + ', border-radius=' + radius);
    }
  });

  addTest({
    id: 'es5', name: 'ES5 JavaScript', mode: 'auto',
    run: function (done) {
      var missing = [];
      if (typeof JSON === 'undefined') missing.push('JSON');
      if (!Object.keys) missing.push('Object.keys');
      if (!Array.prototype.indexOf) missing.push('Array.indexOf');
      if (!Function.prototype.bind) missing.push('Function.bind');
      if (!document.addEventListener) missing.push('addEventListener');
      if (!document.querySelector) missing.push('querySelector');
      if (!String.prototype.trim) missing.push('String.trim');
      if (missing.length) done('fail', 'Missing: ' + missing.join(', '));
      else done('pass', 'ES5 features present; this page itself is ES5.');
    }
  });

  addTest({
    id: 'xhr', name: 'XMLHttpRequest', mode: 'auto',
    run: function (done) {
      xhrGet('../api/health', null, function (err, status, text) {
        if (err) return done('fail', 'XHR failed: ' + err);
        if (status !== 200) return done('fail', 'HTTP ' + status);
        var okJson = false;
        try {
          var data = JSON.parse(text);
          okJson = !!data.ok;
        } catch (e) { okJson = false; }
        if (okJson) done('pass', 'GET /api/health returned 200 with valid JSON.');
        else done('fail', 'Response was not the expected JSON.');
      });
    }
  });

  addTest({
    id: 'https', name: 'HTTPS connectivity', mode: 'auto',
    run: function (done) {
      var proto = document.location.protocol;
      if (proto !== 'https:' && proto !== 'http:') {
        return done('unsup', 'Unexpected protocol: ' + proto);
      }
      xhrGet('../api/health', null, function (err, status) {
        if (err) return done('fail', proto + ' request failed: ' + err);
        if (status !== 200) return done('fail', proto + ' reached the server but returned HTTP ' + status);
        done(proto === 'https:' ? 'pass' : 'fail',
          'Page loaded over ' + proto + '; API reachable. ' +
          (proto === 'https:' ? 'Transport is encrypted.' : 'Install with an HTTPS URL for production.'));
      });
    }
  });

  addTest({
    id: 'storage', name: 'LocalStorage', mode: 'auto',
    run: function (done) {
      try {
        window.localStorage.setItem('cvtv.compat.probe', 'ok');
        var value = window.localStorage.getItem('cvtv.compat.probe');
        window.localStorage.removeItem('cvtv.compat.probe');
        if (value === 'ok') done('pass', 'Read and write succeeded.');
        else done('fail', 'Wrote a value but read back "' + value + '".');
      } catch (e) {
        done('fail', 'LocalStorage threw: ' + e.message);
      }
    }
  });

  addTest({
    id: 'arrows', name: 'Directional buttons (up/down/left/right)', mode: 'user',
    run: function (done) {
      captureFor('arrows', ['arrow'], 'press up, down, left and right');
      done('running', 'Waiting for all four directions.');
      setTimeout(function () {}, 0);
    }
  });

  addTest({
    id: 'okback', name: 'OK and Back buttons', mode: 'user',
    run: function (done) {
      captureFor('okback', ['ok', 'back'], 'press OK, then Back');
      done('running', 'Waiting for OK and Back.');
    }
  });

  addTest({
    id: 'media', name: 'Physical media buttons', mode: 'user',
    run: function (done) {
      captureFor('media', ['media'], 'press a play, pause, stop, rewind or fast-forward button');
      done('running', 'Waiting for one media button.');
    }
  });

  addTest({
    id: 'keyboard', name: 'Television on-screen keyboard', mode: 'user',
    run: function (done) {
      keyPanel.className = 'on';
      keyNow.innerHTML = '';
      keyNow.appendChild(document.createTextNode('Type three or more characters below using the TV keyboard.'));
      keyLog.innerHTML = '';
      var input = document.createElement('input');
      input.className = 'text';
      input.type = 'text';
      input.value = '';
      input.setAttribute('placeholder', 'Tap here to open the TV keyboard');
      keyLog.appendChild(input);
      input.focus();
      input.onkeyup = function () {
        if (input.value.length >= 3) {
          setState('keyboard', 'pass', 'Typed "' + input.value + '" with the on-screen keyboard.');
          keyNow.innerHTML = '';
          keyNow.appendChild(document.createTextNode('Keyboard test complete.'));
        }
      };
      input.onchange = input.onkeyup;
      done('running', 'Waiting for at least three typed characters.');
    }
  });

  addTest({
    id: 'mp4', name: '1080p H.264 MP4 playback', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_1080, null, function (r) {
          if (!r.ok) return done('fail', 'Not played: ' + r.reason + '. canPlayType(video/mp4)="' + canPlayType('video/mp4') + '"');
          var detail = 'videoWidth x videoHeight = ' + r.width + ' x ' + r.height +
            ', duration ' + (Math.round(r.duration * 10) / 10) + ' s, playback reached ' +
            (Math.round(r.playedTo * 100) / 100) + ' s';
          unloadMedia(function () { });
          if (r.width >= 1280 && r.playedTo > 0.25) done('pass', detail);
          else done('fail', detail + ' (frame size or playback did not match the 1080p file)');
        });
      });
    }
  });

  addTest({
    id: 'aac', name: 'AAC audio playback', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_720, null, function (r) {
          if (!r.ok) return done('fail', 'Media failed: ' + r.reason);
          var bytes = r.decodedAudioBytes || 0;
          var tracks = r.audioTracks;
          var detail = 'audio tracks reported: ' + (tracks === null ? 'API absent' : tracks) +
            ', decoded audio bytes: ' + bytes;
          unloadMedia(function () { });
          if (tracks !== null && tracks > 0) return done('pass', detail + ' (track present and decoded)');
          if (bytes > 0) return done('pass', detail + ' (decoder produced audio)');
          done('unsup', detail + '. This browser does not expose whether audio decoded. ' +
            'Confirm by ear on the television.');
        });
      });
    }
  });

  addTest({
    id: 'ac3', name: 'AC3 / EAC3 audio', mode: 'playback',
    run: function (done) {
      var support = canPlayType('video/mp4; codecs="avc1.42E01E, ac-3"');
      done('unsup', 'No authorised AC3/EAC3 test asset is configured, so nothing was played. ' +
        'canPlayType(ac-3)="' + support + '" is a claim, not a result. ' +
        'Add a licensed test clip to compatibility/ to settle this test.');
    }
  });

  addTest({
    id: 'hls', name: 'Native HLS playback', mode: 'playback',
    run: function (done) {
      var claim = canPlayType('application/vnd.apple.mpegurl');
      unloadMedia(function () {
        probe(HLS_URL, null, function (r) {
          unloadMedia(function () { });
          if (r.ok && r.playedTo > 0.2) {
            return done('pass', 'HLS played (' + r.width + 'x' + r.height + ', reached ' +
              (Math.round(r.playedTo * 100) / 100) + ' s). canPlayType="' + claim + '"');
          }
          done('fail', 'HLS did not play (' + (r.reason || 'no playback') + '). canPlayType="' + claim +
            '". Live TV will show an unsupported-stream message on this device.');
        });
      });
    }
  });

  addTest({
    id: 'range', name: 'HTTP range seeking', mode: 'playback',
    run: function (done) {
      xhrGet('../media/subs/demo-english.vtt', null, function (err, status, text, headers) {
        var accepts = (headers || '').toLowerCase().indexOf('accept-ranges: bytes') >= 0;
        unloadMedia(function () {
          probe(MP4_MED, null, function (r) {
            if (!r.ok) {
              unloadMedia(function () { });
              return done('fail', 'Seek test media failed: ' + r.reason);
            }
            var target = Math.min(20, (r.duration || 60) * 0.5);
            var seeked = false;
            video.onseeked = function () { seeked = true; };
            try { video.currentTime = target; } catch (e) { /* ignore */ }

            setTimeout(function () {
              var at = video.currentTime;
              var okSeek = seeked && Math.abs(at - target) < 3;
              unloadMedia(function () {
                var detail = 'Accept-Ranges: ' + (accepts ? 'bytes (server)' : 'not advertised') +
                  '; seek to ' + target + ' s landed at ' + (Math.round(at * 100) / 100) + ' s' +
                  ', seeked event: ' + (seeked ? 'yes' : 'no');
                done(okSeek ? 'pass' : 'fail', detail);
              });
            }, 2500);
          });
        });
      });
    }
  });

  addTest({
    id: 'vtt', name: 'WebVTT subtitles', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_MED, null, function (r) {
          if (!r.ok) {
            unloadMedia(function () { });
            return done('fail', 'Base media failed: ' + r.reason);
          }
          if (!video.textTracks) {
            unloadMedia(function () { });
            return done('unsup', 'This engine has no textTracks API. The app falls back to a text overlay.');
          }
          var track = document.createElement('track');
          track.kind = 'subtitles';
          track.label = 'English';
          track.srclang = 'en';
          track.src = VTT_URL;
          track.setAttribute('default', '');
          video.appendChild(track);

          setTimeout(function () {
            var n = video.textTracks.length;
            var cues = 0;
            try {
              video.textTracks[0].mode = 'showing';
              cues = video.textTracks[0].cues ? video.textTracks[0].cues.length : 0;
            } catch (e) { cues = 0; }
            unloadMedia(function () {
              var detail = 'textTracks=' + n + ', cues loaded=' + cues;
              if (cues > 0) done('pass', detail);
              else if (n > 0) done('unsup', detail + '. Track element exists but cues did not load; ' +
                'the app will fall back to its own overlay.');
              else done('fail', detail + '. No track registered.');
            });
          }, 3500);
        });
      });
    }
  });

  addTest({
    id: 'audiotrack', name: 'Audio track selection', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_720, null, function (r) {
          var tracks = video.audioTracks;
          var count = tracks ? tracks.length : 0;
          unloadMedia(function () {
            if (count > 1) done('pass', count + ' selectable audio tracks reported.');
            else done('unsup', count + ' audio tracks exposed (API ' + (tracks ? 'present' : 'absent') +
              '). The audio selector stays hidden on untested behaviour; only one language track exists anyway.');
          });
        });
      });
    }
  });

  addTest({
    id: 'rate', name: 'Playback rate control', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_MED, null, function (r) {
          if (!r.ok) {
            unloadMedia(function () { });
            return done('fail', 'Media failed: ' + r.reason);
          }
          try { video.playbackRate = 2; } catch (e) { /* ignore */ }
          var start = video.currentTime;
          setTimeout(function () {
            var delta = video.currentTime - start;
            var applied = video.playbackRate;
            unloadMedia(function () {
              var detail = 'playbackRate read back as ' + applied + ', advanced ' +
                (Math.round(delta * 100) / 100) + ' s in 2 s';
              if (applied === 2 && delta > 2.6) done('pass', detail);
              else done('fail', detail + '. Fast-forward will fall back to repeated 30 s jumps.');
            });
          }, 2000);
        });
      });
    }
  });

  addTest({
    id: 'mute8x', name: 'Muted 8x playback', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_MED, null, function (r) {
          if (!r.ok) {
            unloadMedia(function () { });
            return done('fail', 'Media failed: ' + r.reason);
          }
          video.muted = true;
          try { video.playbackRate = 8; } catch (e) { /* ignore */ }
          var start = video.currentTime;
          setTimeout(function () {
            var delta = video.currentTime - start;
            var applied = video.playbackRate;
            var muted = video.muted;
            unloadMedia(function () {
              var detail = 'rate read back ' + applied + ', muted ' + muted + ', advanced ' +
                (Math.round(delta * 100) / 100) + ' s in 2 s';
              if (applied === 8 && delta > 10) done('pass', detail);
              else done('fail', detail + '. The 8x key will use forward jumps instead.');
            });
          }, 2000);
        });
      });
    }
  });

  addTest({
    id: 'release', name: 'Releasing media resources', mode: 'playback',
    run: function (done) {
      unloadMedia(function () {
        probe(MP4_MED, null, function (r) {
          if (!r.ok) {
            unloadMedia(function () { });
            return done('fail', 'Media failed: ' + r.reason);
          }
          unloadMedia(function () {
            setTimeout(function () {
              var src = video.currentSrc || video.getAttribute('src') || '';
              var ready = video.readyState;
              var detail = 'currentSrc="' + src + '", readyState=' + ready;
              if (!src && ready === 0) done('pass', detail + ' — source released, engine reset.');
              else done('fail', detail + '. The engine kept the source after removal.');
            }, 600);
          });
        });
      });
    }
  });

  addTest({
    id: 'reopen', name: 'Repeated open and close', mode: 'playback',
    run: function (done) {
      var urls = [MP4_1080, MP4_720, MP4_MED];
      var index = 0;
      var failures = [];

      function step() {
        if (index >= urls.length) {
          var detail = failures.length ? 'Failures: ' + failures.join(' | ') :
            'Three sources opened, played and released in a row without error.';
          unloadMedia(function () { done(failures.length ? 'fail' : 'pass', detail); });
          return;
        }
        var url = urls[index];
        index++;
        unloadMedia(function () {
          probe(url, { waitMs: 10000 }, function (r) {
            if (!r.ok || !(r.playedTo > 0)) failures.push('#' + index + ' ' + (r.reason || 'no playback'));
            step();
          });
        });
      }
      step();
    }
  });

  /* --------------------------------------------------------------- controls */

  document.getElementById('run-auto').onclick = function () {
    var auto = [];
    for (var i = 0; i < tests.length; i++) {
      if (tests[i].mode === 'auto') auto.push(tests[i]);
    }
    chain = auto.slice();
    var first = chain.shift();
    start(first);
  };

  document.getElementById('run-all').onclick = function () {
    var auto = [];
    for (var i = 0; i < tests.length; i++) {
      if (tests[i].mode === 'auto' || tests[i].mode === 'playback') auto.push(tests[i]);
    }
    chain = auto.slice();
    start(chain.shift());
  };

  document.getElementById('reset').onclick = function () {
    for (var id in results) {
      if (results.hasOwnProperty(id)) setState(id, 'idle', '');
    }
    keyPanel.className = '';
    unloadMedia(function () { });
  };

  /* Keyboard support inside this page for remote-only devices. */
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode || 0;
    var buttons = document.getElementsByTagName('button');
    var focused = null;
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].className.indexOf('focused') >= 0) focused = buttons[i];
    }
    if (code === 40 || code === 38) {
      var index = -1;
      for (var j = 0; j < buttons.length; j++) {
        if (buttons[j] === focused) index = j;
      }
      index = code === 40 ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
      if (focused) focused.className = focused.className.replace(/\s*focused/g, '');
      buttons[index].className = buttons[index].className + ' focused';
      e.preventDefault();
    } else if (code === 13) {
      if (focused) {
        focused.click();
        e.preventDefault();
      } else if (buttons[0]) {
        buttons[0].className = buttons[0].className + ' focused';
      }
    }
  }, false);

})();
