const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

async function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = await scrypt(password, salt, KEY_LEN);
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, stored) {
	if (typeof password !== "string" || typeof stored !== "string") return false;
	const [alg, saltB64, hashB64] = stored.split("$");
	if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
	const expected = Buffer.from(hashB64, "base64");
	const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
	return crypto.timingSafeEqual(expected, actual);
}

// Brukt for å samanlikne mot ein «dummy» når brukaren ikkje finst, så svartida ikkje avslører det.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(KEY_LEN).toString("base64");

function randomSlug(bytes = 9) {
	return crypto.randomBytes(bytes).toString("base64url");
}

function randomInviteCode() {
	// Lett å lese opp og skrive inn: ingen 0/O/1/I.
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.randomBytes(8);
	let code = "";
	for (let i = 0; i < 8; i += 1) {
		code += alphabet[bytes[i] % alphabet.length];
		if (i === 3) code += "-";
	}
	return code;
}

/**
 * Enkel minnebasert avgrensing av mislukka forsøk (innlogging, delingspassord, registrering).
 */
function createAttemptLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
	const attempts = new Map();

	setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of attempts) {
			if (entry.reset < now) attempts.delete(key);
		}
	}, windowMs).unref();

	return {
		isBlocked(key) {
			const entry = attempts.get(key);
			return Boolean(entry && entry.reset > Date.now() && entry.count >= max);
		},
		fail(key) {
			const now = Date.now();
			const entry = attempts.get(key);
			if (!entry || entry.reset < now) {
				attempts.set(key, { count: 1, reset: now + windowMs });
			} else {
				entry.count += 1;
			}
		},
		clear(key) {
			attempts.delete(key);
		},
	};
}

module.exports = {
	hashPassword,
	verifyPassword,
	DUMMY_HASH,
	randomSlug,
	randomInviteCode,
	createAttemptLimiter,
};
