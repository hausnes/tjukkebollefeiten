const state = {
	data: [],
	weightChart: null,
	deltaChart: null,
};

const el = {
	startWeight: document.getElementById("startWeight"),
	latestWeight: document.getElementById("latestWeight"),
	totalChange: document.getElementById("totalChange"),
	weeklyAverage: document.getElementById("weeklyAverage"),
	bestPeriodText: document.getElementById("bestPeriodText"),
	worstPeriodText: document.getElementById("worstPeriodText"),
	dailyComment: document.getElementById("dailyComment"),
	motivationBanner: document.getElementById("motivationBanner"),
	form: document.getElementById("entryForm"),
	dateInput: document.getElementById("dateInput"),
	weightInput: document.getElementById("weightInput"),
	formFeedback: document.getElementById("formFeedback"),
};

init();

async function init() {
	setDefaultDate();

	try {
		state.data = await fetchAndParseCsv("/api/data");
		renderAll();
		bindEvents();
	} catch (error) {
		el.formFeedback.textContent = "Klarte ikke laste data fra serveren.";
		console.error(error);
	}
}

function bindEvents() {
	el.form.addEventListener("submit", (event) => {
		event.preventDefault();
		addEntry();
	});
}

async function fetchAndParseCsv(path) {
	const response = await fetch(path);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ved henting av CSV`);
	}

	const text = await response.text();
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	return lines.slice(1).map(parseCsvLine).filter(Boolean);
}

function parseCsvLine(line) {
	const parts = line.split(/\s+/);
	if (parts.length < 3) {
		return null;
	}

	const date = parts[0];
	const weight = Number(parts[parts.length - 1]);
	if (Number.isNaN(weight)) {
		return null;
	}

	return { date, weight };
}

async function addEntry() {
	const date = el.dateInput.value;
	const weight = Number(el.weightInput.value);

	if (!date || Number.isNaN(weight)) {
		el.formFeedback.textContent = "Fyll inn gyldig dato og vekt.";
		return;
	}

	try {
		const res = await fetch("/api/entry", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ date, weight }),
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			el.formFeedback.textContent = err.error || "Feil ved lagring.";
			return;
		}

		state.data = await fetchAndParseCsv("/api/data");
		renderAll();
		el.formFeedback.textContent = `Lagret ${roundOne(weight).toFixed(1)} kg for ${formatDate(date)}.`;
		el.weightInput.value = "";
	} catch {
		el.formFeedback.textContent = "Nettverksfeil. Prøv igjen.";
	}
}

function renderAll() {
	if (!state.data.length) {
		return;
	}

	renderStatCards(state.data);
	renderInsights(state.data);
	renderWeightChart(state.data);
	renderDeltaChart(state.data);
}

function renderStatCards(data) {
	const first = data[0];
	const last = data[data.length - 1];
	const totalDelta = roundOne(last.weight - first.weight);

	const daySpan = Math.max(1, daysBetween(first.date, last.date));
	const weekSpan = daySpan / 7;
	const weeklyAvg = roundOne(totalDelta / weekSpan);

	el.startWeight.textContent = `${first.weight.toFixed(1)} kg`;
	el.latestWeight.textContent = `${last.weight.toFixed(1)} kg`;
	el.totalChange.textContent = `${formatSigned(totalDelta)} kg`;
	el.weeklyAverage.textContent = `${formatSigned(weeklyAvg)} kg/uke`;
}

function renderInsights(data) {
	const period = findBestAndWorstPeriod(data, 7);
	if (period.best) {
		el.bestPeriodText.textContent = `${formatDate(period.best.from)} til ${formatDate(period.best.to)}: ${Math.abs(period.best.delta).toFixed(1)} kg ned. Kongerunde.`;
	} else {
		el.bestPeriodText.textContent = "For lite data til å beregne periode.";
	}

	if (period.worst) {
		el.worstPeriodText.textContent = `${formatDate(period.worst.from)} til ${formatDate(period.worst.to)}: ${period.worst.delta.toFixed(1)} kg opp. Her var det kanskje helgekos deluxe.`;
	} else {
		el.worstPeriodText.textContent = "For lite data til å beregne periode.";
	}

	const latestDelta =
		data.length > 1 ? roundOne(data[data.length - 1].weight - data[data.length - 2].weight) : 0;
	el.dailyComment.textContent = makeDailyComment(latestDelta);
	el.motivationBanner.textContent = makeMotivationBanner(data);
}

function findBestAndWorstPeriod(data, gap = 7) {
	if (data.length <= gap) {
		return { best: null, worst: null };
	}

	let best = null;
	let worst = null;

	for (let i = gap; i < data.length; i += 1) {
		const delta = roundOne(data[i].weight - data[i - gap].weight);
		const windowData = {
			from: data[i - gap].date,
			to: data[i].date,
			delta,
		};

		if (!best || delta < best.delta) {
			best = windowData;
		}

		if (!worst || delta > worst.delta) {
			worst = windowData;
		}
	}

	return { best, worst };
}

function renderWeightChart(data) {
	const labels = data.map((entry) => formatDateShort(entry.date));
	const weights = data.map((entry) => entry.weight);
	const movingAvg = getMovingAverage(weights, 7);

	if (state.weightChart) {
		state.weightChart.destroy();
	}

	state.weightChart = new Chart(document.getElementById("weightChart"), {
		type: "line",
		data: {
			labels,
			datasets: [
				{
					label: "Vekt",
					data: weights,
					borderColor: "#0a9396",
					backgroundColor: "rgba(10,147,150,0.12)",
					borderWidth: 2.4,
					pointRadius: 0,
					tension: 0.25,
					fill: true,
				},
				{
					label: "7-dagers snitt",
					data: movingAvg,
					borderColor: "#ca6702",
					borderWidth: 2,
					pointRadius: 0,
					borderDash: [6, 5],
					tension: 0.22,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					labels: {
						usePointStyle: true,
						boxWidth: 9,
					},
				},
			},
			scales: {
				y: {
					title: { display: true, text: "kg" },
					grid: { color: "rgba(34,32,24,0.09)" },
				},
				x: {
					grid: { display: false },
					ticks: {
						maxTicksLimit: 10,
					},
				},
			},
		},
	});
}

function renderDeltaChart(data) {
	const labels = [];
	const deltas = [];
	const colors = [];

	for (let i = 1; i < data.length; i += 1) {
		const delta = roundOne(data[i].weight - data[i - 1].weight);
		labels.push(formatDateShort(data[i].date));
		deltas.push(delta);
		colors.push(delta <= 0 ? "rgba(42,157,143,0.8)" : "rgba(187,62,3,0.78)");
	}

	if (state.deltaChart) {
		state.deltaChart.destroy();
	}

	state.deltaChart = new Chart(document.getElementById("deltaChart"), {
		type: "bar",
		data: {
			labels,
			datasets: [
				{
					label: "Endring siden sist (kg)",
					data: deltas,
					backgroundColor: colors,
					borderRadius: 6,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				y: {
					grid: { color: "rgba(34,32,24,0.09)" },
				},
				x: {
					ticks: {
						maxTicksLimit: 12,
					},
					grid: { display: false },
				},
			},
		},
	});
}

function setDefaultDate() {
	const now = new Date();
	const isoDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	el.dateInput.value = isoDate;
}

function makeDailyComment(delta) {
	if (delta <= -0.5) {
		return "Sterk dag! Vekta gikk ned, og kaffen smaker ekstra seier.";
	}

	if (delta < 0) {
		return "Liten nedgang er fortsatt nedgang. Stabil og smart progresjon.";
	}

	if (delta === 0) {
		return "Dønn stabil. Kroppen forhandler, men du styrer fortsatt møtet.";
	}

	if (delta <= 0.5) {
		return "Litt opp i dag. Helt normalt. Kursen over tid ser fortsatt bra ut.";
	}

	return "En hump i veien. Nye tak i morgen, og sagaen fortsetter.";
}

function makeMotivationBanner(data) {
	const first = data[0].weight;
	const last = data[data.length - 1].weight;
	const total = roundOne(last - first);
	const options = [
		`Total endring: ${formatSigned(total)} kg. Svigerfar er i praksis sin egen PT med bedre humør.`,
		`Status: ${Math.abs(total).toFixed(1)} kg i riktig retning siden start. Det er mer enn en stor julemiddag!`,
		`Tall lyver ikke: ${formatSigned(total)} kg siden start. Ren hverdagsheltenergi.`,
	];

	return options[Math.floor(Math.random() * options.length)];
}

function getMovingAverage(values, windowSize) {
	return values.map((_, index) => {
		const start = Math.max(0, index - windowSize + 1);
		const slice = values.slice(start, index + 1);
		const avg = slice.reduce((sum, value) => sum + value, 0) / slice.length;
		return roundOne(avg);
	});
}

function daysBetween(a, b) {
	const start = new Date(a);
	const end = new Date(b);
	const ms = end.getTime() - start.getTime();
	return Math.round(ms / (1000 * 60 * 60 * 24));
}

function roundOne(value) {
	return Math.round(value * 10) / 10;
}

function formatSigned(value) {
	return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatDate(dateString) {
	return new Date(dateString).toLocaleDateString("nb-NO", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	});
}

function formatDateShort(dateString) {
	return new Date(dateString).toLocaleDateString("nb-NO", {
		day: "2-digit",
		month: "2-digit",
	});
}
