/* CineVault TV — navigation.js
   Central remote-control key mapping + a geometry based focus engine.
   Geometry means grids, rows and the sidebar all work without per-screen
   wiring, and focus can never land on a hidden or unloaded element. */

var CV = window.CV || {};
window.CV = CV;

CV.keys = (function () {

  var BY_CODE = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'ok', 32: 'playpause',
    8: 'back', 27: 'back', 461: 'back', 10009: 'back',
    415: 'play', 19: 'pause', 179: 'playpause', 10252: 'playpause',
    417: 'ff', 412: 'rew', 413: 'stop',
    427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown'
  };

  var BY_NAME = {
    ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down',
    Left: 'left', Up: 'up', Right: 'right', Down: 'down',
    Enter: 'ok', Accept: 'ok',
    GoBack: 'back', Back: 'back', BrowserBack: 'back', Escape: 'back', Backspace: 'back',
    MediaPlay: 'play', MediaPause: 'pause', MediaPlayPause: 'playpause',
    MediaFastForward: 'ff', MediaRewind: 'rew', MediaStop: 'stop',
    ChannelUp: 'chup', ChannelDown: 'chdown'
  };

  function normalize(e) {
    if (!e) return null;
    var code = e.keyCode || e.which || 0;
    var named = e.key || e.code || '';
    if (named && BY_NAME[named]) return BY_NAME[named];
    if (BY_CODE[code]) return BY_CODE[code];
    return null;
  }

  function raw(e) {
    return {
      keyCode: e.keyCode || e.which || 0,
      key: e.key || '',
      code: e.code || ''
    };
  }

  return { normalize: normalize, raw: raw, BY_CODE: BY_CODE, BY_NAME: BY_NAME };
})();

CV.focus = (function () {

  var u = CV.util;
  var scope = null;
  var node = null;

  function isFocusable(el) {
    return el && el.getAttribute && el.getAttribute('data-enter') === '1';
  }

  function hidden(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return true;
    var parent = el;
    while (parent && parent.nodeType === 1) {
      if (u.hasClass(parent, 'hidden')) return true;
      var style = parent.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      parent = parent.parentNode;
    }
    return false;
  }

  function collect() {
    var out = [];
    if (!scope) return out;
    var all = scope.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (isFocusable(all[i]) && !hidden(all[i])) out.push(all[i]);
    }
    return out;
  }

  function setScope(container, preferred) {
    scope = container || u.byId('app');
    node = null;
    var list = collect();
    if (!list.length) {
      CV.ui.focusNode(null);
      return;
    }
    var target = null;
    if (preferred && preferred.getAttribute && isFocusable(preferred) && !hidden(preferred)) {
      target = preferred;
    }
    if (!target) target = list[0];
    focus(target);
  }

  function refresh(preferred) {
    var list = collect();
    if (!list.length) {
      node = null;
      CV.ui.focusNode(null);
      return;
    }
    var target = null;
    if (preferred && u.indexOf(list, preferred) >= 0) target = preferred;
    else if (node && u.indexOf(list, node) >= 0) target = node;
    else target = list[0];
    focus(target);
  }

  function focus(target) {
    node = target;
    CV.ui.focusNode(target);
    scrollIntoView(target);
    if (CV.lazy) CV.lazy.prioritize(target);
  }

  function scrollIntoView(target) {
    var box = target;
    var container = null;
    while (box && box.nodeType === 1) {
      if (u.hasClass(box, 'sbody')) {
        container = box;
        break;
      }
      box = box.parentNode;
    }
    if (!container) return;
    var cr = container.getBoundingClientRect();
    var nr = target.getBoundingClientRect();
    var pad = 12;
    if (nr.top < cr.top + pad) {
      container.scrollTop = container.scrollTop - (cr.top + pad - nr.top);
    } else if (nr.bottom > cr.bottom - pad) {
      container.scrollTop = container.scrollTop + (nr.bottom - (cr.bottom - pad));
    }
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return {
      node: el,
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      cx: (r.left + r.right) / 2,
      cy: (r.top + r.bottom) / 2
    };
  }

  /**
   * Move focus in one direction, choosing the nearest candidate whose centre
   * lies in that half-plane. Primary axis distance counts once, the
   * perpendicular offset counts 2.5x, so a grid row is preferred over a
   * diagonal jump into the next section.
   */
  function move(dir) {
    var list = collect();
    if (!list.length) return false;
    if (!node || u.indexOf(list, node) < 0) {
      focus(list[0]);
      return true;
    }

    var current = rectOf(node);
    var best = null;
    var bestScore = 0;

    for (var i = 0; i < list.length; i++) {
      if (list[i] === node) continue;
      var c = rectOf(list[i]);
      var primary = 0;
      var secondary = 0;

      if (dir === 'right') {
        if (c.cx <= current.cx + 3) continue;
        primary = c.cx - current.cx;
        secondary = Math.abs(c.cy - current.cy);
      } else if (dir === 'left') {
        if (c.cx >= current.cx - 3) continue;
        primary = current.cx - c.cx;
        secondary = Math.abs(c.cy - current.cy);
      } else if (dir === 'down') {
        if (c.cy <= current.cy + 3) continue;
        primary = c.cy - current.cy;
        secondary = Math.abs(c.cx - current.cx);
      } else if (dir === 'up') {
        if (c.cy >= current.cy - 3) continue;
        primary = current.cy - c.cy;
        secondary = Math.abs(c.cx - current.cx);
      } else {
        return false;
      }

      var score = primary + secondary * 2.5;
      if (best === null || score < bestScore) {
        best = c.node;
        bestScore = score;
      }
    }

    if (!best) return false;
    focus(best);
    return true;
  }

  function enter() {
    if (!node) return false;
    if (node.click) {
      node.click();
      return true;
    }
    return false;
  }

  function current() {
    return node;
  }

  function focusFirst() {
    var list = collect();
    if (list.length) focus(list[0]);
  }

  function scopeIs(elm) {
    return elm === scope;
  }

  return {
    scopeIs: scopeIs,
    setScope: setScope,
    refresh: refresh,
    focus: focus,
    move: move,
    enter: enter,
    current: current,
    focusFirst: focusFirst,
    collect: collect,
    scrollIntoView: scrollIntoView
  };
})();
