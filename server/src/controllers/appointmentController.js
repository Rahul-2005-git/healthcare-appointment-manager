const { v4: uuid } = require('uuid');
const { db } = require('../config/db');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { generatePreVisitSummary, generatePostVisitSummary } = require('../services/llmService');
const { sendEmail, bookingConfirmationEmail, cancellationEmail } = require('../services/emailService');
const { createEvent, updateEvent, deleteEvent } = require('../services/calendarService');

const HOLD_TTL_MIN = Number(process.env.SLOT_HOLD_TTL_MINUTES || 5);

const getDoctorStmt = db.prepare('SELECT d.*, u.name as doctor_name, u.email as doctor_email, u.id as doctor_user_id FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?');
const leaveStmt = db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND leave_date = date(?)');
const deleteExpiredHolds = db.prepare(`DELETE FROM slot_holds WHERE expires_at <= datetime('now')`);
const insertHold = db.prepare(`
  INSERT INTO slot_holds (id, doctor_id, slot_start, slot_end, held_by, expires_at)
  VALUES (@id, @doctor_id, @slot_start, @slot_end, @held_by, datetime('now', @ttl))
`);
const getHoldStmt = db.prepare(`SELECT * FROM slot_holds WHERE id = ? AND expires_at > datetime('now')`);
const deleteHoldStmt = db.prepare('DELETE FROM slot_holds WHERE id = ?');
const insertAppointment = db.prepare(`
  INSERT INTO appointments (id, patient_id, doctor_id, slot_start, slot_end, status, symptom_text)
  VALUES (@id, @patient_id, @doctor_id, @slot_start, @slot_end, 'confirmed', @symptom_text)
`);
const updatePreVisit = db.prepare(`
  UPDATE appointments SET pre_visit_summary_json = ?, pre_visit_llm_status = ?, updated_at = datetime('now') WHERE id = ?
`);
const updateCalendarIds = db.prepare(`
  UPDATE appointments SET patient_calendar_event_id = ?, doctor_calendar_event_id = ?, updated_at = datetime('now') WHERE id = ?
`);
const getAppointmentFull = db.prepare(`
  SELECT a.*, p.name as patient_name, p.email as patient_email,
         du.name as doctor_name, du.email as doctor_email, du.id as doctor_user_id, d.specialisation
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  WHERE a.id = ?
`);
const cancelStmt = db.prepare(`UPDATE appointments SET status='cancelled', cancel_reason=?, updated_at=datetime('now') WHERE id=?`);
const listForPatient = db.prepare(`
  SELECT a.*, du.name AS doctor_name, d.specialisation
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  WHERE a.patient_id = ?
  ORDER BY a.slot_start DESC
`);
const listForDoctorUser = db.prepare(`
  SELECT a.*, p.name as patient_name, p.email as patient_email
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users p ON p.id = a.patient_id
  WHERE d.user_id = ?
  ORDER BY a.slot_start DESC
`);

// Step 1 of booking: place a short-lived hold on a slot so that while the
// patient is filling out the symptom form, nobody else can grab it. Holds are
// enforced with a UNIQUE(doctor_id, slot_start) index in slot_holds, so two
// simultaneous hold requests for the same slot: one succeeds, one gets a
// clean 409 — no double-booking window even under a race.
const holdSlot = asyncHandler(async (req, res) => {
  const { doctorId, slotStart, slotEnd } = req.body;
  if (!doctorId || !slotStart || !slotEnd) throw new ApiError(400, 'doctorId, slotStart and slotEnd are required');

  const doctor = getDoctorStmt.get(doctorId);
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  if (leaveStmt.get(doctorId, slotStart)) throw new ApiError(409, 'Doctor is on leave for this date');
  if (new Date(slotStart).getTime() <= Date.now()) throw new ApiError(400, 'Cannot book a slot in the past');

  const runHold = db.transaction(() => {
    deleteExpiredHolds.run();

    const alreadyConfirmed = db
      .prepare(`SELECT 1 FROM appointments WHERE doctor_id = ? AND slot_start = ? AND status = 'confirmed'`)
      .get(doctorId, slotStart);
    if (alreadyConfirmed) throw new ApiError(409, 'This slot is already booked');

    const id = uuid();
    try {
      insertHold.run({
        id,
        doctor_id: doctorId,
        slot_start: slotStart,
        slot_end: slotEnd,
        held_by: req.user.id,
        ttl: `+${HOLD_TTL_MIN} minutes`,
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'This slot is currently being booked by someone else. Please pick another slot.');
      }
      throw err;
    }
    return id;
  });

  const holdId = runHold();
  res.status(201).json({ holdId, expiresInMinutes: HOLD_TTL_MIN });
});

