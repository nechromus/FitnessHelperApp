# FitnessHelperApp

Schlanke Web-App (iPhone/iPad, Desktop) zur Anzeige der eigenen Fitnessdaten.

- **Enthält keine Daten und keine Tokens.** Die Daten liegen im privaten Repo
  `FitnessHelperAppData` und werden zur Laufzeit über die GitHub-API gelesen.
- Der Lese-Token wird nur im Browser des Geräts gespeichert (optional nur für
  die Sitzung) und ausschließlich an `api.github.com` gesendet (per
  Content-Security-Policy erzwungen).
- Kein Build-Schritt, keine Abhängigkeiten: reines HTML, CSS und JavaScript.

## Stand

Stufe 3: **Heute** (nächster Baustein, Spontan-Vorschlag, Rückmeldungen), **Plan**
(Wochenbausteine mit Ersatz, Bewertung im Zielkorridor, „Woche leichter/fordernder“),
**Weg** (Bereitschaft, Meilensteine) und **Fortschritt** (Stunden pro Woche, letzte Einheiten).
iPhone: Navigation unten. iPad/breit (ab 900 px): Seitenleiste, zwei Spalten.

Die App liest aus dem Daten-Ordner `plan.json`, `workouts.json`, `strength.json`,
`feedback.json`, `choices.json` und schreibt nur nach `inbox/app/` (Rückmeldung,
Ersatzwahl, Anpassungswunsch).

## Einrichten

1. **Lese-Token erstellen:** GitHub → Settings → Developer settings →
   *Fine-grained personal access tokens* → *Generate new token*
   - Repository access: *Only select repositories* → `FitnessHelperAppData`
   - Permissions: *Contents* → **Read and write** (die App schreibt nur nach `inbox/app/`)
   - Ablaufdatum setzen (z. B. 1 Jahr)
2. **App öffnen:** über GitHub Pages (Settings → Pages → Branch `main`, Ordner `/`)
   unter `https://nechromus.github.io/FitnessHelperApp/` – oder lokal:
   ```bash
   python3 -m http.server 8000   # dann http://localhost:8000
   ```
3. ⚙︎ antippen, Token einfügen, *Speichern & laden*.
4. Auf dem iPhone/iPad: Teilen → *Zum Home-Bildschirm*.


## Updates

Die App prüft beim Start, beim Zurückkehren aus dem Hintergrund und alle 15 Minuten
`version.json` auf dem Server. Ist dort eine neuere Version, erscheint oben
„Neue Version verfügbar – Aktualisieren“. Manuell: ⚙︎ → „Nach Update suchen“.

**Vor jedem Commit, der die App ändert:**
```bash
python3 tools/bump_version.py "Kurz, was neu ist"
```
Das setzt die Version (JJJJ.MM.TT-N) in `version.json`, `src/version.js` und an
allen `?v=…`-Verweisen, damit das iPhone die neuen Dateien lädt und nicht den Cache.

## Aufbau

```
index.html            Seite, Content-Security-Policy
src/data.js           Laden (GitHub-API), Prüfen, Zusammenfassen – ohne DOM, testbar
src/plan.js           Plan-Logik: Zuordnung, Zielkorridor, Rückmeldungen – ohne DOM, testbar
src/update.js         Update-Prüfung gegen version.json – ohne DOM, testbar
src/version.js        APP_VERSION (nur über tools/bump_version.py ändern)
version.json          aktuelle Version + Hinweistext
src/app.js            Oberfläche
src/style.css         Stil (hell/dunkel, Handy zuerst)
tests/                node-Tests und Browser-Smoke-Test
```

## Tests

```bash
node --test tests/data.test.mjs tests/plan.test.mjs
python3 tests/smoke_browser.py          # braucht Playwright + Chrome
```
