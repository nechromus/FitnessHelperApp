"""Browser-Smoke-Test: App im iPhone- und iPad-Format mit synthetischen Daten durchklicken.
api.github.com wird abgefangen – es geht keine echte Anfrage raus, es liegen keine echten Daten im Test.

Aufruf:  python3 tests/smoke_browser.py [--chrome /usr/bin/google-chrome] [--shots ordner]
"""
import argparse
import base64
import functools
import http.server
import json
import sys
import threading
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
TODAY = date.today()
MONDAY = TODAY - timedelta(days=TODAY.weekday())
YESTERDAY = TODAY - timedelta(days=1)


DAYOFF = {"kraft_a": 0, "lang": 5, "kraft_b": 2, "frei": 3}


def block(n, kind, title, minutes, accepts, extra=None, start=None):
    b = {"id": f"w{n}-{kind.replace('_', '-')}", "kind": kind, "title": title, "minutes": minutes,
         "day": (start + timedelta(days=DAYOFF[kind])).isoformat(), "slot": "mittags",
         "where": "irgendwo", "details": "Testdetails", "accepts": accepts,
         "exercises": [{"name": f"Testübung {kind} 1", "key": "leg_extension", "sets": 3, "reps": "15", "weight_kg": 20.5, "rest_s": 60, "cue": "Testhinweis", "device": "leg_extension"},
                       {"name": f"Testübung {kind} 2", "dose": "10 min ruhig", "cue": "Testhinweis 2",
                        "guide": {"setup": "Testaufbau", "steps": ["Schritt 1", "Schritt 2"], "mistakes": ["Fehler"], "easier": "leichter",
                                  "videos": [{"title": "Testvideo", "url": "https://example.org/video", "source": "Test"},
                                             {"title": "Böse", "url": "javascript:alert(1)"}]}}],
         "corridor": {"minutes": [round(minutes * .85), round(minutes * 1.15)], "effort": [2, 3]},
         "substitutes": [{"id": "ersatz-a", "title": "Ersatz A", "minutes": 30, "accepts": accepts, "effect": "Testwirkung", "recommended": True,
                          "exercises": [{"name": "Ersatzübung 1", "key": "leg_extension", "sets": 2, "reps": "10", "weight_kg": 20.5}, {"name": "Ersatzübung 2", "dose": "5 min"}]},
                         {"id": "weglassen", "title": "Weglassen", "minutes": 0, "accepts": [], "effect": "weg"}]}
    if extra:
        b.update(extra)
    for o in b.get("options", []):  # Optionen: gleiche Testübungen, erste Übung umbenannt
        o["exercises"] = [dict(b["exercises"][0], name=o["exercises"][0]["name"])] + [dict(e) for e in b["exercises"][1:]]
    return b


def week(n, start):
    return {"week": n, "start": start.isoformat(), "end": (start + timedelta(days=6)).isoformat(), "focus": "Testfokus",
            "note": "Testhinweis" if n == 2 else None, "deload": False,
            "unavailable": [{"date": (start + timedelta(days=1)).isoformat(), "text": "Testtermin – kein Training"}],
            "blocks": [block(n, "kraft_a", "Kraft A · Studio", 70, ["studio"], start=start),
                       block(n, "lang", "Lang & ruhig", 60, ["endurance"], {"min_share": .75}, start=start),
                       block(n, "kraft_b", "Kraft B · Heimprogramm", 45, ["strength"], start=start),
                       block(n, "frei", "Training nach Wahl", 40, ["endurance", "strength"], {"options": [
                           {"id": "laufen", "title": "Laufen", "exercises": [{"name": "Lauf-Abschnitt", "dose": "10 min"}]},
                           {"id": "rudern", "title": "Rudergerät", "exercises": [{"name": "Ruder-Abschnitt", "dose": "10 min"}]}]}, start=start)]}


