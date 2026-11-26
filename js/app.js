/* CineVault TV — app.js
   Boot, screen router, the single global key handler, and the diagnostics
   overlay. One keydown listener for the whole application. */

var CV = window.CV || {};
window.CV = CV;

CV.health = { checked: false, provider: '', demo: false, ok: false, configured: false, missing: [] };

CV.app = (function () {

  var u = CV.util;
  var SCREENS = {
    home: 'view-home',
    search: 'view-search',
    live: 'view-live',
    library: 'view-library',
    details: 'view-details'
  };

  function providerLine() {
    if (!CV.health.checked) return 'Checking the content service...';
    if (!CV.health.ok) return 'The content service is unreachable right now.';
    if (CV.health.provider === 'moviebox') {
      if (!CV.health.configured) {
        return 'Provider: MovieBox, not configured on the server. Missing ' +
          (CV.health.missing && CV.health.missing.length ? CV.health.missing.join(', ') : 'server settings') + '.';
      }
      return 'Provider: MovieBox.' + (CV.health.ottEnabled ? '' : ' Platform filters are off (TMDB_API_KEY not set).');
    }
    if (CV.health.provider === 'fixture') {
      return 'Provider: fixture test data (CVTV_PROVIDER=fixture). Not a live catalogue.';
    }
    return 'Provider: ' + CV.health.provider;
  }

  function setFoot(text) {
    var node = u.byId('foot-provider');
    if (node) {
      node.innerHTML = '';
      node.appendChild(document.createTextNode(text));
    }
  }

  function footLabel() {
    if (!CV.health.checked) return 'Connecting...';
    if (!CV.health.ok) return 'Offline';
    if (!CV.health.configured) return 'Not configured';
    return CV.health.provider === 'fixture' ? 'Fixture data' : 'MovieBox';
  }

  function checkHealth(after) {
    CV.api.get('/api/health', null, function (err, data) {
      if (err) {
        CV.health = { checked: true, provider: '', demo: false, ok: false, configured: false, missing: [] };
        setFoot('Offline');
        if (after) after(err);
        return;
      }
      CV.health = {
        checked: true,
        provider: data.provider,
        demo: !!data.demo,
        ok: !!data.ok,
        configured: data.configured !== false,
        missing: data.missing || [],
        ottEnabled: !!data.ottEnabled
      };
      setFoot(footLabel());
      if (after) after(null, data);
    });
  }

  return {
    providerLine: providerLine,
    footLabel: footLabel,
    checkHealth: checkHealth,
    SCREENS: SCREENS
  };
})();

CV.router = (function () {

  var u = CV.util;
  var stack = ['home'];
  var libraryTab = null;

  function current() {
    return stack[stack.length - 1];
  }

  function show(name) {
    var k = u.keys(CV.app.SCREENS);
    for (var i = 0; i < k.length; i++) {
      var node = u.byId(CV.app.SCREENS[k[i]]);
      if (!node) continue;
      if (k[i] === name) u.removeClass(node, 'hidden');
      else u.addClass(node, 'hidden');
    }
    var navTarget = (name === 'details') ? null : name;
    var items = ['home', 'search', 'live', 'library'];
    for (var j = 0; j < items.length; j++) {
      var nav = u.byId('nav-' + items[j]);
      if (!nav) continue;
      if (items[j] === navTarget) u.addClass(nav, 'selected');
      else u.removeClass(nav, 'selected');
    }
  }

  function releaseDetails() {
    /* Details is rebuilt from the API every time it opens, so its nodes are
       dropped on the way out instead of being kept for an unknown "later". */
    var body = u.byId('details-body');
    if (body) u.clear(body);
  }

  function go(name, preferredTab) {
    CV.api.abortAll();
    CV.api.queueReset();
    if (CV.lazy) CV.lazy.cancelAll();
    if (current() === 'details') releaseDetails();
    if (name === 'library' && preferredTab) libraryTab = preferredTab;
    stack = [name];
    show(name);
    CV.focus.setScope(u.byId('app'));
    var preferred = null;

    if (name === 'home') {
      CV.home.mount();
      preferred = u.byId('nav-home');
    } else if (name === 'search') {
      CV.search.mount();
      preferred = u.byId('search-input');
    } else if (name === 'live') {
      CV.live.mount();
      preferred = u.byId('channel-search');
    } else if (name === 'library') {
      CV.library.mount(libraryTab);
      libraryTab = null;
      preferred = u.byId('nav-library');
    }
    if (preferred) CV.focus.focus(preferred);
    else CV.focus.focusFirst();
  }

  function openDetails(id, opts) {
    opts = opts || {};
    CV.api.abortAll();
    if (CV.lazy) CV.lazy.cancelAll();
    if (current() !== 'details') {
      stack.push('details');
    }
    show('details');
    CV.details.mount(id, null);
    CV.focus.setScope(u.byId('app'));
  }

  function back() {
    if (current() === 'details') {
      releaseDetails();
      stack.pop();
      var target = current();
      show(target);
      CV.focus.setScope(u.byId('app'));
      if (target === 'home') CV.home.mount();
      else if (target === 'search') CV.search.mount();
      else if (target === 'live') CV.live.mount();
      else if (target === 'library') CV.library.mount();
      return true;
    }
    if (current() !== 'home') {
      go('home');
      return true;
    }
    return false;
  }

  function refocusDetails() {
    CV.api.abortAll();
    if (current() !== 'details') return;
    CV.details.afterPlayback();
    var target = CV.details.focusTarget();
    CV.focus.setScope(u.byId('app'));
    if (target && u.indexOf(CV.focus.collect(), target) >= 0) {
      CV.focus.focus(target);
    } else {
      CV.focus.refresh();
    }
    CV.details.setFocusTarget(null);
  }

  function touchLibrary() {
    /* Watchlist changes are read from storage when Library mounts, so there
       is nothing to synchronise here. Kept as an explicit no-op hook. */
  }

  return {
    current: current,
    go: go,
    openDetails: openDetails,
    back: back,
    refocusDetails: refocusDetails,
    touchLibrary: touchLibrary,
    show: show
  };
})();

