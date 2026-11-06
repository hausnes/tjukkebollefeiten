// Felles skript for innlogging, registrering og delingspassord.
// Skjemaet treng attributtet data-api="<adresse>"; «{slug}» vert bytt ut med delingslenka frå adressa.
(function () {
	const form = document.querySelector("form[data-api]");
	const errorBox = document.getElementById("errorMsg");
	const errorText = document.getElementById("errorText");
	if (!form) return;

	const slugMatch = location.pathname.match(/^\/d\/([^/]+)/);
	const endpoint = form.dataset.api.replace("{slug}", slugMatch ? encodeURIComponent(slugMatch[1]) : "");

	function showError(message) {
		errorText.textContent = message;
		errorBox.hidden = false;
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		errorBox.hidden = true;

		const button = form.querySelector('button[type="submit"]');
		const label = button.textContent;
		button.disabled = true;
		button.textContent = "Augneblink …";

		try {
			const body = Object.fromEntries(new FormData(form).entries());
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));

			if (res.ok && data.redirect) {
				location.assign(data.redirect);
				return;
			}
			showError(data.error || "Noko gjekk gale. Prøv igjen.");
		} catch {
			showError("Fekk ikkje kontakt med serveren. Sjekk nettet og prøv igjen.");
		}

		button.disabled = false;
		button.textContent = label;
	});
})();
