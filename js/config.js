/* CineVault TV — config.js
   Exactly one setting. Loaded before every other script.

   Same-origin deployment (backend serves this folder): leave it empty.
   Frontend on a static host, backend elsewhere: put the API origin here, for
   example 'https://cvtv-api.example.com'. No trailing slash, HTTPS only.

   A static host such as GitHub Pages has no backend of its own, so the origin
   can also be supplied per visit as ?api=https://... — useful for a hosted
   build that points at a backend deployed separately. It only ever adds a
   base URL; nothing else is read from the query string. */

window.CVTV_API_BASE = (function () {
  var base = '';
  var match = String(window.location.search || '').match(/[?&]api=([^&]+)/);
  if (match) {
    try {
      base = decodeURIComponent(match[1]);
    } catch (e) {
      base = '';
    }
  }
  return base.replace(/\/+$/, '');
})();
