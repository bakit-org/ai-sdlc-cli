'use strict';
// Returned by a screen when the user pressed Esc (or declined) at that step.
const BACK = Object.freeze({ back: true });

// reason: 'interrupt' (Ctrl-C), 'eof' (input closed) or 'escape' (backed out of the first step).
class Cancelled extends Error {
  constructor(reason) {
    super(reason === 'interrupt' ? 'interrupted' : 'cancelled');
    this.name = 'Cancelled';
    this.reason = reason;
  }
}

const isCancelKey = (k) => k.ctrl && k.name === 'c';

module.exports = { BACK, Cancelled, isCancelKey };
