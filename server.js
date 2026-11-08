require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");

const { db, DB_PATH } = require("./src/db");
const { SqliteSessionStore } = require("./src/session-store");
const { q, publicProfile, publicEvent, createUserWithInvite } = require("./src/model");
const {
	hashPassword,
	verifyPassword,
	DUMMY_HASH,
	randomSlug,
	createAttemptLimiter,
} = require("./src/security");

/**
 * Hemmelegheita som signerer innloggingskapslane. Er SESSION_SECRET ikkje sett, lagar vi ei
 * tilfeldig og lagrar ho ved sida av databasen, så ho overlever omstart og oppdateringar.
 */
function loadSessionSecret() {
	if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
	const file = path.join(path.dirname(DB_PATH), "session-secret");
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		const secret = crypto.randomBytes(32).toString("hex");
		fs.writeFileSync(file, secret, { mode: 0o600 });
		console.log(`Laga ny SESSION_SECRET i ${file}`);
		return secret;
	}
}

const app = express();
const PORT = process.env.PORT || 3000;
const VIEWS = path.join(__dirname, "views");
const PUBLIC_DIR = path.join(__dirname, "public");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "20kb" }));
app.use(
	session({
		name: "tjukkebolle.sid",
		store: new SqliteSessionStore(db),
		secret: loadSessionSecret(),
		resave: false,
		saveUninitialized: false,
		rolling: true,
		cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: THIRTY_DAYS },
	})
);
app.use(express.static(PUBLIC_DIR, { index: false }));

const loginLimiter = createAttemptLimiter({ max: 10 });
const shareLimiter = createAttemptLimiter({ max: 10 });
const inviteLimiter = createAttemptLimiter({ max: 10 });

// ---------- Hjelparar ----------

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const view = (name) => (req, res) => res.sendFile(path.join(VIEWS, `${name}.html`));
const fail = (res, status, error) => res.status(status).json({ error });

