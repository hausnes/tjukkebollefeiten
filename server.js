require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET) {
	console.error("Feil: APP_PASSWORD og SESSION_SECRET må settes i .env-filen.");
	process.exit(1);
}

const DATA_FILE = path.join(__dirname, "data.csv");
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
	session({
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		cookie: { httpOnly: true, sameSite: "lax" },
	})
);

// ---------- Auth ----------

function requireAuth(req, res, next) {
	if (req.session.authenticated) return next();
	const wantsJson =
		req.xhr || (req.headers.accept && req.headers.accept.includes("application/json"));
	if (wantsJson) return res.status(401).json({ error: "Ikke innlogget" });
	res.redirect("/login");
}

app.get("/login", (req, res) => {
	if (req.session.authenticated) return res.redirect("/");
	res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.post("/login", (req, res) => {
	const { password } = req.body;
	if (typeof password === "string" && password === process.env.APP_PASSWORD) {
		req.session.authenticated = true;
		return res.redirect("/");
	}
	res.redirect("/login?feil=1");
});

app.post("/logout", (req, res) => {
	req.session.destroy(() => res.redirect("/login"));
});

// Offentlig tilgjengelig CSS for login-siden (må ligge før requireAuth)
app.get("/login.css", (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, "login.css"));
});

// ---------- Protected routes ----------

app.use(requireAuth);
app.use(express.static(PUBLIC_DIR));

app.get("/api/data", (req, res) => {
	try {
		const csv = fs.readFileSync(DATA_FILE, "utf8");
		res.type("text/csv").send(csv);
	} catch {
		res.status(500).json({ error: "Kunne ikke lese datafilen" });
	}
});

app.post("/api/entry", (req, res) => {
	const { date, weight } = req.body;

	// Validate input
	if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return res.status(400).json({ error: "Ugyldig datoformat (bruk YYYY-MM-DD)" });
	}
	const weightNum = Number(weight);
	if (Number.isNaN(weightNum) || weightNum < 30 || weightNum > 300) {
		return res.status(400).json({ error: "Ugyldig vekt (må være mellom 30 og 300 kg)" });
	}

	const rounded = Math.round(weightNum * 10) / 10;

	const raw = fs.readFileSync(DATA_FILE, "utf8");
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	const header = lines[0];
	const entries = lines.slice(1).map((line) => {
		const parts = line.split(/\s+/);
		return { date: parts[0], line };
	});

	const newLine = `${date} 00:00:00 ${rounded.toFixed(1)}`;
	const existing = entries.findIndex((e) => e.date === date);
	if (existing >= 0) {
		entries[existing] = { date, line: newLine };
	} else {
		entries.push({ date, line: newLine });
	}

	entries.sort((a, b) => a.date.localeCompare(b.date));

	const output = [header, ...entries.map((e) => e.line)].join("\n") + "\n";
	fs.writeFileSync(DATA_FILE, output, "utf8");

	res.json({ ok: true });
});

app.listen(PORT, () => {
	console.log(`Server kjører på http://localhost:${PORT}`);
});
