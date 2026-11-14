# Regeln für Claude in FitnessHelperApp

- Repo ist **öffentlich**: niemals Daten, Beispielwerte aus echten Exporten, Tokens oder E-Mail-Adressen committen.
- Die App liest nur `data/` aus `nechromus/FitnessHelperAppData` über api.github.com und schreibt nie.
- Netzwerk nur zu api.github.com (CSP in index.html nicht lockern).
- Kein Build-Schritt, keine externen Abhängigkeiten oder CDNs.
- Laden/Rechnen in `src/data.js` (ohne DOM), Oberfläche in `src/app.js`; Texte mit textContent, nie innerHTML mit Daten.
- Vorgaben für Aufbau und Stil: Projektdatei `claude/app-vorgaben.md`.
- Vor jedem Commit: `node --test tests/data.test.mjs` und `python3 tests/smoke_browser.py`.
- Commit-Autor: `nechromus <7289214+nechromus@users.noreply.github.com>`.
- Antworten auf Deutsch.
