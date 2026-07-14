# Healthcare Appointment & Follow-up Manager

A clinic platform with separate portals for **patients**, **doctors**, and an **admin**. Patients
book appointments and share symptoms in advance; an LLM produces a pre-visit summary with an
urgency level for the doctor; after the visit, the doctor's notes and prescription are turned into
a patient-friendly summary. Both sides get email notifications and Google Calendar events.

## Contents

- [Architecture](#architecture)
- [Setup guide](#setup-guide)
- [Environment variables](#environment-variables)
- [Database schema](#database-schema)
- [API reference](#api-reference)
- [LLM prompts](#llm-prompts)
- [Google Calendar setup](#google-calendar-setup)
- [Email setup](#email-setup)
- [Background jobs](#background-jobs)
- [Deploying](#deploying)

## Architecture

```
server/   Node.js + Express API, SQLite (better-sqlite3), JWT auth, LLM/email/calendar services
client/   React + Vite SPA — three portals (patient, doctor, admin) behind role-based routing
```

SQLite was chosen deliberately over Postgres/MySQL: it needs zero external setup (no DB server to
provision on a free host), it's a single file that's trivial to back up, and — because
`better-sqlite3` is synchronous — the double-booking guard (see `SYSTEM_DESIGN.md`) can be
expressed as a plain, easy-to-audit database transaction instead of async locking.

## Setup guide

### Prerequisites
- Node.js 18+ (uses the global `fetch` API)
- npm

### 1. Backend

```bash
cd server
cp .env.example .env      # fill in the values described below
npm install
npm run seed               # creates data/app.db with an admin + a sample doctor
npm run dev                 # http://localhost:4000
```

Seeded logins:
| Role   | Email                          | Password    |
|--------|---------------------------------|-------------|
| Admin  | admin@clinic.example.com        | Admin@123   |
| Doctor | asha.rao@clinic.example.com     | Doctor@123  |

Patients self-register via the app (`POST /api/auth/register`).

### 2. Frontend

```bash
cd client
cp .env.example .env       # set VITE_API_BASE if the backend isn't on localhost:4000
npm install
npm run dev                 # http://localhost:5173
```

Open `http://localhost:5173`, log in with one of the seeded accounts above, or register as a
patient.

## Environment variables

See `server/.env.example` and `client/.env.example` for the full list with inline comments. Key ones:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs auth tokens — set a long random string in production |
| `DB_PATH` | Where the SQLite file lives |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | LLM calls for pre/post-visit summaries |
| `SMTP_*`, `EMAIL_FROM` | Outbound email |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Calendar OAuth |
| `SLOT_HOLD_TTL_MINUTES` | How long a slot hold survives before expiring |
| `REMINDER_JOB_CRON` / `EMAIL_RETRY_JOB_CRON` | Background job schedules |

If `ANTHROPIC_API_KEY` is left unset, LLM calls fail gracefully and the system falls back to a
raw-input summary flagged `pre_visit_llm_status: "failed"` — booking is never blocked by an LLM
outage (see `SYSTEM_DESIGN.md`).

## Database schema

Full DDL lives in `server/src/db/schema.sql`. Summary:

- **users** — patients, doctors, admins in one table, disambiguated by `role`
- **doctors** — one row per doctor: specialisation, working hours, slot duration, working days
- **doctor_leaves** — dates a doctor is unavailable (`UNIQUE(doctor_id, leave_date)`)
- **slot_holds** — short-lived (default 5 min) hold on a slot while a patient fills the symptom
  form; `UNIQUE(doctor_id, slot_start)` so only one patient can hold a given slot at a time
- **appointments** — the booking itself, plus `symptom_text`, `pre_visit_summary_json`,
  `post_visit_notes`, `prescription_json`, `post_visit_summary_json`, and calendar event IDs for
  both parties. A **partial unique index** on `(doctor_id, slot_start) WHERE status='confirmed'`
  is the authoritative double-booking guard — cancelled rows don't block rebooking the same slot
- **medication_reminders** — generated from the prescription; a background job sends reminders
  until `sends_remaining` reaches zero
- **notifications_log** — every email is logged before sending (outbox pattern); failed sends are
  retried by a background job
- **google_tokens** — per-user OAuth tokens for Google Calendar

## API reference

All endpoints are under `/api`. Authenticated requests send `Authorization: Bearer <token>`.

### Auth
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/register` | public | Patient self-registration |
| POST | `/auth/login` | public | Returns `{ token, user }` |
| GET | `/auth/me` | any | Current user profile |

### Admin
| Method | Path | Role |
|---|---|---|
| POST | `/admin/doctors` | admin — create a doctor account + profile |
| GET | `/admin/doctors` | admin — list doctors |
| PATCH | `/admin/doctors/:id` | admin — update specialisation/hours/slot length |
| POST | `/admin/doctors/:id/leaves` | admin — mark a leave date; cancels + notifies any affected bookings |

### Doctors / slots (patient-facing search)
| Method | Path | Role |
|---|---|---|
| GET | `/doctors?specialisation=` | authenticated — search |
| GET | `/doctors/:id/slots?date=YYYY-MM-DD` | authenticated — available slots for a date |

### Appointments
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/appointments/hold` | patient | `{ doctorId, slotStart, slotEnd }` → `{ holdId, expiresInMinutes }` |
| POST | `/appointments/confirm` | patient | `{ holdId, symptomText }` → creates the appointment, runs the pre-visit LLM prompt, sends emails, creates calendar events |
| POST | `/appointments/:id/cancel` | patient/doctor/admin | `{ reason }` |
| GET | `/appointments/mine` | patient | Patient's own appointments |
| GET | `/appointments/doctor` | doctor | Doctor's own appointments |
| POST | `/appointments/:id/post-visit` | doctor | `{ notes, prescription: [{ medication, dosage, frequencyPerDay, durationDays }] }` → runs the post-visit LLM prompt, schedules medication reminders |

### Calendar
| Method | Path | Role |
|---|---|---|
| GET | `/calendar/google/connect` | authenticated — returns the Google OAuth consent URL |
| GET | `/calendar/google/status` | authenticated — whether this user has connected |
| GET | `/calendar/google/callback` | public — Google's OAuth redirect target |

## LLM prompts

Implemented in `server/src/services/llmService.js`, called via the Anthropic Messages API.

**Pre-visit summary** (on booking confirmation):
> Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and
> three suggested questions for the doctor. Symptoms: `<symptoms>`

**Post-visit summary** (when the doctor submits notes):
> Convert these clinical notes into a patient-friendly summary with medication schedule and
> follow-up steps: `<notes>`

Both are asked to return strict JSON so the result can be stored and rendered directly; both have
a hand-written fallback if the LLM call fails or returns malformed JSON, so a bad response never
blocks the appointment flow (see `pre_visit_llm_status` / `post_visit_llm_status` on the
appointment record).

## Google Calendar setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one)
   and enable the **Google Calendar API**.
2. Configure the OAuth consent screen (External is fine for testing; add your test users' emails).
3. Under **Credentials**, create an **OAuth client ID** of type "Web application".
   - Add an **Authorized redirect URI** matching `GOOGLE_REDIRECT_URI` in your `.env`, e.g.
     `http://localhost:4000/api/calendar/google/callback`.
4. Copy the generated **Client ID** and **Client secret** into `server/.env`.
5. In the app, each patient and doctor connects their own calendar by visiting the URL returned
   from `GET /api/calendar/google/connect` (the frontend can wire a "Connect Google Calendar"
   button to this). Tokens are stored per user in the `google_tokens` table.
6. Calendar sync is best-effort: if a user hasn't connected, or the API call fails, the booking
   still succeeds — see `SYSTEM_DESIGN.md`.

## Email setup

Any SMTP provider works — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` in
`server/.env`. Tested against Mailgun's and SendGrid's SMTP relays and Gmail (with an
[app password](https://support.google.com/accounts/answer/185833)). Every email is logged to
`notifications_log` before sending; failures are retried automatically by the background job
(`EMAIL_RETRY_JOB_CRON`, default every 2 minutes, up to 5 attempts per message).

## Background jobs

Started in `server/src/services/reminderJob.js` via `node-cron`:
- **Medication reminders** — every `REMINDER_JOB_CRON` (default 5 min), emails patients when a
  scheduled dose is due, based on the prescription's frequency
- **Appointment reminders** — emails patients ~24 hours before their slot
- **Email retry** — every `EMAIL_RETRY_JOB_CRON` (default 2 min), resends anything logged as
  `failed` with retries remaining

## Deploying

Both apps are standard Node/Vite projects and deploy to any Node-friendly host (Render, Railway,
Fly.io, etc. for the API; Vercel/Netlify or the same host for the static frontend build via
`npm run build` → serve `client/dist`). Since the database is a single SQLite file, make sure your
host's filesystem is persistent (or mount a volume for `DB_PATH`) — most free tiers with ephemeral
filesystems will lose data on redeploy, so pick a host that offers a persistent disk/volume.
