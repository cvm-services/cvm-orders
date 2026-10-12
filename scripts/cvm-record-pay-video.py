#!/usr/bin/env python3
"""cvm-record-pay-video.py — record the pay-button proof video, deterministically.

WHY: the pay flow (venue → item → REQUIRED OPTIONS → add → basket → fill →
pay → invoice) is fragile to click by hand: items with required options open
an option screen, the basket bar only appears after add, and the error
string "order service unavailable" masks every backend failure. This script
encodes the exact working click-path and FAILS LOUDLY on any regression —
it doubles as the regression test for the pay button.

USAGE:
  python3 cvm-record-pay-video.py [--base https://cvm-pwa.orangesync.tech] \
       [--venue "Three Buddies"] [--item "Curly Fries"] [--out /tmp/pw-pay-video]

REQUIRES: playwright (chromium) — venv: ~/.hermes/hermes-agent/venv/bin/python
Exit 0 + prints VIDEO: <path> on success; non-zero on any flow break.
"""
import argparse, json, shutil, os, sys
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="https://cvm-pwa.orangesync.tech")
ap.add_argument("--venue", default="Three Buddies")
ap.add_argument("--item", default="Curly Fries")
ap.add_argument("--sauce", default="House")
ap.add_argument("--size", default="Single")
ap.add_argument("--out", default="/tmp/pw-pay-video")
ap.add_argument("--keep-video", action="store_true",
                help="keep the raw .webm (converted mp4 lands in out/ too)")
a = ap.parse_args()

shutil.rmtree(a.out, ignore_errors=True)
os.makedirs(a.out, exist_ok=True)
LOG, ERRS = [], []

def check(cond, msg):
    LOG.append((msg, bool(cond)))
    if not cond:
        print(json.dumps(LOG, indent=2, ensure_ascii=False))
        sys.exit(f"FLOW-BREAK: {msg}")
    return cond

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/usr/bin/google-chrome-stable",
        args=["--no-sandbox", "--disable-setuid-sandbox"],
    )
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 800},
        record_video_dir=a.out,
        record_video_size={"width": 1280, "height": 800},
        ignore_https_errors=True,
    )
    page = ctx.new_page()
    page.on("pageerror", lambda e: ERRS.append(str(e)[:300]))

    # 1. landing — venue list rendered
    page.goto(f"{a.base}/order/", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    check(page.locator("button.venue").count() >= 1, "venue list rendered")
    check(page.locator("button.venue", has_text=a.venue).count() == 1,
          f"venue '{a.venue}' in list")

    # 2. venue → menu
    page.locator("button.venue", has_text=a.venue).first.click()
    page.wait_for_timeout(2500)
    check(page.locator("button.item").count() >= 10, "menu items rendered")

    # 3. item → option screen (required sauce + size)
    page.locator("button.item", has_text=a.item).first.click()
    page.wait_for_timeout(2000)
    check(page.locator("button[data-sauce]").count() >= 1, "option screen: sauces")
    check(page.locator("button[data-size]").count() >= 1, "option screen: sizes")
    page.locator(f"button[data-sauce='{a.sauce}']").first.click()
    page.locator(f"button[data-size='{a.size}']").first.click()
    page.wait_for_timeout(800)

    # 4. add to basket
    add = page.locator("button[data-add]").first
    check(add.count() == 1, "add-to-basket button present")
    LOG.append(("add_button_text", add.inner_text().replace("\n", " ")))
    add.click()
    page.wait_for_timeout(2000)
    check(page.locator("button[data-basket]").count() == 1, "basket bar appeared")

    # 5. basket → fee visible
    page.locator("button[data-basket]").first.click()
    page.wait_for_timeout(2000)
    check("Facilitator fee" in page.content(), "basket shows facilitator fee")

    # 6. fill inputs
    for sel, val in [('[data-input="contact.name"]', "Felix"),
                     ('[data-input="contact.phone"]', "+491700000000"),
                     ('[data-input="order.notes"]', "e2e pay-button proof")]:
        el = page.locator(sel)
        if el.count():
            el.first.fill(val)
    page.wait_for_timeout(1200)

    # 7. PAY → invoice
    pay = page.locator("button[data-pay]").first
    check(pay.count() == 1, "pay button present")
    LOG.append(("pay_button_text", pay.inner_text().replace("\n", " ")))
    pay.click()
    page.wait_for_timeout(10000)

    err = page.locator("p.error").all_inner_texts()
    check(not [e for e in err if "unavailable" in e or "try again" in e],
          f"no service errors after pay: {err}")
    txt = page.content()
    markers = [k for k in ("lnbc", "bolt11", "lightning:", "Invoice", "Waiting",
               "Copied", "QR") if k.lower() in txt.lower()]
    check(len(markers) >= 3, f"invoice rendered (markers: {markers})")
    LOG.append(("invoice_markers", markers))
    LOG.append(("pageerrors", ERRS))

    page.screenshot(path=f"{a.out}/final.png", full_page=True)
    ctx.close()  # closes video file
    browser.close()

# convert webm → mp4 (Signal-friendly) if ffmpeg present
webm = next(f for f in os.listdir(a.out) if f.endswith(".webm"))
if shutil.which("ffmpeg"):
    mp4 = f"{a.out}/pay-button-proof.mp4"
    os.system(f'ffmpeg -y -v error -i "{a.out}/{webm}" -c:v libx264 -preset fast '
              f'-crf 26 -vf "scale=1280:800" -movflags +faststart "{mp4}"')
    if not a.keep_video:
        os.remove(f"{a.out}/{webm}")
    print("VIDEO:", mp4)
else:
    print("VIDEO:", f"{a.out}/{webm} (no ffmpeg; raw webm kept)")

print(json.dumps(LOG, indent=2, ensure_ascii=False))