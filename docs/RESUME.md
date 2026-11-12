# FlightTalk — resume bullets and interview notes

## Resume entry (pick 3–4 bullets)

**FlightTalk — Offline In-Flight Social Platform** | Node.js, Express, Socket.IO, SQLite, WebAssembly, Tesseract.js

- Built an offline-first cabin platform (chat, multiplayer games, watch-together) that runs on one local server over aircraft Wi-Fi with no internet; verified 0 external network requests under a strict Content-Security-Policy.
- Replaced regex-based OCR onboarding with an on-device IATA boarding-pass barcode decoder (WASM) plus a layout-aware OCR fallback, raising passenger-name extraction from 0% to 97% and full-field accuracy to 96% on 100 held-out passes (median scan 60 ms).
- Load-tested 500 simulated passengers: 400K real-time message deliveries, 100% delivered, p95 latency 11.5 ms, 136 MB server memory on a 2-core VM.
- Designed a safety layer (consent-based DMs, contact-detail masking, report-threshold auto-mute, crew console with quiet mode and flight lock) with HMAC-hashed identities and an end-of-flight data wipe.
- Wrote a server-authoritative game engine (Tic-Tac-Toe, Connect Four, Ludo) with minimax / alpha-beta bots (0 losses in 1,000 games) and turn timers; covered by 47 automated tests.

Shorter one-liner if space is tight:
> Offline in-flight chat and games platform (Node.js, Socket.IO, SQLite, WASM): boarding-pass barcode onboarding (name extraction 0% → 97%), 500-passenger load test at p95 11.5 ms, crew moderation console, 47 tests.

## Questions you'll probably get

**Why decode the barcode instead of improving OCR?**
OCR guesses at printed text, and every airline prints a different layout. The barcode is a standard (IATA BCBP, Resolution 792) with fixed-width fields, so once it decodes, the fields are exact. That's why the barcode path is 100% correct when it decodes. OCR stays as a fallback for passes without a readable code.

**What's inside the barcode?**
`M1` (format + number of legs), 20-char name `SURNAME/GIVEN`, e-ticket flag, 7-char PNR, from, to, carrier, 5-char flight number, 3-digit Julian date, cabin class, 4-char seat `012A`, check-in sequence, passenger status, then a hex length for an optional conditional block. Further legs repeat from the PNR onward.

**How do you know the accuracy numbers aren't overfitted?**
I tuned the parser on one generated set, then measured on fresh sets generated with different random seeds (held-out). The generator adds rotation, blur, low contrast, JPEG noise and downscaling.

**How does real-time delivery work?**
Socket.IO rooms: one for the cabin lobby, one per game/chat room, and one per user (`user:<id>`) for private messages and notifications. A private message is emitted to both users' rooms in a single call, so a device that's in both rooms still gets it once. That was a duplicate-delivery bug in v1.

**Why SQLite?**
One server per aircraft, a few hundred users, and no network to a database. SQLite in WAL mode is embedded, needs no setup, and survives restarts. Data only lives for one flight.

**How do you stop cheating in games?**
Clients send intentions ("drop in column 3"). The server holds the authoritative state, checks whose turn it is and whether the move is legal, then broadcasts the new state.

**How do you protect privacy if someone copies the database?**
Names are never stored. Only HMAC-SHA256(name key | flight | seat) is kept, under a per-flight secret that is rotated at the end of the flight. Session tokens are stored as SHA-256 hashes. Other passengers only ever see a 10-row seat zone.

**What's the weakest part?**
Identity. Without the airline's passenger list, a photo of someone's pass is enough to claim their seat first. I detect the conflict, alert the crew and give them a "release seat" action. The real fix is an integration with the airline's departure control system.

**How would you scale beyond one server?**
Socket.IO's Redis adapter (or another pub/sub layer) to share rooms across processes, with sticky sessions on the load balancer. In a cabin, one Node process already handles 500 passengers with headroom.
