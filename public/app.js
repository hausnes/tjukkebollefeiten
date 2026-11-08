// ---------- Oppsett ----------

const DAY = 24 * 60 * 60 * 1000;
const COLORS = {
	weight: "#0a9396",
	average: "#ca6702",
	goal: "#2a9d8f",
	good: "rgba(42, 157, 143, 0.85)",
	bad: "rgba(187, 62, 3, 0.8)",
	grid: "rgba(34, 32, 24, 0.09)",
	event: "#6a4c93",
	headwind: "rgba(202, 103, 2, 0.11)",
	tailwind: "rgba(42, 157, 143, 0.13)",
	neutral: "rgba(0, 95, 115, 0.07)",
};

/** Kategoriar for hendingar. `effect` er standardforslaget for venta effekt på vekta. */
const EVENT_CATEGORIES = {
	kos: { emoji: "🍰", label: "Kos og fest", effect: "opp" },
	drikke: { emoji: "🍺", label: "Drikke og brygg", effect: "opp" },
	hoytid: { emoji: "🎄", label: "Høgtid og ferie", effect: "opp" },
	trening: { emoji: "🏃", label: "Trening", effect: "ned" },
	tur: { emoji: "🏔️", label: "Tur og friluft", effect: "ned" },
	stress: { emoji: "😩", label: "Stress og travelt", effect: "opp" },
	sjukdom: { emoji: "🤒", label: "Sjukdom", effect: "ukjend" },
	kosthald: { emoji: "🥗", label: "Kosthald og vanar", effect: "ned" },
	anna: { emoji: "📌", label: "Anna", effect: "ukjend" },
};

const shareSlug = (location.pathname.match(/^\/d\/([^/]+)/) || [])[1];
const API_JOURNEY = shareSlug ? `/api/d/${encodeURIComponent(shareSlug)}/reise` : "/api/reise";

const state = {
	canWrite: false,
	profile: null,
	data: [], // [{ date: "YYYY-MM-DD", weight: 93.7, t: <ms UTC> }]
	events: [], // [{ id, kind: "dag"|"periode", startDate, endDate, category, effect, title, note, private }]
	showEventBands: true,
	editingEventId: null,
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
		state.events = payload.events || [];

		renderChrome();
		if (state.canWrite) {
			bindEntryForm();
			bindEventForm();
		}
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
		const comment = delta === null ? "Første måling er i boks!" : makeDailyComment(delta, date);
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
	state.events = payload.events || [];
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
	renderEvents();
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

	const slopePerDay = slopeOf(recent);
	const trendText = `Trenden siste fire veker: ${formatSigned(roundOne(slopePerDay * 7))} kg/veke.`;
	return `${trendText} ${goalPaceText(slopePerDay, goal, last)}${headwindForecastText(recent, goal, last)}`;
}

function goalPaceText(slopePerDay, goal, last) {
	if (progressOf(slopePerDay) <= 0.001) {
		return "I dette tempoet kjem vi ikkje nærare målet – men ein god veke snur det fort.";
	}
	const daysLeft = Math.abs(goal - last.weight) / Math.abs(slopePerDay);
	if (daysLeft > 3 * 365) return "I dette tempoet tek det meir enn tre år. Tolmod er ein dygd.";
	return `Held det fram slik, er målet nådd rundt ${formatDate(new Date(last.t + daysLeft * DAY))}.`;
}

/**
 * Har det vore motvind (hendingar som dreg feil veg) i trendvindauget, reknar vi trenden på nytt
 * utan dagane hendingane kan ha påverka – og ertar litt, uansett kva svaret vert.
 */
