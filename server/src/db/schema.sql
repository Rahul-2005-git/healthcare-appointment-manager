-- Healthcare Appointment & Follow-up Manager — SQLite schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  phone         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per doctor, extending a user with role = 'doctor'
CREATE TABLE IF NOT EXISTS doctors (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  specialisation      TEXT NOT NULL,
  working_hours_start TEXT NOT NULL,   -- 'HH:MM' 24h, e.g. '09:00'
  working_hours_end   TEXT NOT NULL,   -- 'HH:MM' 24h, e.g. '17:00'
  slot_duration_mins  INTEGER NOT NULL DEFAULT 30,
  working_days        TEXT NOT NULL DEFAULT '1,2,3,4,5', -- ISO weekday numbers, 1=Mon..7=Sun
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id         TEXT PRIMARY KEY,
  doctor_id  TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  leave_date TEXT NOT NULL, -- 'YYYY-MM-DD'
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doctor_id, leave_date)
);

-- Temporary hold on a slot while a patient is filling the symptom form / confirming.
-- Prevents two patients from racing to confirm the same slot. Expires automatically.
CREATE TABLE IF NOT EXISTS slot_holds (
  id           TEXT PRIMARY KEY,
  doctor_id    TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  slot_start   TEXT NOT NULL, -- ISO datetime, UTC
  slot_end     TEXT NOT NULL,
  held_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doctor_id, slot_start)
);

CREATE TABLE IF NOT EXISTS appointments (
  id                        TEXT PRIMARY KEY,
  patient_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id                 TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  slot_start                TEXT NOT NULL, -- ISO datetime, UTC
  slot_end                  TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('confirmed','cancelled','completed','no_show')),
  symptom_text              TEXT,
  pre_visit_summary_json    TEXT,   -- { urgency, chiefComplaint, questions[] } or null if LLM failed
  pre_visit_llm_status      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (pre_visit_llm_status IN ('pending','ok','failed','skipped')),
  post_visit_notes          TEXT,
  prescription_json         TEXT,   -- [{ medication, dosage, frequencyPerDay, durationDays }]
  post_visit_summary_json   TEXT,   -- { summary, medicationSchedule[], followUp }
  post_visit_llm_status     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (post_visit_llm_status IN ('pending','ok','failed','skipped')),
  patient_calendar_event_id TEXT,
  doctor_calendar_event_id  TEXT,
  cancel_reason             TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The core double-booking guard: SQLite enforces at the storage-engine level
-- (not just application logic) that a doctor cannot have two CONFIRMED
-- appointments in the same slot. Because it's a partial index (WHERE status =
-- 'confirmed'), a cancelled appointment doesn't block the slot being rebooked.
-- This is what makes concurrent booking attempts safe: even if two requests
-- race past the application-level slot_holds check, only one INSERT can
-- succeed here — the other fails with a UNIQUE constraint violation that the
-- controller catches and turns into a clean "slot no longer available" error.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_confirmed_slot
  ON appointments(doctor_id, slot_start) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS medication_reminders (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication     TEXT NOT NULL,
  dosage         TEXT,
  times_per_day  INTEGER NOT NULL DEFAULT 1,
  duration_days  INTEGER NOT NULL DEFAULT 5,
  next_send_at   TEXT NOT NULL, -- ISO datetime, UTC
  sends_remaining INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every outbound email is logged here so the retry job can find and resend failures.
CREATE TABLE IF NOT EXISTS notifications_log (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL, -- booking_confirmation | reminder | cancellation | leave_conflict | medication_reminder
  recipient     TEXT NOT NULL,
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 5,
  related_appointment_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);

-- Stores Google OAuth tokens per user so calendar events can be created on their behalf.
CREATE TABLE IF NOT EXISTS google_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT,
  refresh_token TEXT,
  scope         TEXT,
  token_type    TEXT,
  expiry_date   INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date ON appointments(doctor_id, slot_start);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_reminders_next_send ON medication_reminders(next_send_at, status);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications_log(status);