// Step 2 of booking: patient submits symptoms and confirms. The appointment
// row is inserted inside a transaction guarded by the partial unique index on
// (doctor_id, slot_start) for confirmed rows — this is the final, authoritative
// double-booking guard, independent of the hold mechanism above.
const confirmBooking = asyncHandler(async (req, res) => {
  const { holdId, symptomText } = req.body;
  if (!holdId) throw new ApiError(400, 'holdId is required');

  const hold = getHoldStmt.get(holdId);
  if (!hold) throw new ApiError(410, 'Your slot hold has expired. Please select a slot again.');
  if (hold.held_by !== req.user.id) throw new ApiError(403, 'This hold does not belong to you');

  const appointmentId = uuid();
  const runConfirm = db.transaction(() => {
    try {
      insertAppointment.run({
        id: appointmentId,
        patient_id: req.user.id,
        doctor_id: hold.doctor_id,
        slot_start: hold.slot_start,
        slot_end: hold.slot_end,
        symptom_text: symptomText || null,
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'This slot was just booked by someone else. Please pick another slot.');
      }
      throw err;
    }
    deleteHoldStmt.run(holdId);
  });
  runConfirm();

  const appt = getAppointmentFull.get(appointmentId);

  // --- Everything below is best-effort and must never undo the booking ---

  // LLM pre-visit summary
  if (symptomText) {
    const result = await generatePreVisitSummary(symptomText);
    updatePreVisit.run(JSON.stringify(result.data), result.status, appointmentId);
  } else {
    updatePreVisit.run(null, 'skipped', appointmentId);
  }

  // Emails
  const patientTpl = bookingConfirmationEmail({
    recipientName: appt.patient_name, doctorName: appt.doctor_name, patientName: appt.patient_name,
    slotStart: appt.slot_start, role: 'patient',
  });
  const doctorTpl = bookingConfirmationEmail({
    recipientName: appt.doctor_name, doctorName: appt.doctor_name, patientName: appt.patient_name,
    slotStart: appt.slot_start, role: 'doctor',
  });
  await sendEmail({ type: 'booking_confirmation', to: appt.patient_email, subject: patientTpl.subject, html: patientTpl.html, relatedAppointmentId: appointmentId });
  await sendEmail({ type: 'booking_confirmation', to: appt.doctor_email, subject: doctorTpl.subject, html: doctorTpl.html, relatedAppointmentId: appointmentId });

  // Calendar events (best effort — only created if each party connected Google Calendar)
  const patientEvent = await createEvent(appt.patient_id, {
    summary: `Appointment with Dr. ${appt.doctor_name}`,
    description: `Specialisation: ${appt.specialisation}`,
    startISO: appt.slot_start, endISO: appt.slot_end,
  });
  const doctorEvent = await createEvent(appt.doctor_user_id, {
    summary: `Appointment with ${appt.patient_name}`,
    description: `Patient-reported symptoms: ${symptomText || 'Not provided'}`,
    startISO: appt.slot_start, endISO: appt.slot_end,
  });
  updateCalendarIds.run(
    patientEvent.ok ? patientEvent.eventId : null,
    doctorEvent.ok ? doctorEvent.eventId : null,
    appointmentId
  );

  res.status(201).json({ appointment: getAppointmentFull.get(appointmentId) });
});

