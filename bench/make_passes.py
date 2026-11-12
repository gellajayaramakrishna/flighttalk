#!/usr/bin/env python3
"""
Generate a synthetic boarding-pass test set for FlightTalk.

Each pass has the printed fields AND an IATA BCBP barcode (PDF417, Aztec-like QR, or QR),
then gets a realistic "phone photo" distortion. Ground truth goes to labels.json.

    pip install pillow pdf417gen qrcode
    python3 bench/make_passes.py --count 60 --out bench/passes
"""
import argparse
import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance
import pdf417gen
import qrcode

SURNAMES = ["GELLA", "SHARMA", "REDDY", "IYER", "KHAN", "PATEL", "NAIR", "SINGH", "DSOUZA", "BANERJEE",
            "RAO", "MENON", "CHOWDARY", "VARMA", "PILLAI", "KULKARNI", "MEHTA", "GUPTA", "BOSE", "SMITH"]
GIVEN = ["JAYARAMA KRISHNA", "PRIYA", "ARJUN", "ANANYA", "MOHAMMED", "KAVYA", "RAHUL", "SNEHA", "VIKRAM",
         "LAKSHMI", "ADITYA", "DIVYA", "SANJAY", "MEERA", "KIRAN", "ROHAN", "TANVI", "JOHN", "FATIMA", "NIKHIL"]
TITLES = ["MR", "MS", "MRS", "MR", "MS"]
CARRIERS = ["AI", "6E", "UK", "SG", "QP", "IX", "EK", "QR"]
AIRPORTS = ["BOM", "DEL", "BLR", "HYD", "MAA", "CCU", "AMD", "VTZ", "GOI", "COK", "DXB", "DOH"]
FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    except OSError:
        return ImageFont.load_default()


def bcbp(p):
    name = f"{p['surname']}/{p['given'].replace(' ', '')}"[:20].ljust(20)
    pnr = p["pnr"].ljust(7)
    flight_no = p["number"].zfill(4).ljust(5)
    row, letter = p["seat"][:-1], p["seat"][-1]
    seat = f"{row.zfill(3)}{letter}"
    seq = str(random.randint(1, 300)).zfill(4) + " "
    return f"M1{name}E{pnr}{p['from']}{p['to']}{p['carrier'].ljust(3)}{flight_no}{p['julian']:03d}Y{seat}{seq}100"


def random_pass(i):
    carrier = random.choice(CARRIERS)
    number = str(random.randint(100, 2999))
    a, b = random.sample(AIRPORTS, 2)
    seat = f"{random.randint(1, 45)}{random.choice('ABCDEFHJK')}"
    return {
        "id": f"pass_{i:03d}",
        "surname": random.choice(SURNAMES),
        "given": random.choice(GIVEN),
        "title": random.choice(TITLES),
        "carrier": carrier,
        "number": number,
        "flight": f"{carrier}{number}",
        "from": a,
        "to": b,
        "seat": seat,
        "gate": f"{random.randint(1, 40)}{random.choice(['', 'A', 'B'])}",
        "pnr": "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6)),
        "julian": random.randint(1, 365),
        "layout": random.choice(["slash", "labelled"]),
        "code": random.choice(["pdf417", "pdf417", "qr"]),
    }


def draw_pass(p):
    W, H = 1400, 620
    img = Image.new("RGB", (W, H), (250, 250, 247))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 90], fill=(170, 30, 40) if p["carrier"] == "AI" else (20, 40, 120))
    d.text((40, 22), "BOARDING PASS", font=font(40, True), fill="white")
    d.text((W - 360, 30), {"AI": "AIR INDIA", "6E": "INDIGO"}.get(p["carrier"], "AIRLINES"), font=font(30, True), fill="white")

    lab, val = font(22), font(36, True)
    if p["layout"] == "slash":
        d.text((40, 120), "NAME OF PASSENGER", font=lab, fill=(110, 110, 110))
        d.text((40, 150), f"{p['surname']}/{p['given']} {p['title']}", font=val, fill="black")
    else:
        d.text((40, 120), "Passenger Name", font=lab, fill=(110, 110, 110))
        d.text((40, 150), f"{p['title']} {p['given']} {p['surname']}", font=val, fill="black")

    cols = [("FLIGHT", f"{p['carrier']} {p['number']}"), ("FROM", p["from"]), ("TO", p["to"]),
            ("GATE", p["gate"]), ("SEAT", p["seat"])]
    x = 40
    for label, value in cols:
        d.text((x, 240), label, font=lab, fill=(110, 110, 110))
        d.text((x, 270), value, font=val, fill="black")
        x += 170
    d.text((40, 350), f"PNR {p['pnr']}    CLASS Y    BOARDING 07:35", font=lab, fill=(60, 60, 60))

    data = bcbp(p)
    if p["code"] == "pdf417":
        code = pdf417gen.render_image(pdf417gen.encode(data, columns=6, security_level=2), scale=3, ratio=3, padding=8)
        code = code.convert("RGB")
        img.paste(code, (40, H - code.height - 30))
    elif p["code"] == "qr":
        q = qrcode.QRCode(box_size=6, border=2)
        q.add_data(data)
        code = q.make_image(fill_color="black", back_color="white").convert("RGB")
        img.paste(code, (W - code.width - 60, 120))
    return img, data


def photo_distort(img, level):
    """level 0 = clean scan, 1 = decent phone photo, 2 = poor photo."""
    if level == 0:
        return img
    angle = random.uniform(-4, 4) * level
    bg = (random.randint(40, 90),) * 3
    canvas = Image.new("RGB", (img.width + 200, img.height + 200), bg)
    canvas.paste(img, (100, 100))
    canvas = canvas.rotate(angle, resample=Image.BICUBIC, fillcolor=bg)
    canvas = ImageEnhance.Brightness(canvas).enhance(random.uniform(0.75, 1.05))
    canvas = ImageEnhance.Contrast(canvas).enhance(random.uniform(0.6, 0.95) if level == 2 else random.uniform(0.85, 1.0))
    canvas = canvas.filter(ImageFilter.GaussianBlur(random.uniform(0.4, 1.1) * level))
    scale = random.uniform(0.75, 1.0) if level == 1 else random.uniform(0.6, 0.8)
    canvas = canvas.resize((int(canvas.width * scale), int(canvas.height * scale)), Image.BILINEAR)
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--out", default="bench/passes")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--text-only", action="store_true", help="omit the barcode (tests the OCR fallback)")
    args = ap.parse_args()
    random.seed(args.seed)
    os.makedirs(args.out, exist_ok=True)
    labels = []
    for i in range(args.count):
        p = random_pass(i)
        if args.text_only:
            p["code"] = "none"
        level = [0, 1, 1, 2][i % 4]
        img, data = draw_pass(p)
        img = photo_distort(img, level)
        path = os.path.join(args.out, f"{p['id']}.jpg")
        img.save(path, quality=random.randint(70, 90))
        labels.append({"file": os.path.basename(path), "quality": ["clean", "photo", "poor"][level],
                       "surname": p["surname"], "given": p["given"], "flight": p["flight"], "seat": p["seat"],
                       "from": p["from"], "to": p["to"], "layout": p["layout"], "code": p["code"], "bcbp": data})
    with open(os.path.join(args.out, "labels.json"), "w") as f:
        json.dump(labels, f, indent=1)
    print(f"wrote {len(labels)} passes to {args.out}")


if __name__ == "__main__":
    main()