function headwindForecastText(recent, goal, last) {
	const window = [recent[0].date, last.date];
	const headwinds = state.events.filter((ev) => windOf(ev) < 0 && overlaps(impactRange(ev), window));
	if (!headwinds.length) return "";

	const names =
		headwinds.length > 2
			? `${eventName(headwinds[0])}, ${eventName(headwinds[1])} m.fl.`
			: headwinds.map(eventName).join(" og ");
	const clean = recent.filter((m) => !headwinds.some((ev) => inRange(m.date, impactRange(ev))));

	let text;
	if (clean.length < 5 || daysBetween(clean[0].date, clean[clean.length - 1].date) < 7) {
		text = ` ${names} pregar så mykje av perioden at prognosen er meir gjetting enn vitskap.`;
	} else {
		const adjusted = slopeOf(clean);
		const adjustedWeekly = formatSigned(roundOne(adjusted * 7));
		if (progressOf(adjusted) > 0.001) {
			const daysLeft = Math.abs(goal - last.weight) / Math.abs(adjusted);
			const when = daysLeft > 3 * 365 ? "om meir enn tre år" : `rundt ${formatDate(new Date(last.t + daysLeft * DAY))}`;
			text = ` Reknar vi bort ${names}, er trenden ${adjustedWeekly} kg/veke – og målet nådd ${when}. Så no veit du kva som står i vegen.`;
		} else {
			text = ` Sjølv om vi reknar bort ${names}, går det feil veg (${adjustedWeekly} kg/veke). Det er altså ikkje berre «${headwinds[0].title}» si skuld.`;
		}
	}

	const ending = headwinds.find((ev) => isOngoing(ev) && ev.endDate);
	const open = headwinds.find((ev) => isOngoing(ev) && !ev.endDate);
	if (ending) text += ` ${eventName(ending)} varer til ${formatDate(ending.endDate)} – etter det bør kurva rette seg opp. I teorien.`;
	else if (open) text += ` ${eventName(open)} har inga sluttdato. Det seier eigentleg alt.`;
	return text;
}

