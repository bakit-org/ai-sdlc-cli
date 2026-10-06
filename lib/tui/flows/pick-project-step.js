'use strict';
// "Which project?" step: filterable list of repositories and recent projects,
// with an "Enter a path..." entry that opens a path field with Tab completion.
const { UsageError } = require('../../errors');
const { validateTarget } = require('../../project-picker');
const { BACK } = require('../terminal');
const { createSelectList } = require('../widgets/select-list');
const { createPathInput } = require('../widgets/path-input');
const { buildProjectItems, PATH_CHOICE } = require('./project-choices');

// Resolves to { dir, hasGit } or BACK.
async function pickProjectStep({ session, cwd, home, root, recents, notice: initialNotice = '', title = 'Select the project to install into' }) {
  const items = buildProjectItems({ cwd, root, home, recents, theme: session.theme });
  const maxVisible = Math.max(3, Math.min(10, session.rows - 10));
  const validate = (text) => validateTarget(text, { cwd, home });
  let notice = initialNotice;
  let mode = 'list';
  for (;;) {
    if (mode === 'list') {
      const picked = await session.run(createSelectList({ title, items, maxVisible, notice, placeholder: 'Type to filter projects' }));
      if (picked === BACK) return BACK;
      if (picked.item.value === PATH_CHOICE) {
        mode = 'path';
        continue;
      }
      try {
        return validate(picked.item.value);
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        notice = err.message;
      }
    } else {
      const typed = await session.run(createPathInput({ cwd, home, validate }));
      if (typed === BACK) {
        mode = 'list';
        notice = '';
      } else return typed;
    }
  }
}

module.exports = { pickProjectStep };
