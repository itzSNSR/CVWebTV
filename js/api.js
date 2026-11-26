/* CineVault TV — api.js
   XMLHttpRequest only (no fetch): older TV engines either lack fetch or
   implement it badly. Every request is abortable and timed out. */

var CV = window.CV || {};
window.CV = CV;

CV.api = (function () {

  var BASE = (window.CVTV_API_BASE || '').replace(/\/+$/, '');
  var TIMEOUT = 14000;
  var pending = [];
  var imageQueue = new CV.util.Queue(4);

  function buildUrl(path, params) {
    var url = BASE + path;
    var parts = [];
    if (params) {
      var k = CV.util.keys(params);
      for (var i = 0; i < k.length; i++) {
        var v = params[k[i]];
        if (v === undefined || v === null || v === '') continue;
        parts.push(encodeURIComponent(k[i]) + '=' + encodeURIComponent(v));
      }
    }
    if (parts.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
    return url;
  }

  /**
   * @param path    '/api/home'
   * @param params  query object (may be null)
   * @param cb      function (err, data)
   */
  function get(path, params, cb) {
    var xhr = new XMLHttpRequest();
    var done = false;
    var timer = null;

    function finish(err, data) {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (var i = 0; i < pending.length; i++) {
        if (pending[i] === xhr) {
          pending.splice(i, 1);
          break;
        }
      }
      cb(err, data);
    }

    try {
      xhr.open('GET', buildUrl(path, params), true);
    } catch (e) {
      return cb({ code: 'network', message: 'Network unavailable' });
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 0) {
        return finish({ code: 'network', message: 'No internet connection.' });
      }
      var payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (e) {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload) {
        return finish(null, payload);
      }
      var err = (payload && payload.error) || {};
      finish({
        code: err.code || ('http_' + xhr.status),
        message: err.message || messageForStatus(xhr.status),
        missing: err.missing || null,
        status: xhr.status
      });
    };

    xhr.onerror = function () {
      finish({ code: 'network', message: 'No internet connection.' });
    };

    timer = setTimeout(function () {
      timer = null;
      try { xhr.abort(); } catch (e) { /* ignore */ }
      finish({ code: 'timeout', message: 'The server did not answer in time.' });
    }, TIMEOUT);

    pending.push(xhr);
    try {
      xhr.send(null);
    } catch (e) {
      finish({ code: 'network', message: 'No internet connection.' });
    }
  }

  function messageForStatus(status) {
    if (status === 404) return 'Not found.';
    if (status === 429) return 'Too many requests. Wait a moment.';
    if (status === 503) return 'The content service is not configured.';
    if (status >= 500) return 'The content service is unavailable right now.';
    return 'Request failed.';
  }

  /**
   * Absolute-ises a URL coming from the backend. Providers may return
   * "media/subs/x.vtt" or "/media/subs/x.vtt"; both must work whether the
   * frontend is served by the backend or from a separate static host.
   */
  function resolvePath(path) {
    if (!path) return path;
    if (/^https?:\/\//i.test(path) || path.indexOf('//') === 0) return path;
    if (!BASE) return path;
    return BASE + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function abortAll() {    var list = pending.slice(0);
    pending.length = 0;
    for (var i = 0; i < list.length; i++) {
      try { list[i].abort(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Poster loading, at most four at a time so the TV's network stack is not
   * flooded. Falls back to a static placeholder on error, never to a spinner.
   */
  function image(node, src, fallback) {
    if (!src) {
      if (fallback) node.src = fallback;
      return;
    }
    imageQueue.push(function (release) {
      var probe = new Image();
      probe.onload = function () {
        node.src = src;
        release();
      };
      probe.onerror = function () {
        if (fallback) node.src = fallback;
        release();
      };
      probe.src = src;
    });
  }

  return {
    get: get,
    image: image,
    abortAll: abortAll,
    resolvePath: resolvePath,
    buildUrl: buildUrl,
    queueReset: function () { imageQueue = new CV.util.Queue(4); }
  };
})();