function renderInsights() {
	const data = state.data;
	const { best, worst } = findBestAndWorstWeek(data);
	const name = state.profile.displayName;

	if (best && progressOf(best.delta) > 0) {
		const around = eventsAround(best.from, best.to);
		const tailwind = around.find((ev) => windOf(ev) > 0);
		const headwind = around.find((ev) => windOf(ev) < 0);
		const joke = tailwind
			? `${eventName(tailwind)} hjelpte nok til.`
			: headwind
				? `${headwind.kind === "dag" ? "Rett etter" : "Midt i"} ${eventName(headwind)}! Det er rett og slett frekt.`
				: "Kongerunde!";
		$("bestPeriodText").textContent = `${formatDate(best.from)}–${formatDate(best.to)}: ${formatKg(Math.abs(best.delta))} ${isDown() ? "ned" : "opp"}. ${joke}`;
	} else {
		$("bestPeriodText").textContent = best
			? "Ingen veke har gått rett veg enno. Den første kjem snart!"
			: "Treng minst ei veke med målingar for å finne beste veke.";
	}

	if (worst && progressOf(worst.delta) < 0) {
		const around = eventsAround(worst.from, worst.to);
		const headwind = around.find((ev) => windOf(ev) < 0);
		const joke = headwind
			? `Ikkje rart: ${eventName(headwind)} var i sving.`
			: around.length
				? `${eventName(around[0])} kan ha hatt noko med saka å gjere.`
				: isDown()
					? "Her var det kanskje helgekos deluxe."
					: "Her gløymde visst nokon å ete.";
		$("worstPeriodText").textContent = `${formatDate(worst.from)}–${formatDate(worst.to)}: ${formatKg(Math.abs(worst.delta))} ${isDown() ? "opp" : "ned"}. ${joke}`;
	} else {
		$("worstPeriodText").textContent = worst
			? `Ingen veke har gått feil veg. ${name} er rett og slett ustoppeleg.`
			: "Treng minst ei veke med målingar for å finne tøffaste veke.";
	}

	const latestDelta = data.length > 1 ? roundOne(data[data.length - 1].weight - data[data.length - 2].weight) : null;
	$("dailyComment").textContent =
		latestDelta === null
			? "Første måling er i boks. Dommaren ventar på neste."
			: makeDailyComment(latestDelta, data[data.length - 1].date);

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

	if (state.events.length) {
		options.xAxis.plotBands = state.showEventBands ? eventPlotBands(true) : [];
		options.series.push(eventSeries());
	}

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
		xAxis: { type: "datetime", lineColor: COLORS.grid, plotBands: state.showEventBands ? eventPlotBands(false) : [] },
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

// ---------- Hendingar: grunnlag ----------

function categoryOf(ev) {
	return EVENT_CATEGORIES[ev.category] || EVENT_CATEGORIES.anna;
}

function eventName(ev) {
	return `${categoryOf(ev).emoji} ${ev.title}`;
}

/** Siste dag hendinga gjeld: sluttdatoen, eller i dag for periodar som framleis pågår. */
function eventEnd(ev) {
	if (ev.kind === "dag") return ev.startDate;
	return ev.endDate ?? maxIso(todayIso(), ev.startDate);
}

function isOngoing(ev) {
	const today = todayIso();
	return ev.kind === "periode" && ev.startDate <= today && (!ev.endDate || ev.endDate >= today);
}

function isPlanned(ev) {
	return ev.startDate > todayIso();
}

/** Kva vekta er venta å gjere: +1 opp, −1 ned, 0 veit ikkje. */
function effectSign(ev) {
	return ev.effect === "opp" ? 1 : ev.effect === "ned" ? -1 : 0;
}

/** +1 = medvind (hjelper målet), −1 = motvind, 0 = nøytral. Avheng av om brukaren vil opp eller ned. */
function windOf(ev) {
	return Math.sign(progressOf(effectSign(ev))) || 0;
}

/**
 * Datoane der hendinga kan ha påverka vekta. Ein stor middag viser seg først dagen etter,
 * og vatn og salt heng gjerne att nokre dagar.
 */
function impactRange(ev) {
	if (ev.kind === "dag") return [addDays(ev.startDate, 1), addDays(ev.startDate, 3)];
	return [ev.startDate, addDays(eventEnd(ev), 3)];
}

/** Den nyaste hendinga som kan forklare målinga på `date`. */
function eventInPlay(date) {
	return state.events
		.filter((ev) => inRange(date, impactRange(ev)) && ev.startDate <= date)
		.sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
}

/** Hendingar som verka inn på perioden from–to. */
function eventsAround(from, to) {
	return state.events.filter((ev) => overlaps(impactRange(ev), [from, to]));
}

function measurementsBetween(from, to) {
	return state.data.filter((e) => e.date >= from && e.date <= to);
}

function meanWeight(entries) {
	return entries.length ? entries.reduce((s, e) => s + e.weight, 0) / entries.length : null;
}

/** Interpolert vekt på eit tidspunkt (for å plassere hendingar på kurva). */
function weightAtTime(t) {
	const data = state.data;
	if (t <= data[0].t) return data[0].weight;
	const i = data.findIndex((e) => e.t >= t);
	if (i === -1) return data[data.length - 1].weight;
	const a = data[i - 1];
	const b = data[i];
	return roundOne(a.weight + ((b.weight - a.weight) * (t - a.t)) / (b.t - a.t));
}

// ---------- Hendingar: analyse ----------

/**
 * Kva skjedde med vekta rundt hendinga?
 * Éin dag: største utslag 1–3 dagar etter, samanlikna med siste måling før, og kor fort det gjekk over.
 * Periode: 7-dagars snitt før start mot snittet på slutten, pluss trenden før og utviklinga etterpå.
 */
function analyzeEvent(ev) {
	if (isPlanned(ev)) return { status: "planned" };
	if (!state.data.length) return { status: "insufficient" };
	return ev.kind === "dag" ? analyzeDay(ev) : analyzePeriod(ev);
}

function analyzeDay(ev) {
	const pre = measurementsBetween(addDays(ev.startDate, -3), ev.startDate).pop();
	const post = measurementsBetween(addDays(ev.startDate, 1), addDays(ev.startDate, 3));
	if (!pre || !post.length) return { status: "insufficient" };

	const sign = effectSign(ev);
	const score = (e) => (sign ? (e.weight - pre.weight) * sign : Math.abs(e.weight - pre.weight));
	const peak = post.reduce((best, e) => (score(e) > score(best) ? e : best));
	const change = roundOne(peak.weight - pre.weight);

	let recoveryDays = null;
	let recoveryOpen = false;
	if (Math.abs(change) >= 0.3) {
		const deadline = addDays(ev.startDate, 14);
		const back = measurementsBetween(addDays(peak.date, 1), deadline).find(
			(e) => (e.weight - pre.weight) * Math.sign(change) <= 0.1
		);
		if (back) recoveryDays = daysBetween(ev.startDate, back.date);
		else recoveryOpen = state.data[state.data.length - 1].date < deadline;
	}
	return { status: "ok", change, recoveryDays, recoveryOpen };
}

function analyzePeriod(ev) {
	const inside = measurementsBetween(ev.startDate, eventEnd(ev));
	if (inside.length < 2) return { status: "insufficient" };

	const before = measurementsBetween(addDays(ev.startDate, -7), addDays(ev.startDate, -1));
	const base = before.length ? meanWeight(before) : inside[0].weight;
	const lastDate = inside[inside.length - 1].date;
	const endValue = meanWeight(measurementsBetween(maxIso(ev.startDate, addDays(lastDate, -6)), lastDate));
	const change = roundOne(endValue - base);
	const days = daysBetween(ev.startDate, lastDate) + 1;

	const trendBefore = measurementsBetween(addDays(ev.startDate, -28), addDays(ev.startDate, -1));
	const beforeWeekly =
		trendBefore.length >= 4 && daysBetween(trendBefore[0].date, trendBefore[trendBefore.length - 1].date) >= 7
			? roundOne(slopeOf(trendBefore) * 7)
			: null;

	let afterChange = null;
	let afterDays = null;
	if (ev.endDate && ev.endDate < todayIso()) {
		const after = measurementsBetween(addDays(ev.endDate, 1), addDays(ev.endDate, 14));
		if (after.length >= 2) {
			afterChange = roundOne(meanWeight(after.slice(-3)) - endValue);
			afterDays = daysBetween(ev.endDate, after[after.length - 1].date);
		}
	}

	return {
		status: "ok",
		change,
		days,
		weekly: days >= 7 ? roundOne((change / days) * 7) : null,
		beforeWeekly,
		afterChange,
		afterDays,
	};
}

function eventStatsText(ev, a) {
	if (a.status === "planned") return "Planlagt. Vekta aner ikkje kva som kjem.";
	if (a.status === "insufficient" && isOngoing(ev) && daysBetween(ev.startDate, todayIso()) < 7) {
		return "Nettopp starta. Dommaren ventar på fleire målingar før dommen fell.";
	}
	if (a.status === "insufficient") return "For få målingar rundt hendinga til å seie noko sikkert. Svært praktisk for nokon.";

	if (ev.kind === "dag") {
		let text = `Utslag dagane etter: ${formatSigned(a.change)} kg.`;
		if (a.recoveryDays !== null) text += ` Tilbake på utgangspunktet etter ${plural(a.recoveryDays, "dag", "dagar")}.`;
		else if (a.recoveryOpen) text += " Ikkje heilt tilbake på utgangspunktet enno.";
		else if (Math.abs(a.change) >= 0.3) text += " Det der vart verande ei stund.";
		return text;
	}

	let text = `I perioden: ${formatSigned(a.change)} kg på ${plural(a.days, "dag", "dagar")}`;
	if (a.weekly !== null) text += ` (${formatSigned(a.weekly)} kg/veke)`;
	text += ".";
	if (a.beforeWeekly !== null) text += ` Trenden før: ${formatSigned(a.beforeWeekly)} kg/veke.`;
	if (a.afterChange !== null) text += ` Etterpå: ${formatSigned(a.afterChange)} kg på ${plural(a.afterDays, "dag", "dagar")}.`;
	return text;
}

// ---------- Hendingar: humor ----------

/**
 * «confirm» = vekta gjorde som venta, «defy» = vekta gjorde det motsette.
 * {t} = tittel, {kg} = endring med forteikn.
 */
const EVENT_JOKES = {
	kos: {
		confirm: [
			"{t} sette spor: {kg}. Det var nok verdt det. Truleg.",
			"{kg} etter {t}. Kroppen hugsar kvar bete, sjølv om du ikkje gjer det.",
		],
		defy: [
			"{t}, og likevel {kg}? Anten var porsjonane små, eller så er vekta bestukken.",
			"{t} utan konsekvensar ({kg}). Vitskapen står fast og klør seg i hovudet.",
		],
	},
	drikke: {
		confirm: [
			"{t}: {kg}. Flytande kalori er framleis kalori, sjølv når han skummar.",
			"{kg} under {t}. Skål – vekta skåla tydelegvis med.",
		],
		defy: [
			"{t} og {kg}? Brygg du lettøl, eller drikk andre det for deg?",
			"Vekta ignorerte {t} fullstendig ({kg}). Mistenkjeleg.",
		],
	},
	hoytid: {
		confirm: [
			"{t} gav {kg}. Tradisjonar skal haldast i hevd, også på badevekta.",
			"{kg} etter {t}. Feriekiloa melde seg til teneste, som venta.",
		],
		defy: [
			"{t} og likevel {kg}. Kven har lært deg sjølvkontroll?",
			"{t} passerte med {kg}. Dette må granskast av ein uavhengig komité.",
		],
	},
	trening: {
		confirm: ["{t}: {kg}. Sveitten var ikkje forgjeves.", "{kg} med {t} på laget. Joggeskorne fortener ein klapp."],
		defy: [
			"{t}, men {kg}. Musklar, seier du? Sikkert. Heilt sikkert.",
			"{t} gav {kg}. Belønningsbollen etter økta tel dessverre òg.",
		],
	},
	tur: {
		confirm: ["{t} gav {kg}. Utsikta var gratis, kiloa betalte du med.", "{kg} etter {t}. Fjellet gir, fjellet tek."],
		defy: [
			"{t}, men {kg}. Kvikklunsj-budsjettet vart visst overskride.",
			"Ein heil {t}, og vekta svarte med {kg}. Turmat er òg mat.",
		],
	},
	stress: {
		confirm: [
			"{t}: {kg}. Kontorstolen og kjeksskåla vann denne runden.",
			"{kg} under {t}. Stress set seg på magen – det er nesten vitskap.",
		],
		defy: ["{t}, men {kg}. Stressmagen gjekk visst motsett veg.", "{t} utan trøysteeting ({kg}). Eller gløymde du berre å ete?"],
	},
	kosthald: {
		confirm: ["{t}: {kg}. Salatbladet får endeleg den respekten det fortener.", "{kg} med {t}. Disiplin kler deg."],
		defy: [
			"{t}, men {kg}. Kanskje dressinga var hovudretten?",
			"{t} har enno ikkje imponert vekta ({kg}). Gi det tid – eller sjekk kjøleskapet.",
		],
	},
	sjukdom: {
		good: ["{t}: {kg}. Ikkje akkurat slankemetoden vi tilrår, men god betring!"],
		bad: ["{t}: {kg}. Sofaen og suppa gjorde jobben sin. God betring!"],
	},
	generic: {
		good: ["{t}: {kg} i rett retning. Uansett kva det var – meir av det!"],
		bad: ["{t}: {kg} feil veg. Vi seier ikkje at det var skuld i det, men vi seier heller ikkje at det ikkje var det."],
	},
	flat: [
		"{t} rikka ikkje vekta ({kg}). Anten er du ein maskin, eller så har du ikkje vege deg nok.",
		"{t} gjekk upåakta hen for vekta ({kg}). Sjølv vekta kjeda seg.",
	],
	rebound: " Og etterpå gjekk det attende igjen. Kroppen tilgir, men gløymer ikkje.",
};

function eventVerdict(ev, a) {
	if (a.status !== "ok") return "";
	const sign = effectSign(ev);
	const jokes = EVENT_JOKES[ev.category];

	let pool;
	if (Math.abs(a.change) < 0.2) pool = EVENT_JOKES.flat;
	else if (sign && jokes && jokes.confirm) pool = Math.sign(a.change) === sign ? jokes.confirm : jokes.defy;
	else {
		const set = jokes && jokes.good ? jokes : EVENT_JOKES.generic;
		pool = progressOf(a.change) > 0 ? set.good : set.bad;
	}

	let text = pick(pool, ev.id).replaceAll("{t}", ev.title).replaceAll("{kg}", `${formatSigned(a.change)} kg`);
	if (a.afterChange !== null && a.afterChange !== undefined && Math.abs(a.change) >= 0.2 && a.afterChange * Math.sign(a.change) <= -0.3) {
		text += EVENT_JOKES.rebound;
	}
	return text;
}

/** Dagens dom når ei hending kan forklare den siste målinga. Null = bruk vanleg kommentar. */
function eventDailyComment(ev, delta) {
	if (Math.abs(delta) < 0.1) return null;
	const sign = effectSign(ev);
	const n = eventName(ev);
	const s = `${formatSigned(delta)} kg`;

	if (!sign) return `${n} i bakgrunnen og ${s} sidan sist. Vi noterer og dømer seinare.`;
	if (Math.sign(delta) === sign) {
		if (ev.kind === "dag") {
			return sign > 0
				? `Dagen derpå etter ${n}: ${s}. Mest vatn og salt – det går over på nokre dagar. Truleg.`
				: `${n} gav utteljing: ${s} sidan sist. Nyt det før kroppen oppdagar det.`;
		}
		return sign > 0
			? `${n} set framleis spor: ${s} sidan sist. Vekta veit nøyaktig kva du driv med.`
			: `${n} leverer: ${s} sidan sist. Hald fram, dette er ikkje flaks.`;
	}
	return sign > 0
		? `Trass i ${n}: ${s}. Vekta har tydelegvis ikkje fått med seg kva som skjedde.`
		: `Trass i ${n}: ${s}. Anten er det musklar, eller så var premien etterpå litt for stor.`;
}

function eventSavedMessage(ev, isNew) {
	const verb = isNew ? "Registrert" : "Oppdatert";
	const w = windOf(ev);
	const tail = w < 0 ? "Vekta er åtvara." : w > 0 ? "Vi ventar spent på resultata." : "Vi held auge med det.";
	return `${verb}: ${eventName(ev)}. ${tail}`;
}

// ---------- Hendingar: graf ----------

function eventPlotBands(withLabels) {
	return state.events
		.filter((ev) => ev.kind === "periode")
		.map((ev) => {
			const w = windOf(ev);
			const band = {
				id: `hending-${ev.id}`,
				from: dateToUtc(ev.startDate),
				to: dateToUtc(eventEnd(ev)) + DAY,
				color: w < 0 ? COLORS.headwind : w > 0 ? COLORS.tailwind : COLORS.neutral,
				zIndex: 0,
			};
			if (withLabels) {
				band.label = {
					text: escapeHtml(eventName(ev)),
					align: "left",
					verticalAlign: "top",
					x: 4,
					y: 14,
					style: { fontSize: "11px", fontWeight: "700", color: "#4a4436" },
				};
			}
			return band;
		});
}

function eventSeries() {
	return {
		name: "Hendingar",
		type: "scatter",
		visible: state.showEventBands,
		color: COLORS.event,
		zIndex: 5,
		stickyTracking: false,
		marker: { enabled: true, symbol: "circle", radius: 5, fillColor: "#fff", lineWidth: 2, lineColor: COLORS.event },
		data: state.events.map((ev) => {
			const x = dateToUtc(ev.startDate);
			return { x, y: weightAtTime(x), eventId: ev.id };
		}),
		dataLabels: {
			enabled: true,
			y: -10,
			formatter() {
				const ev = state.events.find((e) => e.id === this.point.options.eventId);
				return ev ? categoryOf(ev).emoji : "";
			},
			style: { fontSize: "17px", textOutline: "none" },
		},
		tooltip: {
			headerFormat: "",
			pointFormatter() {
				const ev = state.events.find((e) => e.id === this.options.eventId);
				if (!ev) return "";
				const note = ev.note ? `<br/><span>${escapeHtml(ev.note)}</span>` : "";
				return `<b>${escapeHtml(eventName(ev))}</b><br/>${escapeHtml(eventDateText(ev))}${note}`;
			},
		},
		events: {
			// Skjul/vis dei skraverte periodane saman med markørane.
			legendItemClick() {
				state.showEventBands = !this.visible;
				for (const [chart, labels] of [
					[state.charts.weight, true],
					[state.charts.delta, false],
				]) {
					if (!chart) continue;
					for (const band of eventPlotBands(labels)) {
						chart.xAxis[0].removePlotBand(band.id);
						if (state.showEventBands) chart.xAxis[0].addPlotBand(band);
					}
				}
			},
		},
	};
}

// ---------- Hendingar: skjema og liste ----------

function bindEventForm() {
	const form = $("eventForm");
	const category = $("eventCategory");
	let effectTouched = false;

	category.replaceChildren(
		...Object.entries(EVENT_CATEGORIES).map(([key, c]) => {
			const option = document.createElement("option");
			option.value = key;
			option.textContent = `${c.emoji} ${c.label}`;
			return option;
		})
	);

	const syncKind = () => {
		const isPeriod = form.elements.kind.value === "periode";
		$("eventEndWrap").hidden = !isPeriod;
		$("eventStartLabel").textContent = isPeriod ? "Frå" : "Dato";
	};

	const reset = () => {
		form.reset();
		state.editingEventId = null;
		effectTouched = false;
		$("eventStart").value = todayIso();
		$("eventEffect").value = EVENT_CATEGORIES[category.value].effect;
		$("eventFormSummary").textContent = "+ Registrer hending";
		$("eventSubmit").textContent = "Lagre hending";
		syncKind();
	};

	form.elements.kind.forEach((radio) => radio.addEventListener("change", syncKind));
	category.addEventListener("change", () => {
		if (!effectTouched) $("eventEffect").value = EVENT_CATEGORIES[category.value].effect;
	});
	$("eventEffect").addEventListener("change", () => {
		effectTouched = true;
	});
	$("eventCancel").addEventListener("click", () => {
		reset();
		$("eventFormWrap").open = false;
		setEventFeedback("");
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const body = {
			kind: form.elements.kind.value,
			startDate: $("eventStart").value,
			endDate: $("eventEnd").value || null,
			category: category.value,
			effect: $("eventEffect").value,
			title: $("eventTitle").value,
			note: $("eventNote").value,
			private: $("eventPrivate").checked,
		};
		const id = state.editingEventId;
		const result = await sendJson(id ? "PUT" : "POST", id ? `/api/hendingar/${id}` : "/api/hendingar", body);
		if (!result.ok) {
			setEventFeedback(result.error, "error");
			return;
		}
		reset();
		$("eventFormWrap").open = false;
		await reload();
		setEventFeedback(eventSavedMessage(result.data.event, !id), "ok");
	});

	$("eventList").addEventListener("click", async (event) => {
		const button = event.target.closest("button[data-event-action]");
		if (!button) return;
		const ev = state.events.find((e) => e.id === Number(button.dataset.id));
		if (!ev) return;

		if (button.dataset.eventAction === "edit") {
			state.editingEventId = ev.id;
			effectTouched = true;
			form.elements.kind.value = ev.kind;
			category.value = ev.category in EVENT_CATEGORIES ? ev.category : "anna";
			$("eventTitle").value = ev.title;
			$("eventStart").value = ev.startDate;
			$("eventEnd").value = ev.endDate || "";
			$("eventEffect").value = ev.effect;
			$("eventNote").value = ev.note || "";
			$("eventPrivate").checked = Boolean(ev.private);
			$("eventFormSummary").textContent = `Endrar: ${eventName(ev)}`;
			$("eventSubmit").textContent = "Lagre endringar";
			syncKind();
			$("eventFormWrap").open = true;
			setEventFeedback("");
			$("eventFormWrap").scrollIntoView({ behavior: "smooth", block: "center" });
			$("eventTitle").focus();
		}

		if (button.dataset.eventAction === "delete" && confirm(`Slette hendinga «${ev.title}»?`)) {
			const result = await sendJson("DELETE", `/api/hendingar/${ev.id}`);
			if (!result.ok) {
				setEventFeedback(result.error, "error");
				return;
			}
			if (state.editingEventId === ev.id) reset();
			await reload();
			setEventFeedback(`Sletta ${eventName(ev)}. Bevisa er borte – kurva hugsar framleis.`, "ok");
		}
	});

	reset();
}

function setEventFeedback(text, kind = "") {
	const el = $("eventFeedback");
	el.textContent = text;
	el.dataset.kind = kind;
}

async function sendJson(method, url, body) {
	try {
		const res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) return { ok: true, data };
		return { ok: false, error: data.error || "Noko gjekk gale ved lagring." };
	} catch {
		return { ok: false, error: "Nettverksfeil. Prøv igjen." };
	}
}

