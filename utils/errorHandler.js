'use strict';

const { logError } = require('./logger');

function handleError(error, context = '') {
  logError(context || 'unhandled error', { error });
}

/**
 * Install process-level handlers so a thrown promise doesn't silently kill
 * the worker. Log, then exit non-zero on uncaughtException so the supervisor
 * (Render, Docker, systemd) restarts a clean process.
 */
function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', { error: reason });
  });

  process.on('uncaughtException', (err) => {
    logError('uncaughtException', { error: err });
    setTimeout(() => process.exit(1), 100).unref();
  });
}

module.exports = { handleError, installProcessHandlers };
