'use strict';

/**
 * Minimal .env loader (no dependency, no surprises).
 *
 * Looks for backend/.env and fills process.env for any key that is not already
 * set by the real environment, so a service manager always wins over the file.
 * Values are never logged.
 */

var fs = require('fs');
var path = require('path');

module.exports = function loadEnv() {
  var file = process.env.CVTV_ENV_FILE || path.join(__dirname, '..', '.env');
  var text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { loaded: false, file: file };
  }

  var added = 0;
  text.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.replace(/^\s+|\s+$/g, '');
    if (!trimmed || trimmed.charAt(0) === '#') return;
    var eq = trimmed.indexOf('=');
    if (eq < 1) return;
    var key = trimmed.substring(0, eq).replace(/\s+$/, '');
    var value = trimmed.substring(eq + 1).replace(/^\s+/, '');
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
        (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.substring(1, value.length - 1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      added++;
    }
  });

  return { loaded: true, file: file, keys: added };
};
