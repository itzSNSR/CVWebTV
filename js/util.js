/* CineVault TV — util.js
   ES5 only. No arrow functions, no template literals, no modules. */

var CV = window.CV || {};
window.CV = CV;

CV.util = (function () {

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.appendChild(document.createTextNode(String(text)));
    return node;
  }

  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function on(node, event, fn) {
    if (!node) return;
    if (node.addEventListener) node.addEventListener(event, fn, false);
    else if (node.attachEvent) node.attachEvent('on' + event, fn);
  }

  function off(node, event, fn) {
    if (!node) return;
    if (node.removeEventListener) node.removeEventListener(event, fn, false);
    else if (node.detachEvent) node.detachEvent('on' + event, fn);
  }

  function stop(e) {
    if (!e) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    e.returnValue = false;
    return false;
  }

  function show(node, visible) {
    if (!node) return;
    if (visible) {
      if (node.className.indexOf('hidden') >= 0) {
        node.className = node.className.replace(/\s*hidden\s*/g, ' ');
      }
    } else if (node.className.indexOf('hidden') < 0) {
      node.className = node.className + ' hidden';
    }
  }

  function hasClass(node, cls) {
    return (' ' + node.className + ' ').indexOf(' ' + cls + ' ') >= 0;
  }

  function addClass(node, cls) {
    if (!hasClass(node, cls)) node.className = node.className ? node.className + ' ' + cls : cls;
  }

  function removeClass(node, cls) {
    node.className = (' ' + node.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }

  function formatTime(seconds) {
    var s = Math.floor(seconds || 0);
    if (s < 0) s = 0;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function trim(str) {
    return String(str === undefined || str === null ? '' : str).replace(/^\s+|\s+$/g, '');
  }

  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Object.keys replacement: some TV engines lack it. */
  function keys(obj) {
    var out = [];
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(k);
    }
    return out;
  }

  function indexOf(arr, item) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === item) return i;
    }
    return -1;
  }

  /** Queue that limits how many poster requests are in flight at once. */
  function Queue(limit) {
    this.limit = limit || 4;
    this.running = 0;
    this.waiting = [];
  }
  Queue.prototype.push = function (task) {
    this.waiting.push(task);
    this.next();
  };
  Queue.prototype.next = function () {
    var self = this;
    while (self.running < self.limit && self.waiting.length) {
      var task = self.waiting.shift();
      self.running++;
      task(function () {
        self.running--;
        self.next();
      });
    }
  };
  Queue.prototype.clear = function () {
    this.waiting = [];
  };

  return {
    byId: byId,
    el: el,
    clear: clear,
    on: on,
    off: off,
    stop: stop,
    show: show,
    hasClass: hasClass,
    addClass: addClass,
    removeClass: removeClass,
    formatTime: formatTime,
    trim: trim,
    escapeHtml: escapeHtml,
    keys: keys,
    indexOf: indexOf,
    Queue: Queue
  };
})();
