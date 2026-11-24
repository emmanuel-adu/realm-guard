"""End-to-end checks for Realm Guard's one journey, adapted from build-kit tools/e2e_template.py.

  python3 e2e/test_slice.py --base http://localhost:4173/ --dark
  python3 e2e/test_slice.py --base dist/index.html --file --dark

Fails on any failed check, page error, console error, failed request, or any request that
leaves the page (the scan is meant to run fully offline). Screenshots go to e2e/screenshots/.
"""
import argparse
import json
import os
import re
import sys

from playwright.sync_api import Page, expect, sync_playwright

CHROME = "/usr/bin/google-chrome"
VIEWPORTS = {"desktop": (1440, 900), "laptop": (1024, 768), "phone": (390, 844)}
SHOTS = "e2e/screenshots"
SAMPLES = "src/samples"


def settle(page: Page):
    """Wait for CSS transitions to finish, so a shot never catches a chevron mid-turn."""
    # evaluate, not wait_for_function: the page's CSP forbids the eval the latter injects.
    page.evaluate("() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))")


def full_shot(page: Page, path: str):
    # Resize to the page height instead of full_page, which can drop layers in Chrome.
    settle(page)
    w, h = page.viewport_size["width"], page.viewport_size["height"]
    height = page.evaluate("document.documentElement.scrollHeight")
    page.set_viewport_size({"width": w, "height": max(h, height)})
    page.screenshot(path=path)
    page.set_viewport_size({"width": w, "height": h})


def no_overflow(page: Page) -> tuple[bool, str]:
    sw, iw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    return sw <= iw, f"scrollWidth {sw} vs {iw}"


def count_is(locator, n: int) -> bool:
    try:
        expect(locator).to_have_count(n)
        return True
    except AssertionError:
        return False


def verdict(page: Page) -> str:
    return page.get_by_test_id("verdict").inner_text()


