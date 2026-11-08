const { db, transaction } = require("./db");
const { randomSlug } = require("./security");

const q = {
	userById: db.prepare("SELECT * FROM users WHERE id = ?"),
	userByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
	userBySlug: db.prepare("SELECT * FROM users WHERE share_slug = ?"),
	insertUser: db.prepare(
		"INSERT INTO users (username, password_hash, display_name, direction, goal_weight, height_cm, share_slug) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)"
	),
	updateProfile: db.prepare(
		"UPDATE users SET display_name = ?, direction = ?, goal_weight = ?, height_cm = ? WHERE id = ?"
	),
	updatePassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
	updateShare: db.prepare("UPDATE users SET share_enabled = ?, share_password_hash = ? WHERE id = ?"),
	updateSlug: db.prepare("UPDATE users SET share_slug = ? WHERE id = ?"),
	deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),

	measurement: db.prepare("SELECT date, weight FROM measurements WHERE user_id = ? AND date = ?"),
	measurements: db.prepare("SELECT date, weight FROM measurements WHERE user_id = ? ORDER BY date"),
	upsertMeasurement: db.prepare(
		"INSERT INTO measurements (user_id, date, weight) VALUES (?, ?, ?) " +
			"ON CONFLICT (user_id, date) DO UPDATE SET weight = excluded.weight"
	),
	deleteMeasurement: db.prepare("DELETE FROM measurements WHERE user_id = ? AND date = ?"),

	events: db.prepare("SELECT * FROM events WHERE user_id = ? ORDER BY start_date, id"),
	publicEvents: db.prepare("SELECT * FROM events WHERE user_id = ? AND private = 0 ORDER BY start_date, id"),
	eventById: db.prepare("SELECT * FROM events WHERE id = ? AND user_id = ?"),
	insertEvent: db.prepare(
		"INSERT INTO events (user_id, kind, start_date, end_date, category, effect, title, note, private) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
	),
	updateEvent: db.prepare(
		"UPDATE events SET kind = ?, start_date = ?, end_date = ?, category = ?, effect = ?, title = ?, note = ?, private = ? " +
			"WHERE id = ? AND user_id = ?"
	),
	deleteEvent: db.prepare("DELETE FROM events WHERE id = ? AND user_id = ?"),

	inviteByCode: db.prepare("SELECT * FROM invites WHERE code = ?"),
	useInvite: db.prepare(
		"UPDATE invites SET used_by = ?, used_at = datetime('now') WHERE code = ? AND used_at IS NULL"
	),
	insertInvite: db.prepare("INSERT INTO invites (code) VALUES (?)"),
	openInvites: db.prepare("SELECT code, created_at FROM invites WHERE used_at IS NULL ORDER BY created_at"),
};

function publicEvent(row) {
	return {
		id: row.id,
		kind: row.kind,
		startDate: row.start_date,
		endDate: row.end_date,
		category: row.category,
		effect: row.effect,
		title: row.title,
		note: row.note,
		private: Boolean(row.private),
	};
}

function publicProfile(user) {
	return {
		username: user.username,
		displayName: user.display_name,
		direction: user.direction,
		goalWeight: user.goal_weight,
		heightCm: user.height_cm,
	};
}

/** Opprettar brukar og brukar opp invitasjonskoden i same transaksjon. */
function createUserWithInvite({ inviteCode, username, passwordHash, displayName, direction, goalWeight, heightCm }) {
	return transaction(() => {
		const invite = q.inviteByCode.get(inviteCode);
		if (!invite || invite.used_at) return { error: "invite" };
		if (q.userByUsername.get(username)) return { error: "username" };

		const { lastInsertRowid } = q.insertUser.run(
			username,
			passwordHash,
			displayName,
			direction,
			goalWeight,
			heightCm,
			randomSlug()
		);
		const userId = Number(lastInsertRowid);
		q.useInvite.run(userId, inviteCode);
		return { userId };
	});
}

function createUser({ username, passwordHash, displayName, direction = "ned", goalWeight = null, heightCm = null }) {
	const { lastInsertRowid } = q.insertUser.run(
		username,
		passwordHash,
		displayName,
		direction,
		goalWeight,
		heightCm,
		randomSlug()
	);
	return Number(lastInsertRowid);
}

function importMeasurements(userId, rows) {
	return transaction(() => {
		for (const { date, weight } of rows) q.upsertMeasurement.run(userId, date, weight);
		return rows.length;
	});
}

module.exports = { q, publicProfile, publicEvent, createUserWithInvite, createUser, importMeasurements };
