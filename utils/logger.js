function logInfo(...args) {
  console.log('[INFO]', new Date().toISOString(), ...args);
}

function logError(...args) {
  console.error('[ERROR]', new Date().toISOString(), ...args);
}

function logWarn(...args) {
  console.warn('[WARN]', new Date().toISOString(), ...args);
}

module.exports = { logInfo, logError, logWarn };
