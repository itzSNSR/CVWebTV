/* CineVault TV — live-tv.js
   Channel catalogue, its own search, country + category filters, favourites.
   Nothing plays until the viewer picks a channel. */

var CV = window.CV || {};
window.CV = CV;

CV.live = (function () {

  var u = CV.util;
  var state = {
    country: 'ALL',
    category: 'All',
    query: '',
    countries: [],
    categories: [],
    channels: [],
    loaded: false
  };

  function mount() {
    buildHead();
    if (!state.loaded) load();
    else {
      render();
      CV.focus.refresh();
    }
  }

  function buildHead() {
    var head = u.byId('live-head');
    u.clear(head);

    head.appendChild(u.el('span', 'screen-title', 'Live TV'));

    var input = u.el('input', 'text-input');
    input.id = 'channel-search';
    input.type = 'text';
    input.setAttribute('placeholder', 'Search channels');
    input.setAttribute('data-enter', '1');
    input.value = state.query;
    input.style.marginLeft = '1.25rem';
    u.on(input, 'click', function () { input.focus(); });
    var onText = function () {
      state.query = u.trim(input.value);
      renderChannels();
    };
    u.on(input, 'keyup', onText);
    u.on(input, 'input', onText);
    u.on(input, 'keydown', function (e) {
      if (CV.keys.normalize(e) === 'back') {
        input.blur();
        CV.focus.focus(input);
        u.stop(e);
      }
    });
    head.appendChild(input);

    var countryHost = u.el('span');
    countryHost.id = 'country-chips';
    countryHost.style.marginLeft = '1rem';
    countryHost.style.verticalAlign = 'middle';
    head.appendChild(countryHost);
  }

  function renderCountryChips() {
    var host = u.byId('country-chips');
    if (!host) return;
    u.clear(host);
    host.appendChild(CV.ui.chip('All countries', {
      on: state.country === 'ALL',
      onActivate: pickCountry('ALL')
    }));
    for (var i = 0; i < state.countries.length; i++) {
      host.appendChild(CV.ui.chip(state.countries[i].name, {
        id: state.countries[i].code,
        on: state.country === state.countries[i].code,
        onActivate: pickCountry(state.countries[i].code)
      }));
    }
  }

  function pickCountry(code) {
    return function () {
      if (state.country === code) return;
      state.country = code;
      CV.prefs.set('lastCountry', code);
      renderCountryChips();
      load();
    };
  }

  function renderCategoryChips() {
    var host = u.byId('live-filters');
    u.clear(host);
    host.appendChild(CV.ui.chip('All', {
      on: state.category === 'All',
      onActivate: pickCategory('All')
    }));
    host.appendChild(CV.ui.chip('Favourites', {
      on: state.category === 'Favourites',
      onActivate: pickCategory('Favourites')
    }));
    for (var i = 0; i < state.categories.length; i++) {
      host.appendChild(CV.ui.chip(state.categories[i], {
        on: state.category === state.categories[i],
        onActivate: pickCategory(state.categories[i])
      }));
    }
  }

  function pickCategory(name) {
    return function () {
      if (state.category === name) return;
      state.category = name;
      renderCategoryChips();
      renderChannels();
      CV.focus.refresh();
    };
  }

  function load() {
    var body = u.byId('live-body');
    u.clear(body).appendChild(CV.ui.loading());

    CV.api.get('/api/channels', { country: state.country === 'ALL' ? '' : state.country },
      function (err, data) {
        if (err) {
          u.clear(body).appendChild(CV.ui.notice(err.message || 'Unable to load channels.', {
            error: true,
            actions: [CV.ui.button('Retry', { primary: true, onActivate: load })]
          }));
          CV.focus.refresh();
          return;
        }
        state.countries = data.countries || [];
        state.categories = data.categories || [];
        state.channels = data.channels || [];
        state.loaded = true;
        renderCountryChips();
        renderCategoryChips();
        renderChannels();
        CV.focus.refresh();
      });
  }

  function visibleChannels() {
    var out = [];
    var q = state.query.toLowerCase();
    for (var i = 0; i < state.channels.length; i++) {
      var c = state.channels[i];
      if (state.category === 'Favourites') {
        if (!CV.favs.has(c.id)) continue;
      } else if (state.category !== 'All') {
        if (String(c.category).toLowerCase() !== state.category.toLowerCase()) continue;
      }
      if (q && c.name.toLowerCase().indexOf(q) < 0) continue;
      out.push(c);
    }
    return out;
  }

  function renderChannels() {
    var body = u.byId('live-body');
    if (!body) return;
    var list = visibleChannels();
    u.clear(body);

    if (!list.length) {
      var message = state.channels.length
        ? 'No channels match this filter.'
        : 'No channels are configured. Add authorised streams to backend/data/channels.json.';
      body.appendChild(CV.ui.notice(message));
      CV.focus.refresh();
      return;
    }

    body.appendChild(CV.ui.sectionTitle('Channels', list.length));
    var row = CV.ui.row();
    for (var i = 0; i < list.length; i++) {
      row.appendChild(CV.ui.channelCard(list[i], playChannel));
    }
    body.appendChild(row);
    CV.focus.refresh();
  }

  function render() {
    renderCountryChips();
    renderCategoryChips();
    renderChannels();
  }

  function playChannel(channel) {
    CV.api.get('/api/channel', { id: channel.id }, function (err, data) {
      if (err) {
        var body = u.byId('live-body');
        var notice = CV.ui.notice(err.message || 'Channel unavailable.', {
          error: true,
          actions: [CV.ui.button('Retry', { primary: true, onActivate: function () { playChannel(channel); } })]
        });
        body.insertBefore(notice, body.firstChild);
        CV.focus.refresh();
        return;
      }
      CV.player.openLive({
        channel: channel,
        payload: data,
        onExit: function () {
          CV.router.current();
          CV.focus.refresh();
        }
      });
    });
  }

  /** CH+ / CH- support: steps through the list the viewer is currently seeing. */
  function channelStep(dir) {
    var list = visibleChannels();
    if (!list.length) return null;
    var current = CV.player.liveInfo();
    var index = -1;
    for (var i = 0; i < list.length; i++) {
      if (current && list[i].id === current.id) index = i;
    }
    if (index < 0) return list[0];
    var next = index + dir;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    return list[next];
  }

  return {
    mount: mount,
    load: load,
    playChannel: playChannel,
    channelStep: channelStep
  };
})();
