/**
 * Opens (creating if necessary) the SQLite database the server and
 * the seed script both use. Kept separate from server.js so bench.js
 * can open its own throwaway database file, seed it, and apply
 * perf-index.js at a controlled point — without touching whatever
 * database the actual running server uses.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { SCHEMA_SQL } = require('./schema');
const { PERF_INDEX_SQL } = require('./perf-index');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'library.db');

function openDatabase(dbPath = DB_PATH, { applyPerfIndex = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  if (applyPerfIndex) {
    db.exec(PERF_INDEX_SQL); // the real, deployed database should be fast — applied by default
  }
  return db;
}

module.exports = { openDatabase, DB_PATH };
