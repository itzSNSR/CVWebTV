/* CineVault TV — lazy.js
   ES5 poster loader. No IntersectionObserver, no loading="lazy", no animation.

   - at most four image requests in flight
   - focused or visible cards load first
   - an image that fails falls back to the placeholder once and is never retried
   - every queued image is dropped when the screen changes
*/

var CV = window.CV || {};
window.CV = CV;

CV.lazy = (function () {

  var MAX_INFLIGHT = 4;
  var MARGIN = 220;          /* px below/above the viewport that still counts as "near" */

  var registry = [];         /* {img, url, state:'queued'|'loading'|'done'|'failed', priority} */
  var inflight = 0;
  var lastSweep = 0;
  var pendingTimer = null;
  var bound = false;

  function toQueue(img, url) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].img === img) return registry[i];
    }
    var entry = { img: img, url: url, state: 'queued', priority: 0 };
    registry.push(entry);
    img.setAttribute('data-src', url);
    return entry;
  }

  function rectNear(img) {
    if (!img || !img.getBoundingClientRect) return false;
    var r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;   /* hidden screen */
    var h = window.innerHeight || document.documentElement.clientHeight || 720;
    return r.bottom > -MARGIN && r.top < h + MARGIN;
  }

  function start(entry) {
    entry.state = 'loading';
    inflight++;
    var img = entry.img;

    img.onload = function () {
      finish(entry, true);
    };
    img.onerror = function () {
      finish(entry, false);
    };

    var url = entry.url;
    if (url.indexOf('//') === 0) url = 'https:' + url;
    img.src = url;
  }

  function finish(entry, ok) {
    entry.state = ok ? 'done' : 'failed';
    inflight--;
    if (!ok && entry.img) {
      entry.img.onerror = null;
      entry.img.onload = null;
      entry.img.src = CV.ui.PLACEHOLDER;
    }
    pump();
  }

  /** Starts queued images in priority order until the inflight budget is used. */
  function pump() {
    if (!registry.length) return;

    var ordered = registry.filter(function (e) { return e.state === 'queued'; });
    ordered.sort(function (a, b) {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return 0;
    });

    for (var i = 0; i < ordered.length && inflight < MAX_INFLIGHT; i++) {
      var entry = ordered[i];
      if (entry.priority > 0 || rectNear(entry.img)) {
        start(entry);
      }
    }
  }

  /** Called on scroll / resize / screen change; cheap enough to throttle. */
  function sweep(force) {
    var now = new Date().getTime();
    if (!force && now - lastSweep < 120) return;
    lastSweep = now;
    pump();
  }

  /**
   * Guarantees a sweep after the current tick. Adding twenty cards in a loop
   * must not lose the last eighteen to the throttle.
   */
  function schedule() {
    if (pendingTimer) return;
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      sweep(true);
    }, 140);
  }

  function bindGlobal() {
    if (bound) return;
    bound = true;
    /* One delegated listener for the app's lifetime: scroll events do not
       bubble, so capture is used to see .sbody scrolling too. */
    document.addEventListener('scroll', sweep, true);
    window.addEventListener('resize', sweep, false);
  }

  function add(img, url) {
    if (!img) return;
    bindGlobal();
    if (!url) {
      img.src = CV.ui.PLACEHOLDER;
      return;
    }
    var entry = toQueue(img, url);
    img.src = CV.ui.PLACEHOLDER;    /* static, no shimmer */
    sweep(true);
    schedule();
    return entry;
  }

  /** Focused cards jump the queue so the highlighted poster is always loaded. */
  function prioritize(node) {
    if (!node) return;
    var img = node.getElementsByTagName ? node.getElementsByTagName('img')[0] : null;
    if (!img) return;
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].img === img && registry[i].state === 'queued') {
        registry[i].priority = 1;
        break;
      }
    }
    sweep();
  }

  /** Drops everything queued. Images already loaded keep their pixels. */
  function cancelAll() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    for (var i = 0; i < registry.length; i++) {
      var e = registry[i];
      if (e.state === 'queued' && e.img) {
        e.img.onload = null;
        e.img.onerror = null;
      }
      e.img = null;
    }
    registry = [];
    inflight = 0;
  }

  return {
    add: add,
    prioritize: prioritize,
    cancelAll: cancelAll,
    sweep: sweep,
    stats: function () {
      var queued = 0;
      for (var i = 0; i < registry.length; i++) {
        if (registry[i].state === 'queued') queued++;
      }
      return { known: registry.length, queued: queued, inflight: inflight };
    }
  };
})();
