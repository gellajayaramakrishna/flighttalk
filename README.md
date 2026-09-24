# FlightTalk

**Offline-first passenger communication and social-entertainment platform**

FlightTalk is an aircraft-oriented prototype for communication and social entertainment over a **local network without requiring internet or mobile data**.

The core idea is simple:

```text
Passenger devices
       |
   Local Wi-Fi
       |
FlightTalk local server
       |
+------+------+----------------+
|      |      |                |
Chat  Rooms  Games      Watch Together
```

The project is designed around the idea that an aircraft can provide local connectivity and onboard computing even when passengers do not have internet access.

## What FlightTalk does

The current prototype includes:

- Boarding-pass based flight/seat onboarding using **local OCR**
- Passenger display names
- Private passenger chat
- Chat requests with accept/decline
- Contacts
- Do Not Disturb (DND)
- Local real-time typing indicators
- Rooms
- Multiplayer games
- Bot gameplay for selected games
- Game invitations between passengers
- Active-game tracking
- Local watch-together synchronization for media available on each device
- SQLite-backed persistence
- Basic message filtering and rate limiting
- Local file/server infrastructure for future features

## Offline-first architecture

FlightTalk does not require a cloud backend for its core communication flow.

The intended architecture is:

```text
Phone / IFE device
        |
        | local Wi-Fi
        v
+-----------------------+
| FlightTalk Server     |
|                       |
| Node.js + Express     |
| Socket.IO             |
| SQLite                |
| Local OCR assets      |
+-----------------------+
        ^
        |
   Other passengers
```

The server can run on a laptop during development or on a small onboard computer such as a Raspberry Pi in a future deployment.

**Offline here means no internet is required; the passenger devices still need to be connected to the same local FlightTalk network.**

## Technology stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express
- **Real-time communication:** Socket.IO
- **Database:** SQLite with `better-sqlite3`
- **OCR:** Tesseract.js with locally served English language data
- **Uploads:** Multer / local server storage
- **Games:** Server-authoritative multiplayer game state
- **Transport:** HTTP for development; local HTTPS support through locally supplied certificates

## Project structure

```text
flighttalk/
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── js/
│   └── vendor/
│       └── tessdata/
├── server/
│   ├── index.js
│   ├── db.js
│   ├── games.js
│   ├── safety.js
│   └── config.js
├── scripts/
│   └── make-cert.sh
├── data/
├── uploads/
├── package.json
└── package-lock.json
```

## Running locally

Requirements:

- Node.js 18 or newer
- npm

Install dependencies:

```bash
npm install
```

Start FlightTalk:

```bash
npm start
```

The development server runs on port `3001`.

Open:

```text
http://localhost:3001
```

For testing from another device on the same local network, use the host computer's local IP address:

```text
http://<LOCAL-IP>:3001
```

## Boarding-pass onboarding

FlightTalk uses Tesseract.js locally in the browser to read boarding-pass images.

The current onboarding focuses on extracting:

- Flight number
- Seat number

The application does **not** connect to an airline passenger manifest.

OCR is therefore used as a convenience/onboarding mechanism rather than as proof of passenger identity or boarding-pass authenticity.

## Real-time communication

Socket.IO provides the local real-time communication layer.

This is used for:

- Private messages
- Typing indicators
- Presence/updates
- Chat requests
- Room updates
- Game state updates
- Watch-together synchronization

Because Socket.IO connects to the local FlightTalk server, these features do not inherently require an internet connection.

## Games

The prototype includes:

- Tic-Tac-Toe
- Connect Four
- Ludo

Games support the concept of both local bot play and multiplayer rooms where supported.

For multiplayer games, the server maintains the authoritative game state rather than trusting clients to decide whether a move is legal.

## Watch Together

Watch Together is designed for **local media already available on the participating devices**.

FlightTalk synchronizes playback state such as:

- Play
- Pause
- Current playback position

The media itself does not need to be streamed from the internet.

## Safety and privacy

The prototype includes several safety-oriented mechanisms:

- Chat requests instead of automatically opening private conversations
- Do Not Disturb
- Blocking
- User reports
- Basic profanity filtering
- Message rate limiting
- Seat/flight context for the airline mode
- Display-name privacy guidance

The system intentionally does not claim to provide perfect identity verification or complete security against every possible attack.

## Current limitations

FlightTalk is a prototype/MVP and is still being developed.

Known limitations include:

- OCR accuracy depends on boarding-pass image quality and layout.
- Boarding-pass OCR does not prove authenticity or verify against an airline manifest.
- The current prototype has been tested primarily on local development networks rather than aircraft hardware.
- Watch Together requires the media to be available locally on participating devices.
- Game UI and gameplay are still being refined.
- Production deployment would require additional hardening, authentication, network isolation, logging/auditing, and operational testing.

## Why I built it

The project started from a simple question:

> **What could passengers do with each other if an aircraft had a local network, but internet access was unavailable?**

FlightTalk is my exploration of that problem, starting with local communication and extending the same architecture into rooms, multiplayer games, and shared entertainment.

## Roadmap

Planned improvements include:

- More robust boarding-pass parsing across different airline layouts
- More polished mobile and desktop UI
- More complete multiplayer game experiences
- Improved Watch Together experience
- Stronger security and network isolation
- Larger-file and resumable-transfer improvements
- More extensive offline/device testing
- Potential airline-specific integrations where appropriate

## Status

**Active prototype / MVP — under development.**