/* -------------------------------------------------------------------- diag */

CV.diag = (function () {

  var u = CV.util;
  var open = false;

  function isOpen() {
    return open;
  }

  function toggle(force) {
    open = force === undefined ? !open : !!force;
    u.show(u.byId('diag'), open);
    if (open) {
      document.body.setAttribute('data-diag', '1');
    } else {
      document.body.removeAttribute('data-diag');
    }
  }

  function record(code, e) {
    var raw = CV.keys.raw(e);
    var codeNode = u.byId('diag-code');
    if (codeNode) {
      codeNode.innerHTML = '';
      codeNode.appendChild(document.createTextNode('keyCode ' + raw.keyCode + '  ->  ' + (code || 'unmapped')));
    }
    var log = u.byId('diag-log');
    if (log) {
      var line = u.el('div', null, 'keyCode=' + raw.keyCode + '  key="' + raw.key + '"  code="' + raw.code + '"  mapped=' + (code || 'none'));
      log.insertBefore(line, log.firstChild);
      while (log.childNodes.length > 12) log.removeChild(log.lastChild);
    }
  }

  function handle(code, e) {
    record(code, e);
    if (code === 'back') {
      backCount++;
      if (backCount >= 3) {
        backCount = 0;
        toggle(false);
        CV.focus.refresh();
      }
      return;
    }
    backCount = 0;
  }

  var backCount = 0;

  return { isOpen: isOpen, toggle: toggle, handle: handle, record: record };
})();

/* ------------------------------------------------------------------- boot */

(function () {

  var u = CV.util;

  function activeInput() {
    var node = document.activeElement;
    if (!node) return false;
    var tag = node.tagName ? node.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function onKeyDown(e) {
    if (CV.osk && CV.osk.isOpen() && CV.osk.handleKey(e)) {
      u.stop(e);
      return;
    }

    var code = CV.keys.normalize(e);
    if (!code) return;

    if (CV.diag.isOpen()) {
      CV.diag.handle(code, e);
      u.stop(e);
      return;
    }

    if (CV.player.isOpen()) {
      CV.player.handle(code, e);
      u.stop(e);
      return;
    }

    if (CV.osk && CV.osk.isOpen()) {
      if (code === 'back') {
        CV.osk.close();
        u.stop(e);
        return;
      }
      if (code !== 'left' && code !== 'right' && code !== 'up' && code !== 'down' && code !== 'ok') {
        u.stop(e);
        return;
      }
    }

    if (activeInput()) {
      /* Let the television's own keyboard handle text entry. Arrows leave the
         field so the remote can reach the Search/Clear buttons. */
      if (code === 'left' || code === 'right' || code === 'up' || code === 'down') {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        if (CV.focus.move(code)) u.stop(e);
      }
      return;
    }

    if (code === 'back') {
      if (CV.router.back()) {
        u.stop(e);
        return;
      }
      u.stop(e);
      return;
    }

    if (code === 'left' || code === 'right' || code === 'up' || code === 'down') {
      if (CV.focus.move(code)) u.stop(e);
      return;
    }

    if (code === 'ok') {
      if (CV.focus.enter()) u.stop(e);
      return;
    }

    /* Physical media keys outside the player do nothing, by design: no
       accidental playback start from a stray button press. */
  }

  function wireNav() {
    var items = ['home', 'search', 'live', 'library'];
    for (var i = 0; i < items.length; i++) {
      (function (name) {
        var node = u.byId('nav-' + name);
        if (!node) return;
        node.setAttribute('data-enter', '1');
        u.on(node, 'click', function () { CV.router.go(name); });
        u.on(node, 'mouseover', function () {
          if (!CV.player.isOpen()) CV.focus.focus(node);
        });
      })(items[i]);
    }
  }

  function boot() {
    wireNav();
    CV.player.init();

    u.on(document, 'keydown', onKeyDown);

    /* Desktop convenience for development: 'd' toggles the key diagnostics. */
    u.on(document, 'keypress', function (e) {
      var ch = String.fromCharCode(e.charCode || e.keyCode || 0);
      if (ch === 'd' || ch === 'D') CV.diag.toggle();
    });

    var params = (window.location.search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < params.length; i++) {
      if (params[i].indexOf('diag=1') === 0) CV.diag.toggle(true);
    }

    u.on(window, 'online', function () { setFootAuto(); });
    u.on(window, 'offline', function () { setFootAuto(); });

    CV.router.go('home');
    CV.app.checkHealth(function (err) {
      if (err) {
        setFootAuto();
      } else {
        setFootAuto();
      }
    });
  }

  function setFootAuto() {
    if (navigator.onLine === false) {
      var node = u.byId('foot-provider');
      if (node) {
        node.innerHTML = '';
        node.appendChild(document.createTextNode('Offline'));
      }
      return;
    }
    var foot = u.byId('foot-provider');
    if (foot) {
      foot.innerHTML = '';
      foot.appendChild(document.createTextNode(CV.app.footLabel()));
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 0);
  } else {
    u.on(document, 'DOMContentLoaded', boot);
  }
})();
