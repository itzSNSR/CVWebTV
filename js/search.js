/* CineVault TV — search.js
   Movies and series only. The query is submitted when the user confirms,
   never on every keystroke. */

var CV = window.CV || {};
window.CV = CV;

CV.search = (function () {

  var u = CV.util;
  var query = '';
  var lastResults = null;

  function build() {
    if (CV.osk && CV.osk.isOpen()) CV.osk.close();
    var host = u.byId('search-filters');
    u.clear(host);

    var input = u.el('input', 'text-input');
    input.id = 'search-input';
    input.type = 'text';
    input.setAttribute('placeholder', 'Title name');
    input.setAttribute('autocomplete', 'off');
    input.value = query;
    input.setAttribute('data-enter', '1');
    input.setAttribute('inputmode', 'text');

    u.on(input, 'click', function () { openKeyboard(input); });
    u.on(input, 'keydown', function (e) {
      var code = CV.keys.normalize(e);
      if (code === 'ok') {
        openKeyboard(input);
        u.stop(e);
      } else if (code === 'back') {
        var raw = CV.keys.raw(e);
        // A keyboard Backspace edits the field; the remote Back key leaves.
        if (raw.keyCode === 8 || raw.key === 'Backspace') return;
        CV.router.back();
        u.stop(e);
      }
    });
    host.appendChild(input);

    host.appendChild(CV.ui.button('Search', {
      primary: true,
      onActivate: function () { submit(input.value); }
    }));

    host.appendChild(CV.ui.button('Clear', {
      onActivate: function () {
        query = '';
        input.value = '';
        lastResults = null;
        u.clear(u.byId('search-body')).appendChild(
          u.el('div', 'notice', 'Open the on-screen keyboard to enter a title.')
        );
        CV.focus.focus(input);
      }
    }));

    CV.focus.focus(host.firstChild);
  }

  function openKeyboard(input) {
    if (!CV.osk) return;
    CV.osk.open({
      value: input.value,
      input: input,
      onClose: function (text) {
        query = u.trim(text);
      },
      onSearch: function (text) {
        submit(text);
      }
    });
  }

  function submit(text) {
    query = u.trim(text === undefined ? query : text);
    var input = u.byId('search-input');
    if (input) input.value = query;
    run();
  }

  function run() {
    var body = u.byId('search-body');
    if (!query) {
      u.clear(body).appendChild(u.el('div', 'notice', 'Enter a title name first.'));
      CV.focus.refresh();
      return;
    }
    u.clear(body).appendChild(CV.ui.loading('Searching...'));

    CV.api.get('/api/search', { q: query }, function (err, data) {
      if (err) {
        u.clear(body).appendChild(CV.ui.notice(err.message || 'Search failed.', {
          error: true,
          actions: [CV.ui.button('Retry', { primary: true, onActivate: run })]
        }));
        CV.focus.refresh();
        return;
      }
      var items = data.items || [];
      lastResults = items;
      if (!items.length) {
        u.clear(body).appendChild(CV.ui.notice('No results found for "' + query + '".'));
        CV.focus.refresh();
        return;
      }
      u.clear(body).appendChild(CV.ui.sectionTitle('Results for "' + query + '"', items.length));
      var row = CV.ui.row();
      for (var i = 0; i < items.length; i++) {
        row.appendChild(CV.ui.card(items[i], function (item) {
          CV.router.openDetails(item.id);
        }));
      }
      body.appendChild(row);
      CV.focus.refresh();
    });
  }

  function mount() {
    build();
    var body = u.byId('search-body');
    if (lastResults) {
      /* keep results on return, do not re-query */
      CV.focus.refresh();
    } else if (!body.firstChild) {
      u.clear(body).appendChild(u.el('div', 'notice', 'Open the on-screen keyboard to enter a title.'));
    }
  }

  return { mount: mount, run: run, submit: submit, openKeyboard: openKeyboard };
})();
