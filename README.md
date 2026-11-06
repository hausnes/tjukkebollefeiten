# Tjukkebollefeiten – Slanke-OS

Ein enkel vektlogg der kvar brukar fører si eiga reise (ned *eller* opp i vekt), med statistikk, grafar og humoristiske tilbakemeldingar. Brukarar kan dele reisa si med andre via ei lenke og eit eige delingspassord.

**Teknologi:** Node.js (≥ 22.13), Express, SQLite (innebygd `node:sqlite`), Highcharts, vanilla HTML/CSS/JS.

## Utvikling

```bash
npm install
npm run invitasjon            # lagar ein invitasjonskode
npm run dev                   # http://localhost:3000
npm test                      # integrasjonstestar mot API-et
```

Gå til `/registrer`, bruk invitasjonskoden og lag ein brukar. Databasen hamnar i `data/tjukkebolle.db`. Innstillingar kan setjast i `.env` (sjå `.env.example`), men ingen er påkravde.

## Hosting med Docker på Synology NAS

Ved kvar push til `main` køyrer GitHub Actions testane og publiserer imaget til
`ghcr.io/hausnes/tjukkebollefeiten:latest` (for både Intel/AMD og ARM). Feilar testane, blir ingenting publisert.
Etter første bygg: sjekk at pakken er offentleg (GitHub → profil → Packages → tjukkebollefeiten →
Package settings → Change visibility), elles må NAS-en logge inn på ghcr.io.

### Første gong

1. **Lag datamappa:** i File Station, lag mappa `docker/tjukkebollefeiten` (dvs. `/volume1/docker/tjukkebollefeiten`).
2. **Opprett prosjektet:** Container Manager → Prosjekt → Opprett. Vel same mappe som sti, og lim inn `compose.yaml`.
3. **Sjekk at det køyrer:** tenesta svarar på `http://<nas-ip>:3000`.
4. **HTTPS:** sjå [HTTPS](#https) under.
5. **Invitasjonskode:** Container Manager → Container → `tjukkebollefeiten` → Handling → Opne terminal → Opprett → køyr:
   ```sh
   invitasjon        # éin kode   (eller: invitasjon 3 / invitasjon liste)
   ```
6. **Flytt over data frå den gamle versjonen:** sjå [under](#flytte-data-frå-den-gamle-versjonen).

### Flytte data frå den gamle versjonen

1. Logg inn i den gamle appen i nettlesaren, opne `https://<gammal-adresse>/api/data` og lagre sida som `data.csv`.
2. Registrer brukaren på den nye appen, og legg `data.csv` i `docker/tjukkebollefeiten` med File Station.
3. I terminalen til containeren:
   ```sh
   importer <brukarnamn> /data/data.csv --prøv   # vis kva som vil skje, utan å lagre
   importer <brukarnamn> /data/data.csv          # lagre
   ```
4. Slett `data.csv` frå mappa.

Importen er trygg å køyre fleire gonger: nye datoar blir lagde inn, like målingar blir hoppa over, og datoar
der vekta er ulik blir berre lista opp (legg til `--overskriv` om fila skal vinne). Køyr han difor gjerne
ein siste gong rett før den gamle serveren blir slått av, så kjem dei siste dagane òg med.

### Oppdatere

Push til `main` og vent til GitHub Actions er ferdig (grøn hake). På NAS-en: Container Manager → Prosjekt →
`tjukkebollefeiten` → **Stopp**, deretter **Bygg**. `pull_policy: always` gjer at nyaste image alltid blir henta.
Databasen ligg utanfor containeren og blir ikkje rørt. Endringar i databasestrukturen blir køyrde automatisk ved oppstart.

Treng du å gå tilbake til ein tidlegare versjon, byt `latest` i `compose.yaml` med commit-hashen
(t.d. `ghcr.io/hausnes/tjukkebollefeiten:5d8d955…`; full hash står under Actions/Packages på GitHub).

### HTTPS

Innlogging bør alltid gå over HTTPS. På Synology:

- Kontrollpanel → Påloggingsportal → Avansert → **Omvendt proxy**: frå `https://vekt.dittdomene.no:443` til `http://localhost:3000`.
- Kontrollpanel → Sikkerheit → **Sertifikat**: Let's Encrypt for domenet.
- Opne berre port 443 i ruteren, **ikkje** port 3000. Appen stoler på `X-Forwarded-For` frå proxyen (`TRUST_PROXY: 1`)
  for å finne IP-adressa til brukaren, og den blir brukt til å avgrense passordforsøk. Direkte tilgang til port 3000
  ville gjort det mogleg å omgå avgrensinga.

### Backup

Alt som må takast vare på, ligg i `/volume1/docker/tjukkebollefeiten`: databasen (`tjukkebolle.db` med `-wal`/`-shm`)
og `session-secret`. Ta med mappa i Hyper Backup. Den aller tryggaste kopien får du ved å stoppe prosjektet før kopiering.
Kvar brukar kan òg laste ned sine eigne målingar som CSV under Innstillingar.

### Filer

| Fil | Kva |
| --- | --- |
| `Dockerfile` | Bygg av imaget (Node 24 Alpine, køyrer som brukaren `node`) |
| `docker/docker-entrypoint.sh` | Rettar eigarskap på `/data` før appen startar, så NAS-mapper med andre eigarar fungerer |
| `docker/invitasjon`, `docker/importer` | Snarvegar i containeren som alltid køyrer som `node` |
| `compose.yaml` | Prosjektfila for Container Manager |
| `.github/workflows/docker.yml` | Testar, byggjer og publiserer imaget |

Bygge og køyre lokalt:

```sh
docker build -t tjukkebollefeiten .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" -e TRUST_PROXY=0 tjukkebollefeiten
```

## Administrasjon utan Docker

| Kommando | Kva den gjer |
| --- | --- |
| `npm run invitasjon` | Lagar éin ny invitasjonskode (kvar kode kan brukast éin gong) |
| `npm run invitasjon -- 5` | Lagar fem kodar |
| `npm run invitasjon -- liste` | Viser ubrukte kodar |
| `npm run importer -- <brukarnamn> [fil] [--prøv] [--overskriv]` | Importerer målingar frå CSV inn på ein brukar |

## Deling

Under **Innstillingar → Deling** set brukaren eit delingspassord og skrur på deling. Lenkja (`/d/<kode>`) og passordet gir lesetilgang. Byter ein passord, skrur av deling eller lagar ny lenke, misser alle eksisterande gjestar tilgangen.

## Lisens for Highcharts

Highcharts er gratis for personleg og ikkje-kommersiell bruk. Skal appen brukast kommersielt, krevst lisens frå Highsoft.
