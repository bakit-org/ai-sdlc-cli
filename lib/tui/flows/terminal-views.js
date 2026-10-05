'use strict';
// Result views for update/doctor/uninstall when stdout is a terminal.
// Each returns lines for the caller to print; nothing here reads input.
const { createTheme } = require('../theme');
const views = require('./result-views');

function createViews(io) {
  const theme = createTheme({ env: io.env, stream: io.stdout });
  const width = Math.max(40, (io.stdout.columns || 80) - 1);
  return {
    doctor: (data) => views.doctorView({ theme, width, ...data }),
    plan: (data) => views.planView({ theme, width, ...data }),
    done: (data) => views.doneView({ theme, width, ...data }),
  };
}

module.exports = { createViews };
