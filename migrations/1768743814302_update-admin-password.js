/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Update admin password to "admin123" (hashed with bcrypt)
  pgm.sql(`
    UPDATE users 
    SET password_hash = '$2a$10$r1h4ZoXkRneN8C0FFhtVF.LhiGjr28KBN1gY2LFCIKO0aCGu.OrQW'
    WHERE email = 'admin@vungu-rdc.org'
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {};