def journey(page: Page, shot, full, label: str) -> list[tuple[str, bool, str]]:
    r = []
    add = lambda name, ok, note="": r.append((name, bool(ok), note))

    # Empty state.
    add("one h1", page.locator("h1").count() == 1)
    add("empty state explains the four checks", page.get_by_role("heading", name="What Realm Guard checks").is_visible())
    label_h = page.get_by_text("No workflow handy?").bounding_box()["height"]
    add("sample prompt stays on one line", label_h < 30, f"{label_h:.0f}px tall")
    shot("empty")

    # Upload a workflow file with no manifest.
    page.locator("input[type=file]").nth(0).set_input_files(f"{SAMPLES}/copied-invoices.json")
    expect(page.get_by_test_id("verdict")).to_be_visible()
    # Without a manifest each credential stands in for a client, so the Pine-to-Harbor flow still shows.
    add("workflow alone still catches the cross-company flow", verdict(page) == "Fix before running" and page.get_by_role("button", name=re.compile("One client's data flows into another")).count() == 1, verdict(page))
    add("file name shown", page.get_by_test_id("workflow-label").inner_text() == "copied-invoices.json")
    add("no-manifest gap listed", page.get_by_text("No client manifest", exact=False).is_visible())

    # Draft a manifest from the workflow.
    page.get_by_role("button", name="Draft from this workflow").click()
    draft = page.locator("#manifest-text").input_value()
    add("draft manifest lists both credentials", "QBO - Pine Street Bakery" in draft and "QBO - Harbor Dental" in draft)
    add("draft flags the cross-client flow", count_is(page.get_by_role("button", name=re.compile("One client's data flows into another")), 1))

    # Replace the draft with the real manifest file.
    page.locator("input[type=file]").nth(1).set_input_files(f"{SAMPLES}/copied-invoices.manifest.yaml")
    expect(page.get_by_test_id("verdict")).to_have_text("Fix before running")
    findings = page.locator("[aria-labelledby=findings-heading] li > button")
    add("manifest scan finds four issues", count_is(findings, 4), str(findings.count()))
    add("first finding open with its fix", page.get_by_text("Switch this node to the credential for Harbor Dental", exact=False).is_visible())
    full("report")

    # Filter by severity.
    filters = page.get_by_role("group", name="Filter findings by severity")
    filters.get_by_role("button", name=re.compile(r"^Critical")).click()
    add("critical filter shows two", count_is(findings, 2), str(findings.count()))
    filters.get_by_role("button", name=re.compile(r"^All")).click()
    add("all filter restores four", count_is(findings, 4))

    # Expand another finding.
    second = findings.nth(1)
    second.click()
    add("finding expands", second.get_attribute("aria-expanded") == "true")

    # Copy the report.
    page.get_by_role("button", name="Copy report").click()
    expect(page.get_by_role("button", name="Copied", exact=True)).to_be_visible()
    copied = page.evaluate("navigator.clipboard.readText()")
    add("copied Markdown report", copied.startswith("# Realm Guard report: Monthly invoices - Harbor Dental"), copied[:60])
    add("no em dash in copied report", "\u2014" not in copied)

    ok, note = no_overflow(page)
    add("no horizontal overflow on report", ok, note)

    # Manifest syntax error points at the line.
    page.locator("#manifest-text").fill("tenants:\n  - id: a\n    credentials: [oops\n")
    expect(page.get_by_role("heading", name="The manifest has a problem")).to_be_visible()
    add("manifest error names the line", page.get_by_text(re.compile(r"syntax error on line \d")).first.is_visible())
    shot("manifest-error")

    # Bad workflow paste.
    page.get_by_role("button", name="Clear workflow export").click()
    page.get_by_role("button", name="Clear client manifest").click()
    add("clearing returns to the empty state", page.get_by_role("heading", name="What Realm Guard checks").is_visible())
    page.get_by_role("button", name="Paste instead").first.click()
    page.locator("#workflow-text").fill("{ nodes: [")
    expect(page.get_by_role("heading", name="The workflow file didn't read cleanly")).to_be_visible()
    add("invalid JSON explained", page.get_by_role("alert").first.inner_text().find("isn't valid JSON") >= 0)
    shot("workflow-error")
    page.get_by_role("button", name="Clear workflow export").click()
    add("clearing a paste brings back the drop zone", page.locator("#workflow-drop").count() == 1 and page.locator("#workflow-text").count() == 0)

    # Samples.
    page.locator("aside[aria-label=Inputs]").get_by_role("button", name=re.compile("^Shared AP agent")).click()
    expect(page.get_by_test_id("verdict")).to_have_text("Fix before running")
    add("agent sample shows nine findings", count_is(findings, 9), str(findings.count()))
    add("a loaded sample shows a file chip, not raw JSON", page.locator("#workflow-text").count() == 0)
    # Findings never quote workflow expressions (they can hold tokens), so check code spans on a
    # fix suggestion instead, opened so the overflow check below also covers it on phones.
    page.locator("[aria-labelledby=findings-heading] li").filter(has_text="AI memory shared across runs").get_by_role("button").first.click()
    add("expressions render as inline code", page.locator("[aria-labelledby=findings-heading] li code", has_text="$json.clientId").count() == 1)
    add("steps table lists four QuickBooks steps", page.get_by_role("heading", name=re.compile("QuickBooks steps")).is_visible())
    ok, note = no_overflow(page)
    add("no horizontal overflow on agent report", ok, note)
    full("agent")

    page.locator("aside[aria-label=Inputs]").get_by_role("button", name=re.compile("^Reviewed bill entry")).click()
    expect(page.get_by_test_id("verdict")).to_have_text("No boundary issues found")
    add("clean sample passes", page.get_by_text("No findings.", exact=False).is_visible())
    full("clear")

    # Theme toggle persists across reload.
    before = page.evaluate("document.documentElement.dataset.theme")
    page.get_by_role("button", name=re.compile("Switch to (dark|light) theme")).click()
    after = page.evaluate("document.documentElement.dataset.theme")
    add("theme toggles", before != after, f"{before} -> {after}")
    page.reload()
    add("theme persists", page.evaluate("document.documentElement.dataset.theme") == after)
    page.get_by_role("button", name=re.compile("Switch to (dark|light) theme")).click()
    return r


