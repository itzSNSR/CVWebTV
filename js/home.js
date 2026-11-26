/* CineVault TV — home.js
   Real catalogue only. One request per filter change, plus one more when the
   viewer asks for the next page. Nothing is preloaded, nothing polls. */

var CV = window.CV || {};
window.CV = CV;

CV.home = (function () {

  var u = CV.util;
  var state = { type: 'all', ott: '', page: 1, loading: false, hasMore: false, sections: [] };

  var OTT = [
    { id: '', label: 'All platforms' },
    { id: 'netflix', label: 'Netflix' },
    { id: 'prime', label: 'Prime Video' },
    { id: 'hotstar', label: 'JioHotstar' },
    { id: 'appletv', label: 'Apple TV+' }
  ];

  var TYPES = [
    { id: 'all', label: 'All' },
    { id: 'movies', label: 'Movies' },
    { id: 'series', label: 'Series' }
  ];

  function renderFilters() {
    var host = u.byId('home-filters');
    u.clear(host);

    var i;
    for (i = 0; i < OTT.length; i++) {
      host.appendChild(CV.ui.chip(OTT[i].label, {
        id: OTT[i].id,
        on: state.ott === OTT[i].id,
        onActivate: pickOtt(OTT[i].id)
      }));
    }
    for (i = 0; i < TYPES.length; i++) {
      host.appendChild(CV.ui.chip(TYPES[i].label, {
        id: TYPES[i].id,
        kind: 'type',
        on: state.type === TYPES[i].id,
        onActivate: pickType(TYPES[i].id)
      }));
    }
  }

  function pickOtt(value) {
    return function () {
      if (state.ott === value) return;
      state.ott = value;
      renderFilters();
      load(true);
    };
  }

  function pickType(value) {
    return function () {
      if (state.type === value) return;
      state.type = value;
      renderFilters();
      load(true);
    };
  }

  function load(reset) {
    var body = u.byId('home-body');
    if (reset) state.page = 1;
    state.loading = true;
    if (reset) u.clear(body).appendChild(CV.ui.loading('Loading...'));

    CV.api.get('/api/home', { type: state.type, ott: state.ott, page: state.page },
      function (err, data) {
        state.loading = false;
        if (err) {
          renderError(err);
          return;
        }
        state.hasMore = !!data.hasMore;
        if (reset) state.sections = data.sections || [];
        else state.sections = mergeSections(state.sections, data.sections || []);
        render(data);
      });
  }

  /** Appends the next page into the existing rows instead of duplicating them. */
  function mergeSections(existing, incoming) {
    var out = existing.slice(0);
    incoming.forEach(function (section) {
      var found = null;
      for (var i = 0; i < out.length; i++) {
        if (out[i].id === section.id) found = out[i];
      }
      if (!found) {
        out.push(section);
        return;
      }
      var seen = {};
      found.items.forEach(function (c) { seen[c.id] = true; });
      section.items.forEach(function (c) {
        if (!seen[c.id]) found.items.push(c);
      });
    });
    return out;
  }

  function renderError(err) {
    var body = u.clear(u.byId('home-body'));
    var note = u.byId('home-note');
    note.innerHTML = '';

    var message = err.message || 'Unable to load the catalogue.';
    var actions = [CV.ui.button('Retry', { primary: true, onActivate: function () { load(true); } })];

    if (err.code === 'provider_not_configured') {
      message = 'MovieBox is not configured on this server. ' +
        'Set ' + ((err.missing && err.missing.join(' and ')) || 'MOVIEBOX_BASE_URL and MOVIEBOX_APP_KEY') +
        ' and restart the backend.';
      actions.push(CV.ui.button('Live TV', {
        onActivate: function () { CV.router.go('live'); }
      }));
    } else if (err.code === 'provider_unauthorized') {
      message = 'MovieBox refused the request. The configured access is not authorised for this content.';
    } else if (err.code === 'empty_catalogue') {
      message = 'MovieBox returned no titles for this filter.';
    }

    body.appendChild(CV.ui.notice(message, { error: true, actions: actions }));
    CV.focus.refresh();
  }

  function render(data) {
    var body = u.clear(u.byId('home-body'));
    var note = u.byId('home-note');
    note.innerHTML = '';

    if (data.ottUnavailable) {
      note.appendChild(document.createTextNode(data.ottUnavailable));
    }

    var sections = state.sections;
    var rendered = 0;

    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var items = section.items || [];
      if (!items.length) continue;

      body.appendChild(CV.ui.sectionTitle(section.title, items.length));

      var row = CV.ui.row();
      for (var j = 0; j < items.length; j++) {
        row.appendChild(CV.ui.card(items[j], openItem));
      }
      body.appendChild(row);
      rendered++;
    }

    if (!rendered) {
      body.appendChild(CV.ui.notice('No titles match this filter.', {
        actions: [CV.ui.button('Show everything', {
          primary: true,
          onActivate: function () {
            state.ott = '';
            state.type = 'all';
            renderFilters();
            load(true);
          }
        })]
      }));
    } else if (state.hasMore) {
      var moreRow = u.el('div');
      moreRow.style.padding = '0.5rem 0 1rem 0';
      moreRow.appendChild(CV.ui.button('More titles', {
        onActivate: function () {
          if (state.loading) return;
          state.page++;
          load(false);
        }
      }));
      body.appendChild(moreRow);
    }

    CV.focus.refresh();
  }

  function openItem(item) {
    CV.router.openDetails(item.id);
  }

  function mount() {
    renderFilters();
    if (!state.sections.length) {
      load(true);
    } else {
      CV.focus.refresh();
    }
  }

  function reset() {
    state.sections = [];
    state.page = 1;
  }

  return { mount: mount, load: load, reset: reset, openItem: openItem };
})();
