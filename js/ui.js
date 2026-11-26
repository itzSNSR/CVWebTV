/* CineVault TV — ui.js
   Static DOM builders. No animation, no inline SVG drawing, no transitions. */

var CV = window.CV || {};
window.CV = CV;

CV.ui = (function () {

  var u = CV.util;
  var PLACEHOLDER = 'assets/placeholder.svg';

  function posterImg(item, className) {
    var box = u.el('div', className);
    var img = u.el('img');
    img.alt = '';
    /* 2:3 logical size; CSS keeps the box and the image at the same ratio so
       nothing is stretched, and the browser has the aspect before the pixels
       arrive. */
    img.width = 300;
    img.height = 450;
    box.appendChild(img);
    CV.lazy.add(img, item.poster || '');
    return box;
  }

  function card(item, onActivate) {
    var node = u.el('div', 'card');
    node.setAttribute('data-id', item.id);
    node.setAttribute('role', 'button');

    node.appendChild(posterImg(item, 'poster'));

    var name = u.el('span', 'name', item.name || 'Untitled');
    node.appendChild(name);

    var meta = u.el('span', 'meta');
    if (item.year) meta.appendChild(u.el('span', null, item.year));
    if (item.isTvShow) {
      if (item.year) meta.appendChild(document.createTextNode(' \u00B7 '));
      meta.appendChild(u.el('span', null, 'Series'));
    } else if (item.duration) {
      if (item.year) meta.appendChild(document.createTextNode(' \u00B7 '));
      meta.appendChild(u.el('span', null, item.duration));
    }
    if (item.ott) {
      var badge = u.el('span', 'badge', item.ott);
      meta.insertBefore(badge, meta.firstChild);
    }
    node.appendChild(meta);

    if (onActivate) {
      u.on(node, 'click', function () { onActivate(item); });
      node.setAttribute('data-enter', '1');
    }
    return node;
  }

  function channelCard(channel, onActivate) {
    var node = u.el('div', 'card');
    node.setAttribute('data-id', channel.id);
    node.appendChild(posterImg({ poster: channel.logo }, 'poster'));
    node.appendChild(u.el('span', 'name', channel.name));
    var meta = u.el('span', 'meta');
    meta.appendChild(u.el('span', null, channel.category || 'General'));
    node.appendChild(meta);
    if (CV.favs.has(channel.id)) {
      var fav = u.el('span', 'badge', 'FAV');
      meta.insertBefore(fav, meta.firstChild);
    }
    if (onActivate) {
      u.on(node, 'click', function () { onActivate(channel); });
      node.setAttribute('data-enter', '1');
    }
    return node;
  }

  function chipFocused(node) {
    return u.hasClass(node, 'focused');
  }

  function chip(label, opts) {
    opts = opts || {};
    var node = u.el('span', 'chip', label);
    if (opts.on) node.className += ' on';
    if (opts.id) node.setAttribute('data-id', opts.id);
    if (opts.kind) node.setAttribute('data-kind', opts.kind);
    if (opts.onActivate) {
      u.on(node, 'click', opts.onActivate);
      node.setAttribute('data-enter', '1');
    }
    return node;
  }

  function button(label, opts) {
    opts = opts || {};
    var node = u.el('span', 'btn' + (opts.primary ? ' primary' : ''), label);
    if (opts.onActivate) {
      u.on(node, 'click', opts.onActivate);
      node.setAttribute('data-enter', '1');
    }
    return node;
  }

  function notice(message, opts) {
    opts = opts || {};
    var box = u.el('div', 'notice' + (opts.error ? ' error' : ''));
    box.appendChild(u.el('div', null, message));
    if (opts.actions && opts.actions.length) {
      var actions = u.el('div', 'actions');
      for (var i = 0; i < opts.actions.length; i++) {
        actions.appendChild(opts.actions[i]);
      }
      box.appendChild(actions);
    }
    return box;
  }

  function sectionTitle(text, count) {
    var node = u.el('div', 'row-title', text);
    if (count !== undefined && count !== null) {
      node.appendChild(u.el('span', 'count', '(' + count + ')'));
    }
    return node;
  }

  function row() {
    return u.el('div', 'row');
  }

  function loading(text) {
    return u.el('div', 'loading', text || 'Loading...');
  }

  /** Applies the visual focus state, and keeps exactly one focused node. */
  function focusNode(node) {
    var focused = document.querySelectorAll ? document.querySelectorAll('.focused') : [];
    for (var i = 0; i < focused.length; i++) {
      u.removeClass(focused[i], 'focused');
    }
    if (node) {
      u.addClass(node, 'focused');
      node.setAttribute('data-focused', '1');
    }
  }

  return {
    PLACEHOLDER: PLACEHOLDER,
    card: card,
    channelCard: channelCard,
    chip: chip,
    button: button,
    notice: notice,
    sectionTitle: sectionTitle,
    row: row,
    loading: loading,
    posterImg: posterImg,
    focusNode: focusNode,
    chipFocused: chipFocused
  };
})();