function eventDateText(ev) {
	if (ev.kind === "dag") return formatDate(ev.startDate);
	if (!ev.endDate) return `${formatDate(ev.startDate)} – pågår`;
	const days = daysBetween(ev.startDate, ev.endDate) + 1;
	return `${formatDate(ev.startDate)} – ${formatDate(ev.endDate)} (${plural(days, "dag", "dagar")})`;
}

function renderEvents() {
	const panel = $("eventsPanel");
	panel.hidden = !state.canWrite && !state.events.length;
	if (panel.hidden) return;
	$("eventFormWrap").hidden = !state.canWrite;

	const sorted = [...state.events].sort((a, b) => (a.startDate === b.startDate ? b.id - a.id : a.startDate < b.startDate ? 1 : -1));
	$("eventsEmpty").hidden = sorted.length > 0;
	$("eventsEmpty").textContent =
		"Ingen hendingar enno. Har det vore julebord, fjelltur eller ein heimabrygg-batch? Registrer det, så får kurva ei forklaring – eller ei orsaking.";
	$("eventList").replaceChildren(...sorted.map(eventItem));
}

function eventItem(ev) {
	const a = analyzeEvent(ev);
	const w = windOf(ev);
	const li = document.createElement("li");
	li.className = `event-item ${w < 0 ? "headwind" : w > 0 ? "tailwind" : ""}`;

	const emoji = el("div", "event-emoji", categoryOf(ev).emoji);
	emoji.setAttribute("aria-hidden", "true");

	const body = el("div", "event-body");
	body.append(el("h3", "", ev.title));

	const meta = el("p", "event-meta");
	meta.append(el("span", "", eventDateText(ev)), el("span", "", categoryOf(ev).label));
	const effectLabel = { opp: "Venta: opp ⬆️", ned: "Venta: ned ⬇️", ukjend: "Venta: 🤷" }[ev.effect];
	if (effectLabel) meta.append(el("span", "", effectLabel));
	if (isOngoing(ev)) meta.append(el("span", "event-tag live", "Pågår"));
	if (isPlanned(ev)) meta.append(el("span", "event-tag", "Planlagt"));
	if (ev.private) meta.append(el("span", "event-tag", "🔒 Privat"));
	body.append(meta);

	if (ev.note) body.append(el("p", "event-note", ev.note));
	body.append(el("p", "event-stats", eventStatsText(ev, a)));
	const verdict = eventVerdict(ev, a);
	if (verdict) body.append(el("p", "event-verdict", verdict));

	li.append(emoji, body);

	if (state.canWrite) {
		const actions = el("div", "event-actions");
		for (const [action, label] of [
			["edit", "Endre"],
			["delete", "Slett"],
		]) {
			const b = el("button", `mini ${action === "delete" ? "danger" : ""}`, label);
			b.type = "button";
			b.dataset.eventAction = action;
			b.dataset.id = ev.id;
			actions.append(b);
		}
		li.append(actions);
	}
	return li;
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

// ---------- Humor ----------

function makeDailyComment(delta, date) {
	const ev = date ? eventInPlay(date) : null;
	const eventComment = ev ? eventDailyComment(ev, delta) : null;
	if (eventComment) return eventComment;

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

	// Pågåande hendingar får ein god sjanse til å stele banneret.
	const eventOptions = state.events.filter(isOngoing).map((ev) => {
		const day = daysBetween(ev.startDate, todayIso()) + 1;
		const w = windOf(ev);
		if (w < 0) return `${eventName(ev)} er inne på dag ${day}. Vekta har sjølvsagt merka det, men vi seier ingenting. Høgt.`;
		if (w > 0) return `${eventName(ev)} er inne på dag ${day}. Slik byggjer ein vanar – og legender.`;
		return `${eventName(ev)} pågår (dag ${day}). Vi held auge med kurva.`;
	});
	const pool = eventOptions.length && Math.random() < 0.5 ? eventOptions : options;
	return pool[Math.floor(Math.random() * pool.length)];
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

/** Stigningstal i kg per dag for ei liste med målingar. */
function slopeOf(entries) {
	return linearSlope(entries.map((e) => [(e.t - entries[0].t) / DAY, e.weight]));
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

function daysBetween(from, to) {
	return Math.round((dateToUtc(to) - dateToUtc(from)) / DAY);
}

function maxIso(a, b) {
	return a > b ? a : b;
}

function inRange(date, [from, to]) {
	return date >= from && date <= to;
}

function overlaps([a1, a2], [b1, b2]) {
	return a1 <= b2 && b1 <= a2;
}

function pick(list, seed) {
	return list[Math.abs(Number(seed) || 0) % list.length];
}

function plural(n, one, many) {
	return `${n} ${n === 1 ? one : many}`;
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
