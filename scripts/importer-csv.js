#!/usr/bin/env node
/**
 * Importerer målingar frå ei CSV-fil inn på ein eksisterande brukar.
 * Godtek både det gamle formatet («2025-10-01 00:00:00 93.7») og
 * eksportformatet («2025-10-01,93.7»).
 *
 * Trygt å køyre fleire gonger: nye datoar vert lagde inn, like målingar vert hoppa over,
 * og datoar der vekta er ulik vert berre rapporterte – med mindre du legg til --overskriv.
 *
 *   npm run importer -- <brukarnamn> [fil] [--prøv] [--overskriv]
 *
 *   --prøv       Vis kva som ville skjedd, utan å lagre noko
 *   --overskriv  Byt ut eksisterande målingar som har anna vekt enn i fila
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { q, importMeasurements } = require("../src/model");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [username, file = "data.csv"] = args.filter((a) => !a.startsWith("--"));
const dryRun = flags.has("--prøv") || flags.has("--prov") || flags.has("--dry-run");
const overwrite = flags.has("--overskriv");

const unknown = [...flags].filter((f) => !["--prøv", "--prov", "--dry-run", "--overskriv"].includes(f));
if (!username || unknown.length) {
	if (unknown.length) console.error(`Ukjend val: ${unknown.join(", ")}`);
	console.error("Bruk: importer <brukarnamn> [fil] [--prøv] [--overskriv]");
	process.exit(1);
}

const user = q.userByUsername.get(username);
if (!user) {
	console.error(`Fann ingen brukar med brukarnamnet «${username}». Registrer brukaren først.`);
	process.exit(1);
}

// ---------- Les fila ----------

const fromFile = new Map();
const skipped = [];
for (const raw of fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/)) {
	const line = raw.trim();
	if (!line) continue;
	const parts = line.split(/[\s,;]+/);
	const date = parts[0];
	const weight = Number(parts[parts.length - 1]);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(weight) || weight < 20 || weight > 400) {
		if (!/^dato/i.test(line)) skipped.push(line); // Overskriftslinja er ikkje verd å nemne.
		continue;
	}
	fromFile.set(date, Math.round(weight * 10) / 10); // Står ein dato fleire gonger, vinn den siste.
}

// ---------- Samanlikn med databasen ----------

const existing = new Map(q.measurements.all(user.id).map((m) => [m.date, m.weight]));
const added = [];
const same = [];
const different = [];

for (const [date, weight] of [...fromFile].sort(([a], [b]) => a.localeCompare(b))) {
	if (!existing.has(date)) added.push({ date, weight });
	else if (existing.get(date) === weight) same.push(date);
	else different.push({ date, weight, current: existing.get(date) });
}

const toWrite = overwrite ? [...added, ...different] : added;
if (!dryRun) importMeasurements(user.id, toWrite);

// ---------- Rapport ----------

const kg = (n) => `${n.toFixed(1).replace(".", ",")} kg`;
const range = (rows) => (rows.length ? ` (${rows[0].date} – ${rows[rows.length - 1].date})` : "");

console.log(`${dryRun ? "PRØVEKØYRING – ingenting er lagra.\n" : ""}Brukar: «${user.display_name}» (${user.username}), fil: ${file}`);
console.log(`  ${fromFile.size} målingar i fila`);
console.log(`  ${added.length} nye ${dryRun ? "ville blitt lagde inn" : "lagde inn"}${range(added)}`);
console.log(`  ${same.length} fanst frå før med same vekt`);

if (different.length) {
	const verb = overwrite ? (dryRun ? "ville blitt bytte ut" : "bytte ut") : "har ANNA vekt i databasen og vart IKKJE endra";
	console.log(`  ${different.length} ${verb}:`);
	for (const d of different.slice(0, 15)) {
		console.log(`     ${d.date}: databasen ${kg(d.current)}, fila ${kg(d.weight)}`);
	}
	if (different.length > 15) console.log(`     … og ${different.length - 15} til`);
	if (!overwrite) console.log("  Køyr på nytt med --overskriv dersom fila skal gjelde for desse.");
}

if (skipped.length) console.log(`  ${skipped.length} linje(r) kunne ikkje lesast, t.d.: «${skipped[0]}»`);
