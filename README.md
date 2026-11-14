# Grants for Me

A questionnaire-driven grant finder for small businesses and nonprofits. It searches for matching grants every morning and puts their deadlines on **any calendar**: Google, Outlook / Microsoft 365, Apple, Yahoo, Proton or anything else that can subscribe to a calendar URL.

## What it does

1. **Asks about your organization** in a 4-step questionnaire covering:
   - organization type (sets eligibility)
   - state and service area
   - mission
   - focus areas
   - who you serve
   - keywords
   - minimum award size
   - deadline window
   - reminder and email preferences
2. **Scans Grants.gov every morning** through the official public API (no key needed):
   - Each keyword and population becomes its own search. It also runs one search across your focus areas.
   - Results are filtered to grants you are eligible for. It drops grants that close too soon, are too far out, or pay less than your minimum.
   - Matches are labelled **Strong** (matched your keywords) or **Broader** (matched a focus area only).
   - Award size and a summary are pulled for each new grant.
3. **Keeps your calendar current** through one subscription link (`/cal/<your-token>.ics`):
   - It holds all-day events on each deadline, with reminders before each one (14, 7 and 1 days by default).
   - It includes strong matches, anything you mark Reviewing, Applying or Submitted, and any grant you add by hand.
   - Grants you mark **Not a fit** come off the calendar.
   - Each grant also has a one-click "Add to calendar" (.ics) button.
4. **Emails a daily update** (optional) with new grants and deadlines in the next 14 days.
5. **Tracks grants from other sources.** You can add state, foundation and corporate grants by hand, and their deadlines go on the same calendar.

## Run it locally

```bash
npm install
npm start               # http://localhost:8080
npm test                # offline test suite (mocks Grants.gov)
```

## Deploy (Docker: any VPS, Render, Railway, Fly.io, DigitalOcean, AWS)

```bash
cp .env.example .env    # set PUBLIC_URL, and optionally SMTP_URL / APP_PASSWORD
docker compose up -d --build
```

- **Calendar subscriptions need a public HTTPS URL.** Put the app behind your host's HTTPS, Caddy, nginx or Cloudflare. Google and Outlook can't subscribe to `localhost`.
- Data is a single JSON file in the `/data` volume, so back that up.
- On Render or Railway, attach a persistent disk at `/data` and set the start command to `node src/server.js`.

## Connecting a calendar

The dashboard has one-click buttons. To connect by hand:

| Calendar | How |
|---|---|
| Google | Other calendars → **+** → **From URL** → paste the feed link |
| Outlook / Microsoft 365 | Add calendar → **Subscribe from web** → paste the link |
| Apple (Mac/iPhone) | File → **New Calendar Subscription** → paste the link (or tap the Apple Calendar button) |
| Anything else | Use "subscribe to calendar by URL" with the same link |

How often each app refreshes is up to the app. Google can take 8–24 hours; Apple and Outlook are usually faster. **Google ignores reminders inside subscribed calendars**, so set a default notification on the "Grant Deadlines" calendar in Google settings. Apple and Outlook use the built-in reminders.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | from request | Base URL used in feed links and emails |
| `TZ_NAME` | `America/New_York` | Time zone for "today" and the schedule |
| `SCAN_CRON` | `0 6 * * *` | Daily scan time |
| `APP_PASSWORD` | – | Password-protects the dashboard (feeds stay open to calendar apps) |
| `ALLOW_SIGNUP` | `true` | Set `false` once your orgs are set up |
| `SMTP_URL` / `MAIL_FROM` | – | Turns on the daily email |

## How access works

- Each organization gets a random private token, which is part of its dashboard link and calendar link. Anyone with the link can see that org's grant list, so treat it like a shared-doc link.
- Several organizations can use one server. Each one completes the questionnaire and gets its own dashboard and feed. That makes it usable for clients or as a white-label service.

## Limits to know

- The automatic search covers **federal** grants on Grants.gov. State, foundation and corporate grants aren't published through one shared API, so add those by hand in the "tracking" section.
- Grants.gov deadlines are usually 11:59 PM Eastern. Calendar events are all-day on the deadline date, so always confirm the time on the official listing.
- This product uses the Grants.gov API but is not endorsed or certified by HHS.

## Project layout

```
src/server.js    Express app: dashboard, API, calendar feeds, daily cron
src/grants.js    Grants.gov client, matching and filtering, merge logic
src/ics.js       RFC 5545 calendar feed builder
src/digest.js    Daily email (nodemailer, optional)
src/config.js    Questionnaire options → Grants.gov eligibility and category codes
src/store.js     JSON file storage
public/index.html  Questionnaire + dashboard (no build step)
test/run-tests.js  Offline tests
```