const cancelAppointment = asyncHandler(async (req, res) => {
  const appt = getAppointmentFull.get(req.params.id);
  if (!appt) throw new ApiError(404, 'Appointment not found');

  const isOwner = appt.patient_id === req.user.id || appt.doctor_user_id === req.user.id;
  if (!isOwner && req.user.role !== 'admin') throw new ApiError(403, 'You cannot cancel this appointment');
  if (appt.status !== 'confirmed') throw new ApiError(400, `Appointment is already ${appt.status}`);

  cancelStmt.run(req.body.reason || 'Cancelled by user', req.params.id);

  await deleteEvent(appt.patient_id, appt.patient_calendar_event_id).catch(() => {});
  await deleteEvent(appt.doctor_user_id, appt.doctor_calendar_event_id).catch(() => {});

  const patientTpl = cancellationEmail({ recipientName: appt.patient_name, doctorName: appt.doctor_name, patientName: appt.patient_name, slotStart: appt.slot_start, role: 'patient', reason: req.body.reason });
  const doctorTpl = cancellationEmail({ recipientName: appt.doctor_name, doctorName: appt.doctor_name, patientName: appt.patient_name, slotStart: appt.slot_start, role: 'doctor', reason: req.body.reason });
  await sendEmail({ type: 'cancellation', to: appt.patient_email, subject: patientTpl.subject, html: patientTpl.html, relatedAppointmentId: appt.id });
  await sendEmail({ type: 'cancellation', to: appt.doctor_email, subject: doctorTpl.subject, html: doctorTpl.html, relatedAppointmentId: appt.id });

  res.json({ appointment: getAppointmentFull.get(req.params.id) });
});

const listMine = asyncHandler(async (req, res) => {
  res.json({ appointments: listForPatient.all(req.user.id) });
});

const listForDoctor = asyncHandler(async (req, res) => {
  res.json({ appointments: listForDoctorUser.all(req.user.id) });
});

const insertReminder = db.prepare(`
  INSERT INTO medication_reminders (id, appointment_id, patient_id, medication, dosage, times_per_day, duration_days, next_send_at, sends_remaining)
  VALUES (@id, @appointment_id, @patient_id, @medication, @dosage, @times_per_day, @duration_days, datetime('now', '+1 hour'), @sends_remaining)
`);
const updatePostVisit = db.prepare(`
  UPDATE appointments SET post_visit_notes=?, prescription_json=?, post_visit_summary_json=?, post_visit_llm_status=?, status='completed', updated_at=datetime('now')
  WHERE id=?
`);

// Doctor submits clinical notes + prescription after the visit. Generates a
// patient-friendly summary via LLM (never blocks on failure) and schedules
// medication reminders based on prescription frequency.
const submitPostVisit = asyncHandler(async (req, res) => {
  const appt = getAppointmentFull.get(req.params.id);
  if (!appt) throw new ApiError(404, 'Appointment not found');
  if (appt.doctor_user_id !== req.user.id) throw new ApiError(403, 'Not your appointment');

  const { notes, prescription } = req.body; // prescription: [{ medication, dosage, frequencyPerDay, durationDays }]
  if (!notes) throw new ApiError(400, 'notes is required');

  const result = await generatePostVisitSummary(notes, prescription || []);

  updatePostVisit.run(
    notes,
    JSON.stringify(prescription || []),
    JSON.stringify(result.data),
    result.status,
    req.params.id
  );

  if (Array.isArray(prescription)) {
    for (const p of prescription) {
      const timesPerDay = Number(p.frequencyPerDay) || 1;
      const durationDays = Number(p.durationDays) || 1;
      insertReminder.run({
        id: uuid(),
        appointment_id: req.params.id,
        patient_id: appt.patient_id,
        medication: p.medication,
        dosage: p.dosage || null,
        times_per_day: timesPerDay,
        duration_days: durationDays,
        sends_remaining: timesPerDay * durationDays,
      });
    }
  }

  res.json({ appointment: getAppointmentFull.get(req.params.id) });
});

module.exports = { holdSlot, confirmBooking, cancelAppointment, listMine, listForDoctor, submitPostVisit };
