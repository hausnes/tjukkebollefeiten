const forms = {
	profile: document.getElementById("profileForm"),
	share: document.getElementById("shareForm"),
	password: document.getElementById("passwordForm"),
	del: document.getElementById("deleteForm"),
};

let profile = null;

load();

async function load() {
	const res = await fetch("/api/profil", { headers: { Accept: "application/json" } });
	if (res.status === 401) return location.assign("/logg-inn");
	profile = await res.json();
	fill();
}

function fill() {
	document.getElementById("usernameLabel").textContent = profile.username;

	const p = forms.profile.elements;
	p.displayName.value = profile.displayName;
	p.direction.value = profile.direction;
	p.goalWeight.value = profile.goalWeight ?? "";
	p.heightCm.value = profile.heightCm ?? "";

	const s = forms.share.elements;
	s.enabled.checked = profile.share.enabled;
	s.password.value = "";
	document.getElementById("shareUrl").value = location.origin + profile.share.path;
	document.getElementById("sharePasswordHint").textContent = profile.share.hasPassword
		? "Eit passord er sett. Av tryggleiksomsyn kan det ikkje visast, men du kan byte det."
		: "Ingen delingspassord er sett enno.";
}

async function send(method, url, body, form) {
	const feedback = form.querySelector("[data-feedback]");
	feedback.textContent = "";
	feedback.dataset.kind = "";
	try {
		const res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			feedback.textContent = data.error || "Noko gjekk gale.";
			feedback.dataset.kind = "error";
			return null;
		}
		return data;
	} catch {
		feedback.textContent = "Nettverksfeil. Prøv igjen.";
		feedback.dataset.kind = "error";
		return null;
	}
}

function ok(form, text) {
	const feedback = form.querySelector("[data-feedback]");
	feedback.textContent = text;
	feedback.dataset.kind = "ok";
}

forms.profile.addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = forms.profile.elements;
	const body = {
		displayName: f.displayName.value,
		direction: f.direction.value,
		goalWeight: f.goalWeight.value,
		heightCm: f.heightCm.value,
	};
	if (await send("PUT", "/api/profil", body, forms.profile)) ok(forms.profile, "Profilen er lagra.");
});

forms.share.addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = forms.share.elements;
	const body = { enabled: f.enabled.checked, password: f.password.value };
	if (await send("PUT", "/api/deling", body, forms.share)) {
		await load();
		ok(forms.share, f.enabled.checked ? "Delinga er lagra og aktiv." : "Delinga er skrudd av.");
	}
});

document.getElementById("copyLink").addEventListener("click", async () => {
	const input = document.getElementById("shareUrl");
	try {
		await navigator.clipboard.writeText(input.value);
	} catch {
		input.select();
		document.execCommand("copy");
	}
	ok(forms.share, "Lenkja er kopiert. Hugs å sende passordet òg!");
});

document.getElementById("newLink").addEventListener("click", async () => {
	if (!confirm("Lage ny lenke? Den gamle sluttar å verke med ein gong.")) return;
	if (await send("POST", "/api/deling/ny-lenke", null, forms.share)) {
		await load();
		ok(forms.share, "Ny lenke er laga.");
	}
});

forms.password.addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = forms.password.elements;
	if (await send("PUT", "/api/passord", { current: f.current.value, next: f.next.value }, forms.password)) {
		forms.password.reset();
		ok(forms.password, "Passordet er bytt.");
	}
});

forms.del.addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!confirm("Heilt sikker? Alle målingane dine vert sletta for godt.")) return;
	const data = await send("DELETE", "/api/konto", { password: forms.del.elements.password.value }, forms.del);
	if (data) location.assign(data.redirect || "/logg-inn");
});