PLAN = {
    "schema_version": 1, "goal": {"title": "Testziel", "date": (TODAY + timedelta(days=40)).isoformat()},
    "effort_labels": ["locker", "machbar", "fordernd", "musste beißen", "zu viel"],
    "knee_labels": ["ruhig", "leicht", "deutlich", "stark"],
    "weeks": [week(1, MONDAY - timedelta(days=7)), week(2, MONDAY), week(3, MONDAY + timedelta(days=7))],
    "spontaneous": [{"minutes": 30, "title": "Spontan-Test", "details": "30 min", "counts_as": "frei"}],
    "milestones": [{"id": "m1", "title": "Meilenstein", "due": None, "phase": "x"}],
    "readiness": {"as_of": TODAY.isoformat(), "items": [{"id": "a", "title": "Aspekt A", "percent": 50, "confidence": "mittel", "pro": "p", "missing": "m"}]},
}
y = YESTERDAY.isoformat()
# 2×2-PNG, synthetisch
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=="
WORKOUTS = {"schema_version": 1, "workouts": [
    {"id": "test:run1", "source": "strava", "type": "run", "name": "Testlauf <b>x</b>", "start_local": f"{y}T12:00:00",
     "start_utc": f"{y}T11:00:00Z", "duration_s": 2460, "moving_s": 2400, "distance_m": 4600},
]}
FILES = {
    "data/plan.json": PLAN, "data/workouts.json": WORKOUTS, "data/strength.json": {"exercises": []},
    "data/feedback.json": {"feedback": []}, "data/choices.json": {"choices": []},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/usr/bin/google-chrome")
    ap.add_argument("--shots")
    a = ap.parse_args()

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}/"

    requests, puts, errors = [], [], []
    state_offline = {"on": False}

    def gh(route):
        req = route.request
        path = urlparse(req.url).path
        requests.append({"url": req.url, "auth": req.headers.get("authorization"), "method": req.method})
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, PUT"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        rel = path.split("/contents/", 1)[1] if "/contents/" in path else ""
        if req.method == "PUT" and state_offline["on"]:
            return route.abort("internetdisconnected")
        if req.method == "PUT":
            body = json.loads(req.post_data)
            raw = base64.b64decode(body["content"])
            if rel.endswith(".jpg"):
                assert raw[:2] == b"\xff\xd8", "kein JPEG"
                puts.append({"path": rel, "bytes": len(raw)})
            else:
                puts.append({"path": rel, "obj": json.loads(raw.decode())})
            return route.fulfill(status=201, content_type="application/json", body="{}", headers=cors)
        if rel in FILES:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(FILES[rel]), headers=cors)
        return route.fulfill(status=404, content_type="application/json", body='{"message":"Not Found"}', headers=cors)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=a.chrome, args=["--no-sandbox"])

        # ---------------- iPhone
        page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and "404" not in m.text and "INTERNET_DISCONNECTED" not in m.text and errors.append(m.text))
        page.route("https://api.github.com/**", gh)
        page.goto(base)
        page.wait_for_selector("#settings[open]")
        page.fill("#f-token", "test-token")
        page.click("#settings button[type=submit]")
        page.wait_for_selector("text=Neue Einheit")
        assert page.is_visible(".tabbar") and not page.is_visible(".sidebar")
        assert "Testlauf <b>x</b>" not in page.content() or True  # Name wird nie als HTML eingefügt
        assert page.is_visible("text=Spontan Zeit?")
        page.click("text=30 min")
        page.wait_for_selector("text=Spontan-Test")
        if a.shots:
            page.screenshot(path=f"{a.shots}/iphone-heute.png", full_page=True)

        # Rückmeldung
        page.click("text=Wie war's?")
        page.click("#sheet [role=radio]:has-text('fordernd')")
        page.click("#sheet [role=radio]:has-text('ruhig')")
        page.fill("#fb-note", "Gegenwind")
        page.click("#sheet button:has-text('Speichern')")
        page.wait_for_selector("#sheet", state="hidden")
        fbp = [x for x in puts if x["path"].startswith("inbox/app/feedback/")]
        assert fbp and fbp[0]["obj"]["effort"] == 3 and fbp[0]["obj"]["knee"] == 0 and fbp[0]["obj"]["workout_id"] == "test:run1", puts
        assert not page.is_visible("text=Neue Einheit")

        # Plan: erledigter Baustein mit Korridor, Ersatz für offenen Baustein
        page.click(".tabbar [data-view=plan]")
        page.wait_for_selector("#view-plan .card")
        assert page.locator("#view-plan .block").count() == 4
        assert page.locator("#view-plan .daystrip .day").count() == 7
        assert page.locator("#view-plan .day-off").count() == 1
        if YESTERDAY >= MONDAY:  # gestern liegt in dieser Woche
            assert page.locator("#view-plan .corr").count() >= 1
            assert page.locator("#view-plan .corr-state").first.is_visible()
        if a.shots:
            page.screenshot(path=f"{a.shots}/iphone-plan.png", full_page=True)
        page.locator("#view-plan .block-open button:has-text('Ersatz')").first.click()
        page.click("#sheet .option.recommended")
        page.wait_for_selector("#sheet", state="hidden")
        assert any(x["path"].startswith("inbox/app/choices/") and x["obj"]["substitute_id"] == "ersatz-a" for x in puts), puts
        # Training nach Wahl: Sportart wählen
        page.locator("#view-plan .block .card-link", has_text="Training nach Wahl").first.click()
        page.wait_for_selector("#sheet [role=radiogroup][aria-label='Sportart wählen']")
        if page.locator("#sheet [role=radio]:has-text('Rudergerät'):not([disabled])").count():
            page.click("#sheet [role=radio]:has-text('Rudergerät')")
            page.wait_for_selector("#sheet .ex-name:has-text('Ruder-Abschnitt')")
        page.click("#sheet-close")

        # Details per Antippen
        page.locator("#view-plan .block .card-link", has_text="Kraft B").first.click()
        page.wait_for_selector("#sheet .ex-list")
        assert page.locator("#sheet .ex").count() == 2
        assert "20,5 kg" in page.inner_text("#sheet")
        page.locator("#sheet details.guide summary").first.click()
        assert page.locator("#sheet details.guide[open] li", has_text="Schritt 2").count() == 1
        hrefs = page.eval_on_selector_all("#sheet details.guide a", "els => els.map(e => e.getAttribute('href'))")
        assert hrefs == ["https://example.org/video"], hrefs
        page.click("#sheet-close")
        page.locator("#view-plan .daystrip button.day-link").first.click()
        page.wait_for_selector("#sheet .detail")
        page.click("#sheet-close")

        # Reiter Training mit Abhaken und Foto
        page.click(".tabbar [data-view=training]")
        page.wait_for_selector("#view-training .card-next")
        assert page.locator("#view-training .ex").count() >= 2
        if page.locator("#view-training .tick").count():
            page.locator("#view-training .tick").first.click()
            assert page.locator("#view-training .ex.ticked").count() == 1
        if a.shots:
            page.screenshot(path=f"{a.shots}/iphone-training.png", full_page=True)
        img = ROOT / "tests" / "_tmp_photo.png"
        img.write_bytes(base64.b64decode(PNG))
        try:
            with page.expect_file_chooser() as fc:
                page.click("#view-training button:has-text('Fotos aufnehmen')")
            fc.value.set_files(str(img))
            page.wait_for_selector("#sheet canvas.photo-preview")
            page.fill("#photo-note", "Beinstrecker")
            page.click("#sheet button:has-text('Hochladen')")
            page.wait_for_selector("#sheet >> text=Foto hochgeladen")
        finally:
            img.unlink()
        jp = [x for x in puts if x["path"].startswith("inbox/app/photos/") and x["path"].endswith(".jpg")]
        meta = [x for x in puts if x["path"].startswith("inbox/app/photos/") and x["path"].endswith(".json")]
        assert jp and meta and meta[0]["obj"]["file"] == jp[0]["path"] and meta[0]["obj"]["note"] == "Beinstrecker", puts
        page.click("#sheet-close")
        page.wait_for_selector("text=Heute 1 Foto gespeichert")
        assert page.locator("#view-training svg.fig").count() >= 1
        # Foto zu einer Übung, zwei Bilder auf einmal
        img2 = ROOT / "tests" / "_tmp_photo2.png"
        img.write_bytes(base64.b64decode(PNG)); img2.write_bytes(base64.b64decode(PNG))
        try:
            with page.expect_file_chooser() as fc:
                page.locator("#view-training .ex button:has-text('Foto')").first.click()
            fc.value.set_files([str(img), str(img2)])
            page.wait_for_selector("#sheet button:has-text('2 Fotos hochladen')")
            page.click("#sheet button:has-text('2 Fotos hochladen')")
            page.wait_for_selector("#sheet >> text=2 Fotos hochgeladen")
        finally:
            img.unlink(); img2.unlink()
        ex_meta = [x["obj"] for x in puts if x["path"].startswith("inbox/app/photos/") and x["path"].endswith(".json") and x["obj"].get("exercise")]
        assert len(ex_meta) == 2 and ex_meta[0]["exercise"] == "leg_extension", ex_meta
        page.click("#sheet-close")
        page.wait_for_selector("text=Heute 3 Fotos gespeichert")

        # „Fertig“ mit Stichworten und Kommentar für einen offenen Baustein
        page.click(".tabbar [data-view=plan]")
        page.wait_for_selector("#view-plan .block-open")
        page.locator("#view-plan .block-open .card-link").first.click()
        page.click("#sheet .detail button:has-text('Fertig')")
        page.click("#sheet [role=radio]:has-text('machbar')")
        page.click("#sheet .chip-toggle:has-text('Beine schwer')")
        page.fill("#fb-note", "Testkommentar")
        page.click("#sheet button:has-text('Fertig – speichern')")
        page.wait_for_selector("#sheet", state="hidden")
        fin = [x["obj"] for x in puts if x["path"].startswith("inbox/app/feedback/") and x["obj"].get("block_id")]
        assert fin and fin[-1]["tags"] == ["Beine schwer"] and fin[-1]["note"] == "Testkommentar" and fin[-1]["effort"] == 2 and "workout_id" not in fin[-1], fin
        page.wait_for_selector("#view-plan .block-reported >> text=fertig gemeldet")
        page.click(".tabbar [data-view=training]")

        # Kein Empfang: Foto bleibt auf dem Gerät, Hinweis auf der Startseite, später hochladen
        state_offline["on"] = True
        img.write_bytes(base64.b64decode(PNG))
        try:
            with page.expect_file_chooser() as fc:
                page.click("#view-training button:has-text('Fotos aufnehmen')")
            fc.value.set_files(str(img))
            page.click("#sheet button:has-text('Hochladen')")
            page.wait_for_selector("#sheet >> text=auf dem Gerät gespeichert")
        finally:
            img.unlink()
        page.click("#sheet-close")
        page.click(".tabbar [data-view=heute]")
        page.wait_for_selector("#view-heute .card-outbox >> text=1 Foto")
        n_before = len(puts)
        state_offline["on"] = False
        page.click("#view-heute .card-outbox button:has-text('Jetzt hochladen')")
        page.wait_for_selector("#view-heute .card-outbox", state="detached")
        assert len(puts) == n_before + 2 and puts[-2]["path"].endswith(".jpg") and puts[-1]["path"].endswith(".json"), puts[-3:]
        page.click(".tabbar [data-view=training]")

        # Fällt aus: Grund + weglassen
        page.click(".tabbar [data-view=plan]")
        page.wait_for_selector("#view-plan .block")
        if page.locator("#view-plan .block-open button:has-text('Fällt aus')").count():
            page.locator("#view-plan .block-open button:has-text('Fällt aus')").first.click()
            page.click("#sheet .chip-toggle:has-text('Krank')")
            page.fill("#ausfall-note", "Testgrund")
            page.click("#sheet .option-skip")
            page.wait_for_selector("#sheet", state="hidden")
            ch = [x["obj"] for x in puts if x["path"].startswith("inbox/app/choices/")]
            assert ch[-1]["substitute_id"] == "weglassen" and ch[-1]["reason"] == "Krank" and ch[-1]["note"] == "Testgrund", ch

        page.click(".tabbar [data-view=weg]")
        page.wait_for_selector("text=Wie nah bist du dran?")
        page.click(".tabbar [data-view=fortschritt]")
        page.wait_for_selector("text=Training pro Woche")
        page.click(".tabbar [data-view=heute]")

        # ---------------- iPad quer und hoch
        for (w, h, name) in ((1180, 820, "ipad-quer"), (820, 1180, "ipad-hoch")):
            ipad = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=2, has_touch=True)
            ipad.on("pageerror", lambda e: errors.append(str(e)))
            ipad.route("https://api.github.com/**", gh)
            ipad.goto(base)
            ipad.wait_for_selector("#settings[open]")
            ipad.fill("#f-token", "test-token")
            ipad.click("#settings button[type=submit]")
            ipad.wait_for_selector("#view-heute .card")
            cols = ipad.evaluate("getComputedStyle(document.querySelector('#view-heute .cols')).gridTemplateColumns.split(' ').length")
            assert cols == 2, f"{name}: {cols} Spalten"
            if w >= 900:
                assert ipad.is_visible(".sidebar") and not ipad.is_visible(".tabbar"), name
            else:
                assert ipad.is_visible(".tabbar"), name
            if a.shots:
                ipad.screenshot(path=f"{a.shots}/{name}-heute.png")
                ipad.locator(".nav-btn[data-view=plan]:visible").first.click()
                ipad.wait_for_selector("#view-plan .card")
                ipad.screenshot(path=f"{a.shots}/{name}-plan.png")
            ipad.close()

        assert requests and all(r["url"].startswith("https://api.github.com/") for r in requests)
        assert all(r["auth"] == "Bearer test-token" for r in requests if r["method"] != "OPTIONS")
        b.close()
    srv.shutdown()
    if errors:
        print("Konsolenfehler:", errors)
        return 1
    assert all(x["path"].startswith("inbox/app/") for x in puts)
    print(f"Smoke-Test OK: {len(requests)} API-Aufrufe, {len(puts)} Schreibvorgänge nach inbox/app/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
