#!/usr/bin/env node
/**
 * Lagar nye invitasjonskodar, eller listar opp ubrukte.
 *
 *   npm run invitasjon            -> lagar éin kode
 *   npm run invitasjon -- 5       -> lagar fem kodar
 *   npm run invitasjon -- liste   -> viser ubrukte kodar
 */
require("dotenv").config();
const { q } = require("../src/model");
const { randomInviteCode } = require("../src/security");

const arg = process.argv[2];

if (arg === "liste") {
	const open = q.openInvites.all();
	if (!open.length) console.log("Ingen ubrukte invitasjonskodar.");
	for (const inv of open) console.log(`${inv.code}   (laga ${inv.created_at})`);
	process.exit(0);
}

const count = arg ? Number(arg) : 1;
if (!Number.isInteger(count) || count < 1 || count > 100) {
	console.error("Bruk: npm run invitasjon -- [tal mellom 1 og 100 | liste]");
	process.exit(1);
}

console.log(`Nye invitasjonskodar (kvar kode kan brukast éin gong):\n`);
for (let i = 0; i < count; i += 1) {
	const code = randomInviteCode();
	q.insertInvite.run(code);
	console.log(`  ${code}`);
}
