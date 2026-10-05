'use strict';

// exitCode: 1 = the operation failed, 2 = the command line was wrong.
class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

module.exports = { CliError, UsageError };
