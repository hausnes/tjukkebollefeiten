const session = require("express-session");

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000;

/** Lagrar økter i SQLite, slik at folk ikkje vert logga ut kvar gong serveren startar på nytt. */
class SqliteSessionStore extends session.Store {
	constructor(db) {
		super();
		this.stmt = {
			get: db.prepare("SELECT data FROM sessions WHERE sid = ? AND expires > ?"),
			set: db.prepare(
				"INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) " +
					"ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires"
			),
			touch: db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?"),
			destroy: db.prepare("DELETE FROM sessions WHERE sid = ?"),
			prune: db.prepare("DELETE FROM sessions WHERE expires <= ?"),
		};

		setInterval(() => this.stmt.prune.run(Date.now()), 60 * 60 * 1000).unref();
	}

	static expiry(sess) {
		const expires = sess && sess.cookie && sess.cookie.expires;
		return expires ? new Date(expires).getTime() : Date.now() + DEFAULT_TTL;
	}

	get(sid, cb) {
		try {
			const row = this.stmt.get.get(sid, Date.now());
			cb(null, row ? JSON.parse(row.data) : null);
		} catch (err) {
			cb(err);
		}
	}

	set(sid, sess, cb = () => {}) {
		try {
			this.stmt.set.run(sid, JSON.stringify(sess), SqliteSessionStore.expiry(sess));
			cb(null);
		} catch (err) {
			cb(err);
		}
	}

	touch(sid, sess, cb = () => {}) {
		try {
			this.stmt.touch.run(SqliteSessionStore.expiry(sess), sid);
			cb(null);
		} catch (err) {
			cb(err);
		}
	}

	destroy(sid, cb = () => {}) {
		try {
			this.stmt.destroy.run(sid);
			cb(null);
		} catch (err) {
			cb(err);
		}
	}
}

module.exports = { SqliteSessionStore };
