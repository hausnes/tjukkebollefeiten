// ---------- Oppsett ----------

const DAY = 24 * 60 * 60 * 1000;
const COLORS = {
	weight: "#0a9396",
	average: "#ca6702",
	goal: "#2a9d8f",
	good: "rgba(42, 157, 143, 0.85)",
	bad: "rgba(187, 62, 3, 0.8)",
	grid: "rgba(34, 32, 24, 0.09)",
};

const shareSlug = (location.pathname.match(/^\/d\/([^/]+)/) || [])[1];
const API_JOURNEY = shareSlug ? `/api/d/${encodeURIComponent(shareSlug)}/reise` : "/api/reise";

const state = {
	canWrite: false,
	profile: null,
	data: [], // [{ date: "YYYY-MM-DD", weight: 93.7, t: <ms UTC> }]
	charts: {},
	editingDate: null, // Dato som vert endra via «Endre»-knappen (då spør vi ikkje om overskriving).
};

const $ = (id) => document.getElementById(id);

if (window.Highcharts) {
	Highcharts.setOptions({
		lang: {
			months: ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"],
			shortMonths: ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"],
			weekdays: ["sundag", "måndag", "tysdag", "onsdag", "torsdag", "fredag", "laurdag"],
			decimalPoint: ",",
			thousandsSep: " ",
			resetZoom: "Vis alt",
			resetZoomTitle: "Nullstill zoom",
			loading: "Lastar …",
		},
		chart: {
			backgroundColor: "transparent",
			style: { fontFamily: '"Space Grotesk", sans-serif' },
		},
		credits: { enabled: false },
		accessibility: { enabled: false },
	});
}

init();