function regenerateSession(req) {
	return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function currentUser(req) {
	return req.session.userId ? q.userById.get(req.session.userId) : null;
}

function requireUserPage(req, res, next) {
	req.user = currentUser(req);
	if (req.user) return next();
	res.redirect("/logg-inn");
}

function requireUserApi(req, res, next) {
	req.user = currentUser(req);
	if (req.user) return next();
	fail(res, 401, "Du er ikkje innlogga.");
}

/** Finn eigaren av ei delingslenke dersom økta har (framleis gyldig) tilgang. */
function sharedOwner(req) {
	const owner = q.userBySlug.get(String(req.params.slug));
	if (!owner) return null;
	if (req.session.userId === owner.id) return owner; // Eigaren kan alltid førehandsvise.
	const grant = req.session.shareGrants && req.session.shareGrants[owner.share_slug];
	// Byter eigaren passord eller skrur av deling, misser alle eldre økter tilgangen.
	if (owner.share_enabled && owner.share_password_hash && grant === owner.share_password_hash) return owner;
	return null;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validPassword(pw) {
	return typeof pw === "string" && pw.length >= 8 && pw.length <= 200;
}

function isRealDate(s) {
	if (typeof s !== "string" || !DATE_RE.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Validerer profilfelt. Returnerer { value } eller { error }. */
function parseProfile(body) {
	const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
	if (displayName.length < 1 || displayName.length > 40) {
		return { error: "Visningsnamnet må vere mellom 1 og 40 teikn." };
	}

	const direction = body.direction === "opp" ? "opp" : body.direction === "ned" ? "ned" : null;
	if (!direction) return { error: "Vel om du vil ned eller opp i vekt." };

	const optionalNumber = (raw, min, max, label) => {
		if (raw === null || raw === undefined || raw === "") return { value: null };
		const n = Number(raw);
		if (!Number.isFinite(n) || n < min || n > max) return { error: `${label} må vere mellom ${min} og ${max}.` };
		return { value: Math.round(n * 10) / 10 };
	};

	const goal = optionalNumber(body.goalWeight, 20, 400, "Målvekta");
	if (goal.error) return goal;
	const height = optionalNumber(body.heightCm, 80, 250, "Høgda (cm)");
	if (height.error) return height;

	return { value: { displayName, direction, goalWeight: goal.value, heightCm: height.value } };
}

const EVENT_CATEGORIES = ["kos", "drikke", "hoytid", "trening", "tur", "stress", "sjukdom", "kosthald", "anna"];

function addDaysIso(iso, days) {
	return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Validerer ei hending. Returnerer { value } eller { error }. */
function parseEvent(body) {
	const kind = body.kind === "periode" ? "periode" : body.kind === "dag" ? "dag" : null;
	if (!kind) return { error: "Vel om hendinga er éin dag eller ein periode." };

	if (!isRealDate(body.startDate)) return { error: "Ugyldig startdato (bruk ÅÅÅÅ-MM-DD)." };
	const startDate = body.startDate;
	const today = new Date().toISOString().slice(0, 10);
	if (startDate > addDaysIso(today, 366)) return { error: "Så langt fram i tid planlegg ingen kos. Maks eitt år." };

	let endDate = null;
	if (kind === "periode" && body.endDate !== null && body.endDate !== undefined && body.endDate !== "") {
		if (!isRealDate(body.endDate)) return { error: "Ugyldig sluttdato (bruk ÅÅÅÅ-MM-DD)." };
		if (body.endDate < startDate) return { error: "Perioden kan ikkje slutte før han byrjar. Tidsreiser er ikkje støtta." };
		if (body.endDate > addDaysIso(startDate, 731)) return { error: "Ein periode kan vare i maks to år." };
		endDate = body.endDate;
	}

	if (!EVENT_CATEGORIES.includes(body.category)) return { error: "Ukjend kategori." };
	const effect = ["opp", "ned", "ukjend"].includes(body.effect) ? body.effect : null;
	if (!effect) return { error: "Vel venta effekt på vekta." };

	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (title.length < 1 || title.length > 80) return { error: "Tittelen må vere mellom 1 og 80 teikn." };

	const note = typeof body.note === "string" ? body.note.trim() : "";
	if (note.length > 500) return { error: "Notatet kan ha maks 500 teikn." };

	return {
		value: { kind, startDate, endDate, category: body.category, effect, title, note: note || null, private: body.private === true },
	};
}

function eventParams(e) {
	return [e.kind, e.startDate, e.endDate, e.category, e.effect, e.title, e.note, e.private ? 1 : 0];
}

function journeyPayload(owner, canWrite) {
	// Private hendingar vert aldri sende til delingslenkja, heller ikkje når eigaren førehandsviser ho.
	const events = (canWrite ? q.events : q.publicEvents).all(owner.id).map(publicEvent);
	return {
		canWrite,
		profile: publicProfile(owner),
		measurements: q.measurements.all(owner.id).map((m) => ({ date: m.date, weight: m.weight })),
		events: canWrite ? events : events.map(({ private: _, ...rest }) => rest),
	};
}

// ---------- Sider ----------

app.get("/", (req, res) => {
	if (!currentUser(req)) return res.redirect("/logg-inn");
	res.sendFile(path.join(VIEWS, "dashboard.html"));
});

app.get("/logg-inn", (req, res) => {
	if (currentUser(req)) return res.redirect("/");
	res.sendFile(path.join(VIEWS, "logg-inn.html"));
});

app.get("/registrer", view("registrer"));
app.get("/innstillingar", requireUserPage, view("innstillingar"));

app.get("/d/:slug", (req, res) => {
	res.sendFile(path.join(VIEWS, sharedOwner(req) ? "dashboard.html" : "deling.html"));
});

app.post("/logg-ut", (req, res) => {
	req.session.destroy(() => {
		res.clearCookie("tjukkebolle.sid");
		res.redirect("/logg-inn");
	});
});

// Gamle adresser frå førre versjon.
app.get("/login", (req, res) => res.redirect(301, "/logg-inn"));

// ---------- API: innlogging og registrering ----------

app.post(
	"/api/logg-inn",
	ah(async (req, res) => {
		const key = `login:${req.ip}`;
		if (loginLimiter.isBlocked(key)) return fail(res, 429, "For mange forsøk. Vent litt og prøv igjen.");

		const { username, password } = req.body || {};
		const user = typeof username === "string" ? q.userByUsername.get(username.trim()) : null;
		const ok = await verifyPassword(String(password ?? ""), user ? user.password_hash : DUMMY_HASH);
		if (!user || !ok) {
			loginLimiter.fail(key);
			return fail(res, 401, "Feil brukarnamn eller passord.");
		}

		loginLimiter.clear(key);
		const grants = req.session.shareGrants;
		await regenerateSession(req);
		req.session.userId = user.id;
		if (grants) req.session.shareGrants = grants;
		res.json({ ok: true, redirect: "/" });
	})
);

app.post(
	"/api/registrer",
	ah(async (req, res) => {
		const key = `invite:${req.ip}`;
		if (inviteLimiter.isBlocked(key)) return fail(res, 429, "For mange forsøk. Vent litt og prøv igjen.");

		const body = req.body || {};
		const inviteCode = String(body.inviteCode || "").trim().toUpperCase();
		const username = String(body.username || "").trim();

		if (!inviteCode) return fail(res, 400, "Du treng ein invitasjonskode.");
		if (!USERNAME_RE.test(username)) {
			return fail(res, 400, "Brukarnamnet må vere 3–30 teikn: bokstavar (a–z), tal, punktum, - eller _.");
		}
		if (!validPassword(body.password)) return fail(res, 400, "Passordet må ha minst 8 teikn.");

		const profile = parseProfile(body);
		if (profile.error) return fail(res, 400, profile.error);

		const result = createUserWithInvite({
			inviteCode,
			username,
			passwordHash: await hashPassword(body.password),
			...profile.value,
		});

		if (result.error === "invite") {
			inviteLimiter.fail(key);
			return fail(res, 400, "Invitasjonskoden er ugyldig eller allereie brukt.");
		}
		if (result.error === "username") return fail(res, 409, "Brukarnamnet er oppteke. Prøv eit anna.");

		await regenerateSession(req);
		req.session.userId = result.userId;
		res.json({ ok: true, redirect: "/" });
	})
);

app.post(
	"/api/d/:slug/tilgang",
	ah(async (req, res) => {
		const key = `share:${req.ip}`;
		if (shareLimiter.isBlocked(key)) return fail(res, 429, "For mange forsøk. Vent litt og prøv igjen.");

		const owner = q.userBySlug.get(String(req.params.slug));
		const usable = owner && owner.share_enabled && owner.share_password_hash;
		const ok = await verifyPassword(String((req.body || {}).password ?? ""), usable ? owner.share_password_hash : DUMMY_HASH);
		if (!usable || !ok) {
			shareLimiter.fail(key);
			return fail(res, 401, "Feil passord, eller så er lenkja ikkje lenger aktiv.");
		}

		shareLimiter.clear(key);
		req.session.shareGrants = { ...(req.session.shareGrants || {}), [owner.share_slug]: owner.share_password_hash };
		res.json({ ok: true, redirect: `/d/${owner.share_slug}` });
	})
);

// ---------- API: data ----------

app.get("/api/reise", requireUserApi, (req, res) => {
	res.json(journeyPayload(req.user, true));
});

app.get("/api/d/:slug/reise", (req, res) => {
	const owner = sharedOwner(req);
	if (!owner) return fail(res, 401, "Du har ikkje tilgang til denne reisa.");
	res.json(journeyPayload(owner, false));
});

app.put("/api/malingar/:date", requireUserApi, (req, res) => {
	const { date } = req.params;
	if (!isRealDate(date)) return fail(res, 400, "Ugyldig dato (bruk ÅÅÅÅ-MM-DD).");
	if (date > new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10)) {
		return fail(res, 400, "Du kan ikkje registrere målingar fram i tid. Godt forsøk, likevel.");
	}

	const weight = Number((req.body || {}).weight);
	if (!Number.isFinite(weight) || weight < 20 || weight > 400) {
		return fail(res, 400, "Ugyldig vekt (må vere mellom 20 og 400 kg).");
	}

	const rounded = Math.round(weight * 10) / 10;
	const existing = q.measurement.get(req.user.id, date);
	if (existing && existing.weight === rounded) return res.json({ ok: true, date, weight: rounded, unchanged: true });

	// Ikkje skriv over ei eksisterande måling utan at brukaren har stadfesta det.
	if (existing && (req.body || {}).overwrite !== true) {
		return res.status(409).json({
			error: `Det ligg allereie ei måling på ${existing.weight.toFixed(1).replace(".", ",")} kg for denne datoen.`,
			existing: { date: existing.date, weight: existing.weight },
		});
	}

	q.upsertMeasurement.run(req.user.id, date, rounded);
	res.json({ ok: true, date, weight: rounded, replaced: existing ? existing.weight : null });
});

app.delete("/api/malingar/:date", requireUserApi, (req, res) => {
	const { changes } = q.deleteMeasurement.run(req.user.id, req.params.date);
	if (!changes) return fail(res, 404, "Fann inga måling for den datoen.");
	res.json({ ok: true });
});

app.post("/api/hendingar", requireUserApi, (req, res) => {
	const parsed = parseEvent(req.body || {});
	if (parsed.error) return fail(res, 400, parsed.error);
	const { lastInsertRowid } = q.insertEvent.run(req.user.id, ...eventParams(parsed.value));
	res.status(201).json({ ok: true, event: publicEvent(q.eventById.get(Number(lastInsertRowid), req.user.id)) });
});

app.put("/api/hendingar/:id", requireUserApi, (req, res) => {
	const id = Number(req.params.id);
	if (!Number.isInteger(id) || !q.eventById.get(id, req.user.id)) return fail(res, 404, "Fann ikkje hendinga.");
	const parsed = parseEvent(req.body || {});
	if (parsed.error) return fail(res, 400, parsed.error);
	q.updateEvent.run(...eventParams(parsed.value), id, req.user.id);
	res.json({ ok: true, event: publicEvent(q.eventById.get(id, req.user.id)) });
});

app.delete("/api/hendingar/:id", requireUserApi, (req, res) => {
	const { changes } = q.deleteEvent.run(Number(req.params.id), req.user.id);
	if (!changes) return fail(res, 404, "Fann ikkje hendinga.");
	res.json({ ok: true });
});

app.get("/api/eksport.csv", requireUserApi, (req, res) => {
	const rows = q.measurements.all(req.user.id);
	const csv = ["dato,vekt_kg", ...rows.map((r) => `${r.date},${r.weight.toFixed(1)}`)].join("\n") + "\n";
	res.attachment(`vekt-${req.user.username}.csv`).type("text/csv").send(csv);
});

// ---------- API: profil og innstillingar ----------

app.get("/api/profil", requireUserApi, (req, res) => {
	const u = req.user;
	res.json({
		...publicProfile(u),
		share: {
			enabled: Boolean(u.share_enabled),
			hasPassword: Boolean(u.share_password_hash),
			path: `/d/${u.share_slug}`,
		},
	});
});

app.put("/api/profil", requireUserApi, (req, res) => {
	const profile = parseProfile(req.body || {});
	if (profile.error) return fail(res, 400, profile.error);
	const p = profile.value;
	q.updateProfile.run(p.displayName, p.direction, p.goalWeight, p.heightCm, req.user.id);
	res.json({ ok: true });
});

app.put(
	"/api/deling",
	requireUserApi,
	ah(async (req, res) => {
		const { enabled, password } = req.body || {};
		let hash = req.user.share_password_hash;

		if (password !== undefined && password !== "") {
			if (typeof password !== "string" || password.length < 4 || password.length > 200) {
				return fail(res, 400, "Delingspassordet må ha minst 4 teikn.");
			}
			hash = await hashPassword(password);
		}

		if (enabled && !hash) return fail(res, 400, "Set eit delingspassord før du skrur på deling.");
		q.updateShare.run(enabled ? 1 : 0, hash, req.user.id);
		res.json({ ok: true });
	})
);

app.post("/api/deling/ny-lenke", requireUserApi, (req, res) => {
	const slug = randomSlug();
	q.updateSlug.run(slug, req.user.id);
	res.json({ ok: true, path: `/d/${slug}` });
});

app.put(
	"/api/passord",
	requireUserApi,
	ah(async (req, res) => {
		const { current, next } = req.body || {};
		if (!(await verifyPassword(String(current ?? ""), req.user.password_hash))) {
			return fail(res, 401, "Noverande passord er feil.");
		}
		if (!validPassword(next)) return fail(res, 400, "Det nye passordet må ha minst 8 teikn.");
		q.updatePassword.run(await hashPassword(next), req.user.id);
		res.json({ ok: true });
	})
);

app.delete(
	"/api/konto",
	requireUserApi,
	ah(async (req, res) => {
		if (!(await verifyPassword(String((req.body || {}).password ?? ""), req.user.password_hash))) {
			return fail(res, 401, "Feil passord.");
		}
		q.deleteUser.run(req.user.id);
		req.session.destroy(() => res.json({ ok: true, redirect: "/logg-inn" }));
	})
);

// Brukt av Docker sin HEALTHCHECK.
app.get("/api/helse", (req, res) => {
	db.prepare("SELECT 1").get();
	res.json({ ok: true });
});

// ---------- Feilhandtering ----------

app.use("/api", (req, res) => fail(res, 404, "Ukjent API-adresse."));
app.use((req, res) => res.status(404).sendFile(path.join(VIEWS, "404.html")));

app.use((err, req, res, next) => {
	if (res.headersSent) return next(err);
	// Klientfeil frå body-parser (t.d. ugyldig JSON) skal ikkje bli 500.
	if (err.status >= 400 && err.status < 500) return fail(res, err.status, "Ugyldig førespurnad.");
	console.error(err);
	if (req.path.startsWith("/api")) return fail(res, 500, "Noko gjekk gale på serveren.");
	res.status(500).send("Noko gjekk gale på serveren.");
});

module.exports = app;

if (require.main === module) {
	const server = app.listen(PORT, () => {
		console.log(`Serveren køyrer på http://localhost:${PORT}`);
	});

	// Docker sender SIGTERM ved stopp. Fullfør pågåande førespurnader og lukk databasen ryddig.
	const shutdown = (signal) => {
		console.log(`Fekk ${signal}, avsluttar …`);
		server.close(() => {
			db.close();
			process.exit(0);
		});
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
