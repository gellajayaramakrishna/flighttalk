# FlightTalk

**An offline social layer for aircraft cabins: chat, games and watch-together over the plane's local Wi-Fi, with no internet at all.**

Passengers scan their boarding pass, pick a nickname, and can then talk to the cabin, privately message people who accept their request, play games against each other or against the computer, and watch a film in sync. Cabin crew get a console to moderate, make announcements and pause everything during turbulence or an emergency. When the flight ends, the crew erase every trace of it.

Everything runs on one small onboard server (a laptop today, a Raspberry-Pi-class box in principle). **The app makes zero requests off the aircraft**: barcode reader, OCR engine, language data, fonts and scripts are all served locally. This is verified by a headless-browser test.

```text
 Passenger phones / seat-back screens
            │  cabin Wi-Fi (no internet)
            ▼
 ┌─────────────────────────────────────────┐
 │ FlightTalk server (Node.js)             │
 │  Express ─ REST API + static assets     │
 │  Socket.IO ─ real-time chat & games     │
 │  SQLite ─ one database per flight       │
 │  Game engine ─ server-authoritative     │
 │  Safety ─ filters, rate limits, crew    │
 └─────────────────────────────────────────┘
            ▲
            │  same Wi-Fi
       Crew console (/crew.html)
```

---

## Measured results

All numbers come from scripts in `bench/` and `test/` and are reproducible. The hardware was a 2-core cloud VM (Intel Xeon 2.1 GHz). The simulated clients ran on the same machine as the server, so a real deployment should do at least this well.

| What | Result |
|---|---|
| Boarding-pass read, real in-browser pipeline, 100 held-out passes **with barcode** | flight, seat **and** name all correct on **96%** · median scan **0.06 s** |
| Same, 100 held-out **text-only** passes (OCR fallback) | all three fields correct on **80%** · median **0.9 s** |
| Passenger name read rate: v1 vs v2 (Node benchmark, held-out) | **0% → 97%** (passes with barcode) / **0% → 90%** (text-only) |
| Seat read rate, OCR path: v1 regex vs v2 parser | **8% → 70%** (Node) / **82%** (in browser) |
| Barcode → fields (when the barcode decodes) | **100%** correct (IATA BCBP parser) |
| Load: **250 passengers**, 20 msg/s cabin chat for 20 s | **100,000 deliveries, 100% delivered**, p50 **4 ms** / p95 **7 ms** / p99 **10.5 ms** |
| Load: **500 passengers**, 40 msg/s | **400,000 deliveries, 100% delivered**, p95 **11.5 ms**, ~**18.6k deliveries/s**, server RAM **136 MB** |
| Tic-Tac-Toe bot (hard) | **0 losses in 1,000 games** (perfect minimax) |
| Connect Four bot (hard, depth-6 alpha-beta) | **200/200** wins vs random · **91%** vs the easy bot · p95 move time 126 ms |
| Ludo bot (heuristic) | **92%** wins vs random play |
| Automated tests | **47 tests** (unit + HTTP/WebSocket integration), all passing |
| External network requests during a full session | **0** (headless Chrome, strict CSP) |

The "held-out" passes were generated with seeds that were never used while tuning the parser. Raw results are in `bench/results/`.

---

## Features

### Boarding-pass onboarding (rebuilt in v2)
- **Barcode first.** Every boarding pass carries an IATA *Bar Coded Boarding Pass* (BCBP, Resolution 792) in a PDF417, Aztec or QR code. FlightTalk decodes it on the phone with `zxing-wasm` and parses the fixed-width fields: name, PNR, route, carrier, flight number, Julian date, seat and multi-leg itineraries.
- **OCR fallback.** If there is no readable barcode, the image is contrast-enhanced and read with `tesseract.js`, twice if needed (normal and "sparse text" page modes). A parser built for boarding-pass layouts then extracts the fields. It handles `SURNAME/GIVEN MR`, label rows with value rows underneath ("FLIGHT FROM TO GATE SEAT"), glued tokens (`2392VTZ`), fuzzy labels (`EAT` → `SEAT`), and the usual OCR confusions (`Al` → `AI`, `0O9A` → `9A`, `29)` → `29J`).
- **Live camera scanning** (barcode mode, needs HTTPS) or photo upload.
- The image never leaves the phone. Only flight, seat, name and date are sent.

### Privacy by design
- **The raw name is never stored.** The server keeps only an HMAC of (name key + flight + seat) under a per-flight secret, which is enough to recognise "same passenger, new phone". Session tokens are stored hashed too.
- **Your exact seat is never shown to other passengers**, only a 10-row zone ("Rows 11–20").
- **Opt-in discovery.** You're invisible in the passenger list unless you switch on "Discoverable".
- The suggested nickname is the first 3 letters of your given name. Using your surname as a display name is refused.
- **End of flight wipe.** One crew action erases all passengers, messages, files and reports, and rotates the secret.

### Communication
- Cabin-wide chat, room chats and private chats, with typing indicators.
- **Consent-based private chat**: request → accept/decline → chat. Either side can end it. A declined request has a 10-minute cooldown, and you can have at most 5 pending requests.
- Do Not Disturb hides new requests and invites.
- File sharing in any chat: allow-listed types, authenticated downloads, chunked and **resumable** uploads (retries each 1 MB chunk).
- **Watch together**: the host plays a local video, and play/pause/seek is mirrored to everyone's own copy with drift correction (>1 s).

