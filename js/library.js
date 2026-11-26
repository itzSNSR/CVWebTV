/* CineVault TV — library.js
   Continue Watching (six slots), Watchlist, Settings, About. Local only. */

var CV = window.CV || {};
window.CV = CV;

CV.library = (function () {

  var u = CV.util;
  var tab = 'resume';

  var TABS = [
    { id: 'resume', label: 'Continue Watching' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'settings', label: 'Settings' },
    { id: 'about', label: 'About' }
  ];

  function mount(preferredTab) {
    if (preferredTab) tab = preferredTab;
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    var host = u.byId('library-filters');
    u.clear(host);
    for (var i = 0; i < TABS.length; i++) {
      host.appendChild(CV.ui.chip(TABS[i].label, {
        id: TABS[i].id,
        on: tab === TABS[i].id,
        onActivate: pickTab(TABS[i].id)
      }));
    }
  }

  function pickTab(id) {
    return function () {
      if (tab === id) return;
      tab = id;
      renderTabs();
      renderBody();
      CV.focus.refresh();
    };
  }

  function renderBody() {
    var body = u.clear(u.byId('library-body'));
    if (tab === 'resume') renderResume(body);
    else if (tab === 'watchlist') renderWatchlist(body);
    else if (tab === 'settings') renderSettings(body);
    else renderAbout(body);
  }

  /* ------------------------------------------------------ continue watching */

  function renderResume(body) {
    var list = CV.resume.list();
    if (!list.length) {
      body.appendChild(CV.ui.notice('Nothing in Continue Watching yet. Play something and it will appear here.',
        { actions: [CV.ui.button('Browse Home', { onActivate: function () { CV.router.go('home'); } })] }));
      return;
    }
    body.appendChild(u.el('div', 'group-title first', 'Continue Watching (' + list.length + ' of ' + CV.resume.LIMIT + ')'));
    for (var i = 0; i < list.length; i++) {
      body.appendChild(resumeRow(list[i]));
    }
  }

  function resumeRow(entry) {
    var row = u.el('div', 'lib-row');
    row.setAttribute('data-enter', '1');
    row.setAttribute('data-id', entry.id);

    var thumb = u.el('div', 'thumb');
    var img = u.el('img');
    img.alt = '';
    thumb.appendChild(img);
    CV.lazy.add(img, entry.poster || '');
    row.appendChild(thumb);

    var info = u.el('div', 'info');
    info.appendChild(u.el('span', 't', entry.title));
    var sub = entry.type === 'series'
      ? ('S' + (entry.season || 1) + ' E' + (entry.episode || 1) + '  \u00B7  ' + u.formatTime(entry.time))
      : ('Resume at ' + u.formatTime(entry.time));
    info.appendChild(u.el('span', 's', sub));
    row.appendChild(info);

    var pct = entry.duration > 0 ? Math.round((entry.time / entry.duration) * 100) : 0;
    row.appendChild(u.el('span', 'pct', pct + '%'));

    u.on(row, 'click', function () {
      CV.router.openDetails(entry.id, { resume: true });
    });
    return row;
  }

  /* ------------------------------------------------------------- watchlist */

  function renderWatchlist(body) {
    var list = CV.watchlist.list();
    if (!list.length) {
      body.appendChild(CV.ui.notice('Watchlist is empty. Open a title and choose Add to Watchlist.'));
      return;
    }
    body.appendChild(u.el('div', 'group-title first', 'Watchlist (' + list.length + ' of ' + CV.watchlist.LIMIT + ')'));
    for (var i = 0; i < list.length; i++) {
      body.appendChild(watchRow(list[i]));
    }
  }

  function watchRow(item) {
    var row = u.el('div', 'lib-row');
    row.setAttribute('data-enter', '1');

    var thumb = u.el('div', 'thumb');
    var img = u.el('img');
    img.alt = '';
    thumb.appendChild(img);
    CV.lazy.add(img, item.poster || '');
    row.appendChild(thumb);

    var info = u.el('div', 'info');
    info.appendChild(u.el('span', 't', item.name));
    info.appendChild(u.el('span', 's', (item.year || '') + (item.isTvShow ? '  \u00B7  Series' : '  \u00B7  Movie')));
    row.appendChild(info);

    u.on(row, 'click', function () { CV.router.openDetails(item.id); });
    return row;
  }

  /* -------------------------------------------------------------- settings */

  function renderSettings(body) {
    body.appendChild(u.el('div', 'group-title first', 'Playback'));
    body.appendChild(settingRow('pref-quality', 'Preferred quality', CV.prefs.get('quality'), function () {
      cyclePref('quality', ['1080p', '720p', '480p', '360p']);
    }));
    body.appendChild(settingRow('pref-sublang', 'Subtitle language', CV.prefs.get('subtitleLang'), function () {
      cyclePref('subtitleLang', ['English', 'Malayalam', 'Tamil', 'Hindi', 'Off']);
    }));
    body.appendChild(settingRow('pref-subsize', 'Subtitle size', CV.prefs.get('subtitleSize'), function () {
      cyclePref('subtitleSize', ['Small', 'Medium', 'Large']);
    }));

    body.appendChild(u.el('div', 'group-title', 'Local data'));
    body.appendChild(settingRow('clear-resume', 'Clear Continue Watching', CV.resume.list().length + ' saved', function () {
      CV.resume.clear();
      renderBody();
      CV.focus.refresh();
    }));
    body.appendChild(settingRow('clear-watch', 'Clear Watchlist', CV.watchlist.list().length + ' saved', function () {
      CV.watchlist.clear();
      renderBody();
      CV.focus.refresh();
    }));
    body.appendChild(settingRow('clear-favs', 'Clear Live TV Favourites', CV.favs.list().length + ' saved', function () {
      CV.favs.clear();
      renderBody();
      CV.focus.refresh();
    }));
    body.appendChild(settingRow('clear-all', 'Clear All Local Data', 'Everything', function () {
      CV.resume.clear();
      CV.watchlist.clear();
      CV.favs.clear();
      CV.store.clearAll();
      renderTabs();
      renderBody();
      CV.focus.refresh();
    }));

    body.appendChild(u.el('div', 'group-title', 'Information'));
    body.appendChild(settingRow('about', 'About CineVault TV', 'Version 1.0', function () {
      pickTab('about')();
    }));
  }

  function cyclePref(key, values) {
    var current = CV.prefs.get(key);
    var next = values[(u.indexOf(values, current) + 1) % values.length];
    CV.prefs.set(key, next);
    CV.subs.setSize(CV.prefs.get('subtitleSize'));
    renderBody();
    CV.focus.refresh();
  }

  function settingRow(id, label, value, action) {
    var row = u.el('div', 'lib-row');
    row.setAttribute('data-enter', '1');
    row.setAttribute('data-setting', id);

    var info = u.el('div', 'info');
    info.style.width = '70%';
    info.appendChild(u.el('span', 't', label));
    row.appendChild(info);
    row.appendChild(u.el('span', 'pct', value));

    u.on(row, 'click', action);
    return row;
  }

  /* ----------------------------------------------------------------- about */

  function renderAbout(body) {
    var box = u.el('div');
    box.appendChild(u.el('div', 'group-title first', 'CineVault TV 1.0'));
    box.appendChild(u.el('div', 'detail-desc',
      'A lightweight television edition of CineVault for older Smart TVs. ' +
      'Plain HTML, CSS and ES5 JavaScript with one native video element. ' +
      'No framework, no player library, no download manager, no account.'));

    var facts = [
      ['Storage', CV.store.available ? 'LocalStorage available' : 'LocalStorage unavailable (session only)'],
      ['Continue Watching', CV.resume.list().length + ' of ' + CV.resume.LIMIT + ' slots used'],
      ['Watchlist', CV.watchlist.list().length + ' of ' + CV.watchlist.LIMIT + ' items'],
      ['Live TV favourites', CV.favs.list().length + ' channels'],
      ['Preferred quality', CV.prefs.get('quality')],
      ['Subtitle language', CV.prefs.get('subtitleLang')]
    ];
    for (var i = 0; i < facts.length; i++) {
      box.appendChild(settingRow('fact' + i, facts[i][0], facts[i][1], function () {}));
    }

    box.appendChild(u.el('div', 'group-title', 'Provider'));
    box.appendChild(u.el('div', 'detail-desc', CV.app.providerLine()));

    body.appendChild(box);
  }

  return { mount: mount, openTab: pickTab };
})();
