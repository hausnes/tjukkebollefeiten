const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "tjukkebolle.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

// Kvar migrering køyrer éin gong; PRAGMA user_version held styr på kor langt vi har kome.
const MIGRATIONS = [
	`
	CREATE TABLE users (
		id                  INTEGER PRIMARY KEY,
		username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash       TEXT NOT NULL,
		display_name        TEXT NOT NULL,
		direction           TEXT NOT NULL DEFAULT 'ned' CHECK (direction IN ('ned', 'opp')),
		goal_weight         REAL,
		height_cm           REAL,
		share_slug          TEXT NOT NULL UNIQUE,
		share_enabled       INTEGER NOT NULL DEFAULT 0,
		share_password_hash TEXT,
		created_at          TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE measurements (
		user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		date    TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
		weight  REAL NOT NULL CHECK (weight BETWEEN 20 AND 400),
		PRIMARY KEY (user_id, date)
	) WITHOUT ROWID;

	CREATE TABLE invites (
		code       TEXT PRIMARY KEY,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
		used_at    TEXT
	);

	CREATE TABLE sessions (
		sid     TEXT PRIMARY KEY,
		data    TEXT NOT NULL,
		expires INTEGER NOT NULL
	);
	CREATE INDEX sessions_expires ON sessions (expires);
	`,
	`
	CREATE TABLE events (
		id         INTEGER PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		kind       TEXT NOT NULL CHECK (kind IN ('dag', 'periode')),
		start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
		-- NULL på ein periode betyr at han framleis pågår.
		end_date   TEXT CHECK (end_date IS NULL OR (kind = 'periode' AND end_date >= start_date)),
		category   TEXT NOT NULL,
		effect     TEXT NOT NULL CHECK (effect IN ('opp', 'ned', 'ukjend')),
		title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
		note       TEXT CHECK (note IS NULL OR length(note) <= 500),
		private    INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX events_user_start ON events (user_id, start_date);
	`,
];

function migrate() {
	const { user_version: current } = db.prepare("PRAGMA user_version").get();
	for (let v = current; v < MIGRATIONS.length; v += 1) {
		transaction(() => {
			db.exec(MIGRATIONS[v]);
			db.exec(`PRAGMA user_version = ${v + 1}`);
		});
	}
}

function transaction(fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

migrate();

module.exports = { db, transaction, DB_PATH };
