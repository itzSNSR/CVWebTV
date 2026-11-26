/* CineVault TV — osk.js
   Remote-controlled on-screen keyboard for the Search screen. Every key is a
   focusable node, so the existing arrow/OK engine handles it without any
   special remote key codes. */

var CV = window.CV || {};
window.CV = CV;

CV.osk = (function () {

  var u = CV.util;
  var overlay = null;
  var valueNode = null;
  var callbacks = {};
  var query = '';
  var openFlag = false;
  var MAX_LENGTH = 60;

  var KEYS = [
    'A', 'B', 'C', 'D', 'E', 'F',
    'G', 'H', 'I', 'J', 'K', 'L',
    'M', 'N', 'O', 'P', 'Q', 'R',
    'S', 'T', 'U', 'V', 'W', 'X',
    'Y', 'Z', '0', '1', '2', '3',
    '4', '5', '6', '7', '8', '9'
  ];

  function paint() {
    if (!valueNode) return;
    u.clear(valueNode);
    valueNode.appendChild(u.el('span', query ? '' : 'placeholder', query || 'Type a title...'));
  }

  function type(character) {
    if (query.length >= MAX_LENGTH) return;
    query += character;
    paint();
  }

  function backspace() {
    query = query.slice(0, -1);
    paint();
  }

  function clear() {
    query = '';
    paint();
  }

  function key(label, character) {
    var node = u.el('span', 'osk-key', label);
    node.setAttribute('data-enter', '1');
    u.on(node, 'click', function () { type(character); });
    return node;
  }

  function action(label, extraClass, handler) {
    var node = u.el('span', 'osk-key osk-action' + (extraClass ? ' ' + extraClass : ''), label);
    node.setAttribute('data-enter', '1');
    u.on(node, 'click', handler);
    return node;
  }

  function build() {
    if (overlay) return;

    overlay = u.el('div', 'hidden');
    overlay.id = 'osk';

    var panel = u.el('div', 'osk-panel');
    var head = u.el('div', 'osk-head');
    head.appendChild(u.el('div', 'osk-title', 'Search keyboard'));
    head.appendChild(u.el('div', 'osk-hint', 'Arrows move \u00B7 OK type \u00B7 Back close'));
    panel.appendChild(head);

    valueNode = u.el('div', 'osk-value');
    panel.appendChild(valueNode);

    var grid = u.el('div', 'osk-grid');
    for (var i = 0; i < KEYS.length; i++) {
      grid.appendChild(key(KEYS[i], KEYS[i]));
    }
    panel.appendChild(grid);

    var actions = u.el('div', 'osk-actions');
    actions.appendChild(action('Space', 'osk-space', function () { type(' '); }));
    actions.appendChild(action("'", 'osk-small', function () { type("'"); }));
    actions.appendChild(action('-', 'osk-small', function () { type('-'); }));
    actions.appendChild(action('Backspace', 'osk-back', backspace));
    actions.appendChild(action('Clear', 'osk-clear', clear));
    actions.appendChild(action('Search', 'osk-search primary', submit));
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function submit() {
    var handler = callbacks.onSearch;
    var text = u.trim(query);
    close();
    if (handler) handler(text);
  }

  function open(options) {
    build();
    callbacks = options || {};
    query = String(callbacks.value || '');
    openFlag = true;
    paint();
    u.show(overlay, true);
    if (callbacks.input && callbacks.input.blur) callbacks.input.blur();
    CV.focus.setScope(overlay);
  }

  function close() {
    if (!openFlag) return;
    openFlag = false;
    u.show(overlay, false);

    var text = query;
    var input = callbacks.input;
    var onClose = callbacks.onClose;
    callbacks = {};
    if (input) input.value = text;
    if (onClose) onClose(text);

    CV.focus.setScope(u.byId('app'));
    if (input) CV.focus.focus(input);
  }

  function isOpen() {
    return openFlag;
  }

  /* Physical keyboards still work while the OSK is open: printable keys
     append. Back/Backspace is left to app.js so every TV Back key code
     closes the keyboard; the on-screen Backspace key edits the text. */
  function handleKey(e) {
    if (!openFlag || e.ctrlKey || e.metaKey || e.altKey) return false;
    var key = e.key;
    if (key && key.length === 1) {
      type(key);
      return true;
    }
    return false;
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    handleKey: handleKey
  };
})();
