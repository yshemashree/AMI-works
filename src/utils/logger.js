// Minimal leveled logger. Kept dependency-free since the project's needs
// are simple (CLI progress output + JSON-safe error logging).
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, ...args) {
  if (LEVELS[level] > currentLevel) return;
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const write = level === 'error' ? console.error : console.log;
  write(prefix, ...args);
}

export const logger = {
  error: (...args) => log('error', ...args),
  warn: (...args) => log('warn', ...args),
  info: (...args) => log('info', ...args),
  debug: (...args) => log('debug', ...args),
};
