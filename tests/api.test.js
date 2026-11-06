// Integrasjonstestar mot API-et med ein mellombels database. Køyr med: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tjukkebolle-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
delete process.env.SESSION_SECRET; // Test at hemmelegheita vert laga automatisk.

const app = require("../server");
const { q } = require("../src/model");

let server;
let base;

before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	q.insertInvite.run("TEST-AAAA");
	q.insertInvite.run("TEST-BBBB");
});

after(() => {
	server.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal «nettlesar» som tek vare på innloggingskapselen. */
function client() {
	let cookie = "";
	return async function call(method, url, body) {
		const res = await fetch(base + url, {
			method,
			redirect: "manual",
			headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const setCookie = res.headers.get("set-cookie");
		if (setCookie) cookie = setCookie.split(";")[0];
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {}
		return { status: res.status, json, location: res.headers.get("location") };
	};
}

const owner = client();
const other = client();
const guest = client();
let sharePath;

test("helsesjekk svarar", async () => {
	const res = await client()("GET", "/api/helse");
	assert.equal(res.status, 200);
	assert.ok(fs.existsSync(path.join(tmpDir, "session-secret")), "session-secret skal vere laga");
});

test("registrering krev gyldig og ubrukt invitasjonskode", async () => {
	const profile = { username: "svigerfar", password: "hemmeleg1", displayName: "Svigerfar", direction: "ned" };

	assert.equal((await owner("POST", "/api/registrer", { ...profile, inviteCode: "FEIL-KODE" })).status, 400);
	assert.equal((await owner("POST", "/api/registrer", { ...profile, inviteCode: "test-aaaa", goalWeight: 80 })).status, 200);
	assert.equal((await other("POST", "/api/registrer", { ...profile, username: "anna", inviteCode: "TEST-AAAA" })).status, 400);
	assert.equal((await other("POST", "/api/registrer", { ...profile, inviteCode: "TEST-BBBB" })).status, 409, "brukarnamn oppteke");
});

test("innlogging", async () => {
	assert.equal((await client()("POST", "/api/logg-inn", { username: "svigerfar", password: "feil" })).status, 401);
	assert.equal((await client()("POST", "/api/logg-inn", { username: "SVIGERFAR", password: "hemmeleg1" })).status, 200);
	assert.equal((await client()("GET", "/api/reise")).status, 401);
	assert.equal((await client()("GET", "/")).location, "/logg-inn");
});

test("målingar: lagring, validering og vern mot overskriving", async () => {
	assert.equal((await owner("PUT", "/api/malingar/2026-01-01", { weight: 93.74 })).json.weight, 93.7);
	assert.equal((await owner("PUT", "/api/malingar/2026-02-30", { weight: 90 })).status, 400);
	assert.equal((await owner("PUT", "/api/malingar/2099-01-01", { weight: 90 })).status, 400);
	assert.equal((await owner("PUT", "/api/malingar/2026-01-02", { weight: 5 })).status, 400);

	const conflict = await owner("PUT", "/api/malingar/2026-01-01", { weight: 92 });
	assert.equal(conflict.status, 409);
	assert.deepEqual(conflict.json.existing, { date: "2026-01-01", weight: 93.7 });

	assert.equal((await owner("PUT", "/api/malingar/2026-01-01", { weight: 93.7 })).json.unchanged, true);
	const replaced = await owner("PUT", "/api/malingar/2026-01-01", { weight: 92, overwrite: true });
	assert.equal(replaced.json.replaced, 93.7);

	await owner("PUT", "/api/malingar/2026-01-05", { weight: 91.5 });
	const journey = await owner("GET", "/api/reise");
	assert.deepEqual(journey.json.measurements, [
		{ date: "2026-01-01", weight: 92 },
		{ date: "2026-01-05", weight: 91.5 },
	]);
	assert.equal(journey.json.profile.goalWeight, 80);

	assert.equal((await owner("DELETE", "/api/malingar/2026-01-05")).status, 200);
	assert.equal((await owner("DELETE", "/api/malingar/2026-01-05")).status, 404);
});

test("brukarar ser berre sine eigne data", async () => {
	await other("POST", "/api/registrer", {
		username: "anna", password: "hemmeleg1", displayName: "Anna", direction: "opp", inviteCode: "TEST-BBBB",
	});
	const journey = await other("GET", "/api/reise");
	assert.equal(journey.json.profile.displayName, "Anna");
	assert.deepEqual(journey.json.measurements, []);
});

test("deling: passord, lesetilgang og tilbakekalling", async () => {
	assert.equal((await owner("PUT", "/api/deling", { enabled: true })).status, 400, "krev passord");
	assert.equal((await owner("PUT", "/api/deling", { enabled: true, password: "gjest" })).status, 200);
	sharePath = (await owner("GET", "/api/profil")).json.share.path;

	assert.equal((await guest("GET", `/api${sharePath}/reise`)).status, 401);
	assert.equal((await guest("POST", `/api${sharePath}/tilgang`, { password: "feil" })).status, 401);
	assert.equal((await guest("POST", `/api${sharePath}/tilgang`, { password: "gjest" })).status, 200);

	const shared = await guest("GET", `/api${sharePath}/reise`);
	assert.equal(shared.status, 200);
	assert.equal(shared.json.canWrite, false);
	assert.equal((await guest("PUT", "/api/malingar/2026-01-03", { weight: 50 })).status, 401);

	await owner("PUT", "/api/deling", { enabled: true, password: "nytt-passord" });
	assert.equal((await guest("GET", `/api${sharePath}/reise`)).status, 401, "nytt passord skal kaste ut gamle gjestar");
});

test("ugyldig JSON gir 400, ikkje 500", async () => {
	const res = await fetch(`${base}/api/logg-inn`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{ikkje json",
	});
	assert.equal(res.status, 400);
});
