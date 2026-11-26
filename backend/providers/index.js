'use strict';

var config = require('../config/config');

var moviebox = require('./moviebox');
var fixture = require('./fixture');

/**
 * Production is MovieBox only. The fixture provider exists for automated tests
 * and must be selected explicitly with CVTV_PROVIDER=fixture; there is no
 * automatic fallback in either direction.
 */
function active() {
  return config.provider === 'fixture' ? fixture : moviebox;
}

module.exports = {
  active: active,
  name: config.provider
};