async function init() {
	try {
		const res = await fetch(API_JOURNEY, { headers: { Accept: "application/json" } });
		if (res.status === 401) {
			location.assign(shareSlug ? location.pathname : "/logg-inn");
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const payload = await res.json();
		state.canWrite = Boolean(payload.canWrite) && !shareSlug;
		state.profile = payload.profile;
		state.data = toEntries(payload.measurements);

		renderChrome();
		if (state.canWrite) bindEntryForm();
		renderAll();
	} catch (error) {
		console.error(error);
		$("loadError").textContent = "Klarte ikkje å hente data frå serveren. Prøv å laste sida på nytt.";
		$("loadError").hidden = false;
	}
}

function toEntries(measurements) {
	return measurements
		.map((m) => ({ date: m.date, weight: Number(m.weight), t: dateToUtc(m.date) }))
		.sort((a, b) => a.t - b.t);
}

// ---------- Retning: «rett veg» er ned for slankarar og opp for bulkarar ----------

function isDown() {
	return state.profile.direction !== "opp";
}

/** Positivt tal = framgang i ønskt retning. */
function progressOf(delta) {
	return isDown() ? -delta : delta;
}

// ---------- Ramme (overskrift, meny, skjema) ----------

function renderChrome() {
	const { displayName } = state.profile;
	const osName = isDown() ? "Slanke-OS" : "Bulke-OS";

	document.title = `${displayName} sitt ${osName}`;
	$("title").textContent = `${displayName} sitt ${osName}`;
	$("kicker").textContent = shareSlug ? `Delt reise` : `Prosjekt ${displayName} ${new Date().getFullYear()}`;
	$("lead").textContent = isDown()
		? "Humor, heider og harde fakta. Her følgjer vi reisa kilo for kilo, med applaus for sigrar og venleg erting i motbakkane."
		: "Kilo for kilo i riktig retning – oppover. Applaus for kvar framgang, og venleg erting når vekta prøver å rømme.";

	$("ownerNav").hidden = !state.canWrite;
	$("readonlyBadge").hidden = state.canWrite;
	$("entryPanel").hidden = !state.canWrite;
	document.body.classList.toggle("readonly", !state.canWrite);
}

function bindEntryForm() {
	$("dateInput").value = todayIso();
	$("dateInput").max = todayIso();
	$("dateInput").addEventListener("input", renderDateHint);

	$("fillGapButton").addEventListener("click", () => {
		setEntryDate($("fillGapButton").dataset.date);
		$("weightInput").focus();
	});

	$("entryForm").addEventListener("submit", async (event) => {
		event.preventDefault();
		const date = $("dateInput").value;
		const weight = roundOne(Number(String($("weightInput").value).replace(",", ".")));

		if (!date || !Number.isFinite(weight)) {
			setFeedback("Fyll inn gyldig dato og vekt.", "error");
			return;
		}

		// «Endre» i tabellen er ei medviten overskriving; elles spør vi først.
		const existing = findEntry(date);
		let overwrite = state.editingDate === date;
		if (existing && existing.weight !== weight && !overwrite) {
			if (!confirmOverwrite(date, existing.weight, weight)) {
				setFeedback(`Ingenting vart endra. ${formatDate(date)} har framleis ${formatKg(existing.weight)}.`);
				return;
			}
			overwrite = true;
		}

		const previous = state.data.filter((e) => e.date < date).pop();
		let result = await saveMeasurement(date, weight, overwrite);

		// Nokon (t.d. ei anna fane) har lagra på same dato i mellomtida.
		if (result.conflict) {
			if (!confirmOverwrite(date, result.conflict.weight, weight)) {
				setFeedback(`Ingenting vart endra. ${formatDate(date)} har framleis ${formatKg(result.conflict.weight)}.`);
				await reload();
				return;
			}
			result = await saveMeasurement(date, weight, true);
		}
		if (!result.ok) return;

		state.editingDate = null;
		await reload();

		const delta = previous ? roundOne(weight - previous.weight) : null;
		const comment = delta === null ? "Første måling er i boks!" : makeDailyComment(delta);
		let message;
		if (result.data.unchanged) {
			message = `${formatDate(date)} hadde allereie ${formatKg(weight)} – ingenting å endre.`;
		} else if (result.data.replaced !== null && result.data.replaced !== undefined) {
			message = `Bytte ut ${formatKg(result.data.replaced)} med ${formatKg(weight)} for ${formatDate(date)}.`;
		} else {
			message = `Lagra ${formatKg(weight)} for ${formatDate(date)}. ${comment}`;
		}

		// Fører ein inn bakover i tid, hoppar vi rett til neste dag som manglar.
		if (date < todayIso()) {
			const next = nextMissingDate(date);
			setEntryDate(next);
			if (next !== todayIso() || !findEntry(next)) message += ` Neste dag utan måling: ${formatDate(next)}.`;
		}

		setFeedback(message, "ok");
		$("weightInput").value = "";
		$("weightInput").focus();
	});

	$("recentTable").addEventListener("click", async (event) => {
		const button = event.target.closest("button[data-action]");
		if (!button) return;
		const { action, date, weight } = button.dataset;

		if (action === "edit") {
			state.editingDate = date;
			setEntryDate(date);
			$("weightInput").value = weight;
			$("weightInput").focus();
			$("entryPanel").scrollIntoView({ behavior: "smooth", block: "center" });
			setFeedback(`Endrar målinga for ${formatDate(date)}. Skriv ny vekt og lagre.`);
		}

		if (action === "delete" && confirm(`Slette målinga ${formatKg(Number(weight))} frå ${formatDate(date)}?`)) {
			if (await request("DELETE", `/api/malingar/${date}`)) {
				await reload();
				setFeedback(`Sletta målinga for ${formatDate(date)}.`, "ok");
			}
		}
	});
}

function confirmOverwrite(date, oldWeight, newWeight) {
	return confirm(
		`Du har allereie registrert ${formatKg(oldWeight)} for ${formatDate(date)}.\n\n` +
			`Vil du byte det ut med ${formatKg(newWeight)}?`
	);
}

async function saveMeasurement(date, weight, overwrite) {
	try {
		const res = await fetch(`/api/malingar/${date}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ weight, overwrite }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) return { ok: true, data };
		if (res.status === 409 && data.existing) return { ok: false, conflict: data.existing };
		setFeedback(data.error || "Noko gjekk gale ved lagring.", "error");
	} catch {
		setFeedback("Nettverksfeil. Prøv igjen.", "error");
	}
	return { ok: false };
}

function findEntry(date) {
	return state.data.find((e) => e.date === date);
}

function setEntryDate(date) {
	if (state.editingDate && state.editingDate !== date) state.editingDate = null;
	$("dateInput").value = date;
	renderDateHint();
}

/** Første dato etter `date` utan måling, men aldri seinare enn i dag. */
function nextMissingDate(date) {
	const today = todayIso();
	let d = addDays(date, 1);
	while (d < today && findEntry(d)) d = addDays(d, 1);
	return d > today ? today : d;
}

/** Viser under datofeltet om datoen alt har ei måling. */
function renderDateHint() {
	const hint = $("dateHint");
	const date = $("dateInput").value;
	const existing = date ? findEntry(date) : null;
	hint.classList.toggle("taken", Boolean(existing));
	hint.textContent = existing
		? `Allereie registrert: ${formatKg(existing.weight)}`
		: date
			? "Ingen måling denne dagen enno."
			: "";
}

/** Linja over skjemaet: når var siste måling, og manglar det dagar? */
function renderEntryStatus() {
	const box = $("entryStatus");
	const button = $("fillGapButton");
	const last = state.data[state.data.length - 1];
	box.hidden = !last;
	if (!last) return;

	const today = todayIso();
	const daysAgo = Math.round((dateToUtc(today) - last.t) / DAY);
	const missing = Math.max(0, daysAgo - 1);

	let text;
	if (daysAgo <= 0) text = `Dagens måling er registrert: ${formatKg(last.weight)}.`;
	else if (daysAgo === 1) text = `Sist registrert i går (${formatKg(last.weight)}).`;
	else text = `Sist registrert ${formatDate(last.date)} (${formatKg(last.weight)}) – ${daysAgo} dagar sidan.`;

	if (missing > 0) text += ` ${missing === 1 ? "1 dag manglar" : `${missing} dagar manglar`} før i dag.`;

	$("entryStatusText").textContent = text;
	box.classList.toggle("has-gap", missing > 0);
	button.hidden = missing === 0;
	if (missing > 0) {
		button.dataset.date = addDays(last.date, 1);
		button.textContent = `Fyll inn frå ${formatDate(button.dataset.date)}`;
	}
}

async function request(method, url, body) {
	try {
		const res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (res.ok) return true;
		const err = await res.json().catch(() => ({}));
		setFeedback(err.error || "Noko gjekk gale ved lagring.", "error");
	} catch {
		setFeedback("Nettverksfeil. Prøv igjen.", "error");
	}
	return false;
}

async function reload() {
	const res = await fetch(API_JOURNEY, { headers: { Accept: "application/json" } });
	if (!res.ok) return;
	const payload = await res.json();
	state.profile = payload.profile;
	state.data = toEntries(payload.measurements);
	renderAll();
}

function setFeedback(text, kind = "") {
	const el = $("formFeedback");
	el.textContent = text;
	el.dataset.kind = kind;
}

// ---------- Teikning ----------

function renderAll() {
	const hasData = state.data.length > 0;
	if (state.canWrite) {
		renderEntryStatus();
		renderDateHint();
	}
	$("journey").hidden = !hasData;
	$("emptyState").hidden = hasData;
	$("motivationBanner").hidden = !hasData;

	if (!hasData) {
		$("emptyText").textContent = state.canWrite
			? "Her er det ikkje registrert nokon målingar enno. Logg den første vekta di over, så set vi i gang!"
			: `${state.profile.displayName} har ikkje registrert nokon målingar enno. Kom attende seinare!`;
		return;
	}

	renderStatCards();
	renderGoal();
	renderInsights();
	renderWeightChart();
	renderDeltaChart();
	renderMonthTable();
	renderRecentTable();
}

function renderStatCards() {
	const data = state.data;
	const first = data[0];
	const last = data[data.length - 1];
	const total = roundOne(last.weight - first.weight);
	const days = Math.round((last.t - first.t) / DAY);
	const weekly = days >= 7 ? roundOne(total / (days / 7)) : null;

	$("startWeight").textContent = formatKg(first.weight);
	$("startDate").textContent = formatDate(first.date);
	$("latestWeight").textContent = formatKg(last.weight);
	$("latestDate").textContent = formatDate(last.date);
	$("totalChange").textContent = `${formatSigned(total)} kg`;
	$("totalDays").textContent = days === 1 ? "på 1 dag" : `på ${days} dagar`;
	$("weeklyAverage").textContent = weekly === null ? "–" : `${formatSigned(weekly)} kg`;

	setTone($("totalChange").closest(".stat-card"), progressOf(total));

	const heightM = state.profile.heightCm ? state.profile.heightCm / 100 : null;
	$("bmiCard").hidden = !heightM;
	if (heightM) {
		const bmi = last.weight / (heightM * heightM);
		$("bmiValue").textContent = bmi.toFixed(1).replace(".", ",");
		$("bmiCategory").textContent = bmiCategory(bmi);
	}
}

function bmiCategory(bmi) {
	if (bmi < 18.5) return "Undervekt";
	if (bmi < 25) return "Normalvekt";
	if (bmi < 30) return "Overvekt";
	return "Fedme";
}

function renderGoal() {
	const goal = state.profile.goalWeight;
	$("goalPanel").hidden = goal === null || goal === undefined;
	if ($("goalPanel").hidden) return;

	const start = state.data[0].weight;
	const latest = state.data[state.data.length - 1].weight;
	const span = start - goal;
	$("goalStartLabel").textContent = `Start ${formatKg(start)}`;
	$("goalTargetLabel").textContent = `Mål ${formatKg(goal)}`;

	if (progressOf(goal - start) <= 0) {
		$("goalFill").style.width = "0%";
		$("goalPercent").textContent = "";
		$("goalSummary").textContent = "Sjekk målet";
		$("goalEta").textContent = `Målvekta (${formatKg(goal)}) ligg ${isDown() ? "over" : "under"} startvekta, men reisa går ${isDown() ? "nedover" : "oppover"}. Endre målet eller retninga under Innstillingar.`;
		return;
	}

	const reached = isDown() ? latest <= goal : latest >= goal;
	const pct = reached ? 100 : span === 0 ? 0 : clamp(((start - latest) / span) * 100, 0, 100);
	const remaining = roundOne(Math.abs(latest - goal));

	$("goalFill").style.width = `${pct}%`;
	$("goalBar").setAttribute("aria-valuenow", Math.round(pct));
	$("goalPercent").textContent = `${Math.round(pct)} %`;

	if (reached) {
		$("goalSummary").textContent = "Målet er nådd! 🎉";
		$("goalEta").textContent = `${state.profile.displayName} har nådd målvekta. Tid for å feire – med måte.`;
		return;
	}

	$("goalSummary").textContent = `${formatKg(remaining)} att`;
	$("goalEta").textContent = estimateGoalText(goal);
}

/** Lineær regresjon over dei siste 28 dagane for å anslå når målet vert nådd. */
function estimateGoalText(goal) {
	const last = state.data[state.data.length - 1];
	const recent = state.data.filter((e) => e.t >= last.t - 28 * DAY);
	if (recent.length < 5 || (last.t - recent[0].t) / DAY < 7) {
		return "Trenden kjem når det er nokre fleire målingar dei siste vekene.";
	}

	const slopePerDay = linearSlope(recent.map((e) => [(e.t - recent[0].t) / DAY, e.weight]));
	const weekly = roundOne(slopePerDay * 7);
	const trendText = `Trenden siste fire veker: ${formatSigned(weekly)} kg/veke.`;

	if (progressOf(slopePerDay) <= 0.001) {
		return `${trendText} I dette tempoet kjem vi ikkje nærare målet – men ein god veke snur det fort.`;
	}

	const daysLeft = Math.abs(goal - last.weight) / Math.abs(slopePerDay);
	if (daysLeft > 3 * 365) {
		return `${trendText} I dette tempoet tek det meir enn tre år. Tolmod er ein dygd.`;
	}

	const eta = new Date(last.t + daysLeft * DAY);
	return `${trendText} Held det fram slik, er målet nådd rundt ${formatDate(eta)}.`;
}

function renderInsights() {
	const data = state.data;
	const { best, worst } = findBestAndWorstWeek(data);
	const name = state.profile.displayName;

	if (best && progressOf(best.delta) > 0) {
		$("bestPeriodText").textContent = `${formatDate(best.from)}–${formatDate(best.to)}: ${formatKg(Math.abs(best.delta))} ${isDown() ? "ned" : "opp"}. Kongerunde!`;
	} else {
		$("bestPeriodText").textContent = best
			? "Ingen veke har gått rett veg enno. Den første kjem snart!"
			: "Treng minst ei veke med målingar for å finne beste veke.";
	}

	if (worst && progressOf(worst.delta) < 0) {
		const joke = isDown() ? "Her var det kanskje helgekos deluxe." : "Her gløymde visst nokon å ete.";
		$("worstPeriodText").textContent = `${formatDate(worst.from)}–${formatDate(worst.to)}: ${formatKg(Math.abs(worst.delta))} ${isDown() ? "opp" : "ned"}. ${joke}`;
	} else {
		$("worstPeriodText").textContent = worst
			? `Ingen veke har gått feil veg. ${name} er rett og slett ustoppeleg.`
			: "Treng minst ei veke med målingar for å finne tøffaste veke.";
	}

	const latestDelta = data.length > 1 ? roundOne(data[data.length - 1].weight - data[data.length - 2].weight) : null;
	$("dailyComment").textContent =
		latestDelta === null ? "Første måling er i boks. Dommaren ventar på neste." : makeDailyComment(latestDelta);

	$("motivationBanner").textContent = makeMotivationBanner(data);
}

/**
 * Finn sju-dagars-periodane med størst framgang og størst tilbakegang.
 * Kvar periode går frå ei måling til den siste målinga som ligg minst sju dagar tidlegare.
 */
function findBestAndWorstWeek(data) {
	let best = null;
	let worst = null;
	let j = 0;

	for (let i = 0; i < data.length; i += 1) {
		while (j + 1 < i && data[j + 1].t <= data[i].t - 7 * DAY) j += 1;
		if (data[i].t - data[j].t < 7 * DAY || data[i].t - data[j].t > 14 * DAY) continue;

		const window = { from: data[j].date, to: data[i].date, delta: roundOne(data[i].weight - data[j].weight) };
		if (!best || progressOf(window.delta) > progressOf(best.delta)) best = window;
		if (!worst || progressOf(window.delta) < progressOf(worst.delta)) worst = window;
	}

	return { best, worst };
}

function renderWeightChart() {
	const data = state.data;
	const goal = state.profile.goalWeight;
	const weights = data.map((e) => [e.t, e.weight]);
	const average = movingAverage(data, 7);

	const options = {
		chart: { type: "areaspline", zooming: { type: "x" }, height: 380 },
		title: { text: null },
		xAxis: { type: "datetime", crosshair: true, lineColor: COLORS.grid },
		yAxis: {
			title: { text: "kg" },
			gridLineColor: COLORS.grid,
			softMin: goal ?? undefined,
			softMax: goal ?? undefined,
			plotLines: goal
				? [
						{
							value: goal,
							color: COLORS.goal,
							width: 2,
							dashStyle: "LongDash",
							zIndex: 3,
							label: { text: `Mål: ${formatKg(goal)}`, align: "right", style: { color: COLORS.goal, fontWeight: "700" } },
						},
					]
				: [],
		},
		tooltip: {
			shared: true,
			xDateFormat: "%A %e. %B %Y",
			valueSuffix: " kg",
			valueDecimals: 1,
		},
		legend: { align: "left", verticalAlign: "top", symbolRadius: 6 },
		plotOptions: {
			series: { marker: { enabled: data.length < 40, radius: 3 }, animation: { duration: 600 } },
		},
		series: [
			{
				name: "Vekt",
				data: weights,
				color: COLORS.weight,
				lineWidth: 2.4,
				fillColor: {
					linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
					stops: [
						[0, "rgba(10, 147, 150, 0.28)"],
						[1, "rgba(10, 147, 150, 0.02)"],
					],
				},
				threshold: null,
			},
			{
				name: "7-dagars snitt",
				type: "spline",
				data: average,
				color: COLORS.average,
				dashStyle: "ShortDash",
				lineWidth: 2,
				marker: { enabled: false },
				enableMouseTracking: true,
			},
		],
	};

	if (state.charts.weight) state.charts.weight.destroy();
	state.charts.weight = Highcharts.chart("weightChart", options);
}

function renderDeltaChart() {
	const data = state.data;
	const points = [];
	for (let i = 1; i < data.length; i += 1) {
		const delta = roundOne(data[i].weight - data[i - 1].weight);
		points.push({ x: data[i].t, y: delta, color: progressOf(delta) >= 0 ? COLORS.good : COLORS.bad });
	}

	if (state.charts.delta) state.charts.delta.destroy();
	state.charts.delta = Highcharts.chart("deltaChart", {
		chart: { type: "column", zooming: { type: "x" }, height: 260 },
		title: { text: null },
		legend: { enabled: false },
		xAxis: { type: "datetime", lineColor: COLORS.grid },
		yAxis: {
			title: { text: "kg" },
			gridLineColor: COLORS.grid,
			plotLines: [{ value: 0, color: "rgba(34,32,24,0.35)", width: 1, zIndex: 2 }],
		},
		tooltip: {
			xDateFormat: "%A %e. %B %Y",
			pointFormatter() {
				return `Endring sidan førre måling: <b>${formatSigned(this.y)} kg</b>`;
			},
		},
		plotOptions: { column: { borderRadius: 4, borderWidth: 0, pointPadding: 0.05, groupPadding: 0.05 } },
		series: [{ name: "Endring", data: points }],
	});
}

function renderMonthTable() {
	const months = new Map();
	for (const e of state.data) {
		const key = e.date.slice(0, 7);
		if (!months.has(key)) months.set(key, []);
		months.get(key).push(e);
	}

	let previousLast = null;
	const rows = [];
	for (const [key, entries] of months) {
		const avg = entries.reduce((s, e) => s + e.weight, 0) / entries.length;
		const last = entries[entries.length - 1].weight;
		const base = previousLast ?? entries[0].weight;
		const change = roundOne(last - base);
		previousLast = last;
		rows.push({ key, count: entries.length, avg, change });
	}

	$("monthTable").replaceChildren(
		...rows.reverse().map((r) =>
			tableRow([
				formatMonth(r.key),
				String(r.count),
				formatKg(r.avg),
				{ text: `${formatSigned(r.change)} kg`, tone: progressOf(r.change) },
			])
		)
	);
}

function renderRecentTable() {
	const data = state.data;
	const recent = [];
	for (let i = data.length - 1; i >= 0 && recent.length < 10; i -= 1) {
		const delta = i > 0 ? roundOne(data[i].weight - data[i - 1].weight) : null;
		recent.push({ ...data[i], delta });
	}

	$("recentTable").replaceChildren(
		...recent.map((e) => {
			const cells = [
				formatDate(e.date),
				formatKg(e.weight),
				e.delta === null ? "Start" : { text: `${formatSigned(e.delta)} kg`, tone: progressOf(e.delta) },
			];
			const row = tableRow(cells);
			if (state.canWrite) {
				const td = document.createElement("td");
				td.className = "row-actions";
				td.append(
					actionButton("edit", "Endre", e),
					actionButton("delete", "Slett", e)
				);
				row.append(td);
			}
			return row;
		})
	);
}

function tableRow(cells) {
	const tr = document.createElement("tr");
	for (const cell of cells) {
		const td = document.createElement("td");
		if (typeof cell === "object") {
			td.textContent = cell.text;
			setTone(td, cell.tone);
		} else {
			td.textContent = cell;
		}
		tr.append(td);
	}
	return tr;
}

function actionButton(action, label, entry) {
	const b = document.createElement("button");
	b.type = "button";
	b.className = `mini ${action === "delete" ? "danger" : ""}`;
	b.textContent = label;
	b.dataset.action = action;
	b.dataset.date = entry.date;
	b.dataset.weight = entry.weight;
	return b;
}

function setTone(el, progress) {
	el.classList.toggle("tone-good", progress > 0);
	el.classList.toggle("tone-bad", progress < 0);
}

// ---------- Humor ----------

function makeDailyComment(delta) {
	const p = progressOf(delta);
	if (p >= 0.5) return "Sterk dag! Vekta gjekk rett veg, og kaffien smakar ekstra siger.";
	if (p > 0) return "Litt i rett retning er framleis rett retning. Stødig og smart.";
	if (p === 0) return "Dønn stabil. Kroppen forhandlar, men du leier framleis møtet.";
	if (p > -0.5) return "Litt feil veg i dag. Heilt normalt – det er kursen over tid som tel.";
	return "Ein dump i vegen. Nye tak i morgon, og soga held fram.";
}

function makeMotivationBanner(data) {
	const name = state.profile.displayName;
	if (data.length < 2) return `Første måling er registrert. No byrjar moroa, ${name}!`;

	const total = roundOne(data[data.length - 1].weight - data[0].weight);
	const p = progressOf(total);
	const abs = formatKg(Math.abs(total));

	const options =
		p > 0
			? [
					`Total endring: ${formatSigned(total)} kg. ${name} er i praksis sin eigen PT, berre med betre humør.`,
					isDown()
						? `Status: ${abs} i rett retning sidan start. Det er meir enn ein stor julemiddag!`
						: `Status: ${abs} i rett retning sidan start. Det er ein heil pinnekjøttmiddag med tilbehøyr!`,
					`Tal lyg ikkje: ${formatSigned(total)} kg sidan start. Rein kvardagsheltenergi.`,
				]
			: p === 0
				? [`Nøyaktig same vekt som ved start. ${name} har funne balansen – no gjeld det berre å vippe han rett veg.`]
				: [
						`Så langt ${formatSigned(total)} kg sidan start. Kvar reise har motbakkar, og denne er visst bratt.`,
						`Status: ${formatSigned(total)} kg. Ikkje panikk – Roma vart ikkje bygd på ein dag heller.`,
					];

	return options[Math.floor(Math.random() * options.length)];
}

// ---------- Hjelparar ----------

function movingAverage(data, days) {
	let start = 0;
	let sum = 0;
	return data.map((e, i) => {
		sum += e.weight;
		while (data[start].t <= e.t - days * DAY) {
			sum -= data[start].weight;
			start += 1;
		}
		return [e.t, roundOne(sum / (i - start + 1))];
	});
}

function linearSlope(points) {
	const n = points.length;
	const mx = points.reduce((s, [x]) => s + x, 0) / n;
	const my = points.reduce((s, [, y]) => s + y, 0) / n;
	let num = 0;
	let den = 0;
	for (const [x, y] of points) {
		num += (x - mx) * (y - my);
		den += (x - mx) ** 2;
	}
	return den === 0 ? 0 : num / den;
}

function dateToUtc(iso) {
	const [y, m, d] = iso.split("-").map(Number);
	return Date.UTC(y, m - 1, d);
}

function addDays(iso, days) {
	return new Date(dateToUtc(iso) + days * DAY).toISOString().slice(0, 10);
}

function todayIso() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function clamp(v, min, max) {
	return Math.min(max, Math.max(min, v));
}

function roundOne(value) {
	return Math.round(value * 10) / 10;
}

function formatKg(value) {
	return `${value.toFixed(1).replace(".", ",")} kg`;
}

function formatSigned(value) {
	const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
	return `${sign}${Math.abs(value).toFixed(1).replace(".", ",")}`;
}

function formatDate(value) {
	const date = typeof value === "string" ? new Date(dateToUtc(value)) : value;
	return date.toLocaleDateString("nn-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function formatMonth(key) {
	const [y, m] = key.split("-").map(Number);
	const text = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("nn-NO", { month: "long", year: "numeric", timeZone: "UTC" });
	return text.charAt(0).toUpperCase() + text.slice(1);
}