### Games (server-authoritative)
- **Tic-Tac-Toe, Connect Four, Ludo (2–4 players)**: vs the computer (easy/hard) or with other passengers, or mixed (add bots to a room).
- The server validates every move, so a modified client can't cheat.
- Full Ludo rules: a 6 to leave the yard, safe ★ squares, captures send pieces home, a bonus roll on a 6, a capture or reaching home, three 6s forfeits the turn, exact roll to finish. The board is a classic 15×15 layout.
- **Turn timer** (45 s) auto-moves for idle players, so one person walking away can't freeze a game. Leaving or being kicked counts as a forfeit, and Ludo carries on without that player.
- Rematch with rotating first player, and games resume after a server restart.

### Safety & moderation
| Layer | What it does |
|---|---|
| Profanity filter | Masks slurs and abuse (including leetspeak like `sh1t`, `f.u.c.k`, and common Hindi abuse) without false positives on words like "Scunthorpe" or "class" |
| **Personal-info shield** | Hides phone numbers, emails, links, card numbers and social handles in public chats. In private chats it warns the sender instead. |
| Rate limiting | 8 messages / 10 s per chat, per-user cap, copy-paste spam detection, socket flood protection (>40 events / 5 s disconnects) |
| Report → **auto-mute** | Reports go to the crew live. **3 different reporters** on one person mutes them for 30 min pending crew review. |
| Silent two-way block | Blocked people disappear from each other's lists, chats and lobby, and the blocked person isn't told |
| **Flight lock** | Crew set the flight number, so passes for other flights (or other dates) are rejected |
| **Quiet mode** | Crew pause all passenger chat, requests and games instantly (turbulence, safety demo, emergencies) with a banner on every screen |
| Announcements | Info or safety banners pushed to every passenger |
| **Seat-conflict handling** | If someone scans another person's pass first, the real passenger gets a clear error, the crew get an alert, and "Release seat" lets the real passenger in |
| Crew console | Live stats, reports with the reported message, mute/unmute/remove, audit log, PIN with lockout (5 wrong attempts → 5 min) |
| Web security | Strict Content-Security-Policy (no inline scripts, no eval), `nosniff`, no framing, files force-downloaded as `application/octet-stream` (blocks stored-XSS via uploaded HTML), no public uploads folder |

---

## Running it

Requirements: **Node.js 22+**.

```bash
npm install
npm start
```

The console prints the passenger URL, the LAN address for phones, and the **crew PIN**:

```text
  FlightTalk cabin server is running (no internet needed)
  Passengers : http://localhost:3001
               http://192.168.1.23:3001
  Crew       : http://localhost:3001/crew.html   PIN 482913
```

Options (environment variables): `PORT`, `CREW_PIN`, `FT_FLIGHT=AI865` (lock the cabin at startup), `FT_DATA_DIR`.

### Phones and the camera (HTTPS)
Browsers only allow the camera on HTTPS. Create a local certificate once:

```bash
brew install mkcert      # macOS (recommended), or skip to use openssl
npm run cert             # writes data/cert.pem + data/key.pem for localhost and your LAN IP
npm start                # now serves https://
```

On an iPhone, install and trust the mkcert root CA (`mkcert -CAROOT` shows where it is). Photo upload works over plain HTTP too.

### Testing "no internet" for real
Put the laptop and the phones on a hotspot or router that has **no internet uplink**, then open `https://<laptop-ip>:3001` on each phone.

---

## Tests and benchmarks

```bash
npm test                 # 47 unit + integration tests (node:test, real HTTP + WebSocket server)
npm run bench:load       # load test (defaults: 250 passengers)
node bench/load-test.js --users 500 --rate 40 --seconds 20
npm run bench:bots       # bot strength vs random / easy
npm run bench:passes     # generates 200 synthetic boarding passes and measures extraction accuracy
                         # (needs: pip install pillow pdf417gen qrcode)
python3 bench/browser-scan.py bench/passes bench/passes_text   # same, through the real browser UI (needs playwright)
```

`bench/make_passes.py` draws realistic passes (two common layouts, PDF417 or QR barcode) and applies "phone photo" distortions: rotation, blur, low contrast, JPEG noise and downscaling.

---

## Project structure

```text
server/
  index.js        start-up banner, LAN addresses
  app.js          Express routes, Socket.IO events, crew API, housekeeping
  games.js        Tic-Tac-Toe / Connect Four / Ludo engines + bots
  safety.js       profanity filter, PII shield, rate limiter, spam detector
  db.js           SQLite schema (per-flight data)
  config.js       limits and settings
public/
  index.html      passenger app
  crew.html       crew console
  js/pass-parse.js  IATA BCBP + OCR boarding-pass parsers (shared with Node tests)
  js/scanner.js     barcode → OCR pipeline, live camera scanning
  js/core.js        passenger client
  js/ludo-board.js  15×15 Ludo board renderer
  js/crew.js        crew console client
  vendor/tessdata/  offline OCR language data
test/             node:test suites
bench/            synthetic pass generator, accuracy / load / bot benchmarks, results/
scripts/          local HTTPS certificate helper
```

## Known limitations (honest list)
- **No airline manifest check.** The boarding pass proves structure, not ownership. Someone holding a photo of your pass can claim your seat first. Mitigations: barcode-verified badge, seat-conflict alerts to crew, and crew "Release seat". The real fix is integration with the airline's departure control system.
- The accuracy numbers come from synthetic passes. Real airline layouts vary, and the barcode path is the robust one.
- Tested on laptops, phones and a cloud VM, not on certified aircraft hardware.
- Watch-together needs every viewer to have the same file locally (no streaming yet).

## What changed in v2
v1 never read the passenger's name (only a flight/seat regex), the game "Start" button was on a screen game rooms never showed, Ludo's home column mapped two squares to the same position, leaving a game froze it, kicked users kept receiving room messages, private messages were delivered twice, uploaded files were publicly reachable (and `.html` uploads were a stored-XSS hole), and the session TTL was never enforced. All of these are fixed and covered by tests.