def keyboard_check(page: Page) -> list[tuple[str, bool, str]]:
    """Load a sample and open the file picker with the keyboard alone."""
    page.reload()
    for _ in range(40):
        page.keyboard.press("Tab")
        text = page.evaluate("document.activeElement && document.activeElement.innerText") or ""
        if text.startswith("Try the copied invoice run"):
            break
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("verdict")).to_have_text("Fix before running")
    reached = page.evaluate("document.activeElement.id") == "report-start"
    page.get_by_role("button", name="Clear workflow export").click()
    page.get_by_role("button", name="Clear client manifest").click()
    # Assert what the app owns: Enter reaches the hidden file input as a click. Whether headless
    # Chrome then shows its dialog varied run to run (2 of 12 dialogs never appeared in one loop), so
    # waiting on the dialog made this test flaky.
    page.evaluate("window.__fileClicks = 0; document.addEventListener('click', e => { if (e.target.type === 'file') window.__fileClicks++ }, true)")
    page.locator("#workflow-drop").focus()
    focused = page.evaluate("document.activeElement.id")
    page.keyboard.press("Enter")
    opened = page.evaluate("window.__fileClicks") == 1
    return [
        ("keyboard: Tab + Enter loads a sample and moves focus to the report", reached, ""),
        ("keyboard: Enter on the drop zone opens the file input", opened, f"focused #{focused}"),
    ]


def run(base: str, as_file: bool, dark: bool) -> dict:
    os.makedirs(SHOTS, exist_ok=True)
    summary = {"checks": [], "errors": [], "outside_requests": []}
    url = f"file://{os.path.abspath(base)}" if as_file else base
    origin = "file://" if as_file else re.match(r"https?://[^/]+", base).group(0)
    with sync_playwright() as p:
        # Use the workspace Chrome when present; CI uses the browser Playwright installs.
        browser = p.chromium.launch(executable_path=CHROME if os.path.exists(CHROME) else None)
        for name, (w, h) in VIEWPORTS.items():
            for scheme in ["light", "dark"] if dark else ["light"]:
                ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, permissions=["clipboard-read", "clipboard-write"])
                page = ctx.new_page()
                label = f"{'file' if as_file else 'served'}-{name}-{scheme}"
                errors = []

                def guard(route, _l=label):
                    u = route.request.url
                    if u.startswith(origin) or u.startswith("data:") or u.startswith("blob:"):
                        route.continue_()
                    else:
                        summary["outside_requests"].append(f"{_l}: {u}")
                        route.abort()

                page.route("**/*", guard)
                page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
                page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)
                page.on("requestfailed", lambda r: errors.append(f"failed: {r.url}"))
                page.goto(url, wait_until="networkidle")

                def shot(step, _l=label, _p=page):
                    settle(_p)
                    _p.screenshot(path=f"{SHOTS}/{_l}-{step}.png")

                def full(step, _l=label, _p=page):
                    full_shot(_p, f"{SHOTS}/{_l}-{step}.png")

                checks = journey(page, shot, full, label) + keyboard_check(page)
                for c, ok, note in checks:
                    summary["checks"].append({"viewport": label, "check": c, "passed": ok, "note": note})
                summary["errors"] += [f"{label}: {e}" for e in dict.fromkeys(errors)]
                ctx.close()
        browser.close()
    summary["passed"] = all(c["passed"] for c in summary["checks"]) and not summary["errors"] and not summary["outside_requests"]
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--file", action="store_true")
    ap.add_argument("--dark", action="store_true")
    a = ap.parse_args()
    result = run(a.base, a.file, a.dark)
    with open(f"e2e/results-{'file' if a.file else 'served'}.json", "w") as f:
        json.dump(result, f, indent=2)
    for c in result["checks"]:
        print(("PASS " if c["passed"] else "FAIL ") + f'{c["viewport"]:>22}  {c["check"]}  {c["note"]}')
    for e in result["errors"]:
        print("ERROR", e)
    for e in result["outside_requests"]:
        print("OUTSIDE REQUEST", e)
    print("PASSED" if result["passed"] else "FAILED")
    sys.exit(0 if result["passed"] else 1)
