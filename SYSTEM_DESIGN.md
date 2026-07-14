# System Design Write-up

## Double-booking prevention

Booking uses two layers, deliberately kept separate: a fast **application-level check** for good
UX, and a **database-level constraint** as the source of truth.

The application layer (`slot_holds` table) lets a patient tentatively claim a slot the moment they
click it, before they've finished the symptom form — otherwise two patients could both see a slot
as "available", both start filling the form, and both expect to get it. The hold has a
`UNIQUE(doctor_id, slot_start)` index, so two simultaneous hold requests for the same slot resolve
deterministically: one `INSERT` succeeds, the other throws a constraint violation that the
controller turns into a clean `409 "currently being booked by someone else"`. Holds expire (default
5 minutes) and expired ones are purged at the start of every hold attempt, so an abandoned booking
doesn't permanently lock a slot.

The database layer is what actually prevents double-booking, independent of whether the hold step
was used correctly. `appointments` has a **partial unique index**:
`CREATE UNIQUE INDEX idx_unique_confirmed_slot ON appointments(doctor_id, slot_start) WHERE status = 'confirmed'`.
Because it's partial, a cancelled appointment doesn't block the same slot being rebooked, but two
*confirmed* rows for the same doctor/time can never coexist — enforced by SQLite itself, not by
application logic that could have a bug or a race condition. The confirm step inserts inside a
`db.transaction()`; if the insert throws a `UNIQUE` error, the patient gets a clean "this slot was
just booked" message rather than a 500 or a silent double-booking. This is what makes *simultaneous*
booking attempts safe even if both requests somehow skip or race past the hold check: the last
line of defense is a storage-engine guarantee, not a `SELECT`-then-`INSERT` race in JavaScript.

## Slot hold mechanism

Slots are generated on the fly from `doctors.working_hours_start/end` and `slot_duration_mins` —
they aren't pre-materialized rows, so there's nothing to clean up when a doctor's schedule changes.
`GET /doctors/:id/slots?date=` computes the full day's slots, then subtracts three sets: confirmed
appointments, live (unexpired) holds, and — if the date falls on a leave day or a non-working
day — everything. The hold created by `POST /appointments/hold` is the bridge between "browsing"
and "committing": it exists purely to prevent the two-patient race described above during the
symptom-form step, and is deleted the moment `POST /appointments/confirm` successfully inserts the
appointment (or left to expire if the patient abandons the flow).

## Doctor leave conflict handling

When an admin calls `POST /admin/doctors/:id/leaves` for a date that already has confirmed
bookings, the handler doesn't just record the leave and stop. In the same request it:

1. Inserts the leave row (guarded by `UNIQUE(doctor_id, leave_date)` so it can't be double-recorded).
2. Queries every `confirmed` appointment for that doctor on that date.
3. For each one: marks it `cancelled` with `cancel_reason = 'Doctor unavailable (leave)'`, deletes
   both parties' Google Calendar events, and sends a cancellation email to the patient and the
   doctor.

Each of these per-appointment side effects (calendar delete, two emails) is wrapped so a failure in
one doesn't stop the loop from processing the rest — a stuck calendar API call for one patient
should never leave the next five patients silently un-notified. The response returns the list of
affected appointments so the admin UI can show exactly who was impacted, rather than a bare "leave
added" with no visibility into the blast radius.

## Notification failure handling

Every outbound email — booking confirmation, reminder, cancellation, leave conflict — goes through
one `sendEmail()` function that writes a row to `notifications_log` with `status='pending'`
*before* attempting to send, then updates it to `sent` or `failed`. This outbox pattern means a
notification's existence and its delivery status are never lost, even if the process crashes
mid-send or the SMTP host times out (the transporter has explicit connect/greeting/socket timeouts
so a slow provider fails fast instead of hanging the request). A background job runs every two
minutes, pulls up to 50 `failed` rows with retries remaining (capped at 5 attempts each), and
resends them in place — updating the same log row rather than creating duplicates. Crucially, a
failed send never throws back up into the booking/cancellation/leave flow: `sendEmail()` catches
its own errors and returns `{ ok: false }`, so a clinic-wide SMTP outage degrades to "emails are
delayed" rather than "the booking API is down." The same never-block philosophy applies to the
LLM calls: both prompts have a hand-written fallback summary and a `_llm_status` flag, so an
Anthropic outage degrades pre/post-visit summaries to raw input rather than blocking a visit.
