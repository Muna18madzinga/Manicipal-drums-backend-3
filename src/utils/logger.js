/**
 * Simple Logger Utility
 * 
 * Basic logging functionality for the WFS Publisher service
 */

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
  }

  info(message, ...args) {
    console.log(`[INFO] ${message}`, ...args);
  }

  error(message, ...args) {
    console.error(`[ERROR] ${message}`, ...args);
  }

  warn(message, ...args) {
    console.warn(`[WARN] ${message}`, ...args);
  }

  debug(message, ...args) {
    if (this.logLevel === 'debug') {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
}

// Export a singleton instance
module.exports = new Logger();
