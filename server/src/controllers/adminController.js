const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db } = require('../config/db');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { sendEmail, cancellationEmail } = require('../services/emailService');
const { deleteEvent } = require('../services/calendarService');

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, role, phone) VALUES (@id, @name, @email, @password_hash, 'doctor', @phone)
`);
const insertDoctor = db.prepare(`
  INSERT INTO doctors (id, user_id, specialisation, working_hours_start, working_hours_end, slot_duration_mins, working_days)
  VALUES (@id, @user_id, @specialisation, @working_hours_start, @working_hours_end, @slot_duration_mins, @working_days)
`);
const listDoctorsStmt = db.prepare(`
  SELECT d.*, u.name, u.email, u.phone FROM doctors d JOIN users u ON u.id = d.user_id ORDER BY u.name
`);
const updateDoctorStmt = db.prepare(`
  UPDATE doctors SET specialisation=@specialisation, working_hours_start=@working_hours_start,
    working_hours_end=@working_hours_end, slot_duration_mins=@slot_duration_mins, working_days=@working_days
  WHERE id=@id
`);
const getDoctorStmt = db.prepare('SELECT * FROM doctors WHERE id = ?');
const insertLeave = db.prepare(`INSERT INTO doctor_leaves (id, doctor_id, leave_date, reason) VALUES (?, ?, ?, ?)`);
const findAffectedAppointments = db.prepare(`
  SELECT a.*, p.name as patient_name, p.email as patient_email, du.name as doctor_name, du.email as doctor_email
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  WHERE a.doctor_id = ? AND date(a.slot_start) = ? AND a.status = 'confirmed'
`);
const cancelAppointmentStmt = db.prepare(`
  UPDATE appointments SET status='cancelled', cancel_reason=?, updated_at=datetime('now') WHERE id=?
`);

// Creates a doctor account + profile in one step. Admin sets an initial
// password the doctor can change later (no self-registration for staff).
const createDoctor = asyncHandler(async (req, res) => {
  const { name, email, password, phone, specialisation, workingHoursStart, workingHoursEnd, slotDurationMins, workingDays } = req.body;
  if (!name || !email || !password || !specialisation || !workingHoursStart || !workingHoursEnd) {
    throw new ApiError(400, 'name, email, password, specialisation, workingHoursStart and workingHoursEnd are required');
  }
  if (findByEmail.get(email)) throw new ApiError(409, 'An account with this email already exists');

  const userId = uuid();
  const password_hash = await bcrypt.hash(password, 10);
  insertUser.run({ id: userId, name, email, password_hash, phone: phone || null });

  const doctorId = uuid();
  insertDoctor.run({
    id: doctorId,
    user_id: userId,
    specialisation,
    working_hours_start: workingHoursStart,
    working_hours_end: workingHoursEnd,
    slot_duration_mins: slotDurationMins || 30,
    working_days: workingDays || '1,2,3,4,5',
  });

  res.status(201).json({ doctor: { id: doctorId, userId, name, email, specialisation } });
});

const listDoctors = asyncHandler(async (req, res) => {
  res.json({ doctors: listDoctorsStmt.all() });
});

const updateDoctor = asyncHandler(async (req, res) => {
  const doctor = getDoctorStmt.get(req.params.id);
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const merged = {
    id: doctor.id,
    specialisation: req.body.specialisation ?? doctor.specialisation,
    working_hours_start: req.body.workingHoursStart ?? doctor.working_hours_start,
    working_hours_end: req.body.workingHoursEnd ?? doctor.working_hours_end,
    slot_duration_mins: req.body.slotDurationMins ?? doctor.slot_duration_mins,
    working_days: req.body.workingDays ?? doctor.working_days,
  };
  updateDoctorStmt.run(merged);
  res.json({ doctor: getDoctorStmt.get(doctor.id) });
});

// Marking a doctor on leave for a date that already has confirmed bookings
// must not silently orphan those patients. We: (1) record the leave, (2) find
// every confirmed appointment on that date, (3) cancel each one, (4) remove
// the calendar events, (5) email both patient and doctor. Steps 2-5 run best
// effort per-appointment so one failure doesn't stop the rest being processed.
const addLeave = asyncHandler(async (req, res) => {
  const { date, reason } = req.body;
  if (!date) throw new ApiError(400, 'date (YYYY-MM-DD) is required');

  const doctor = getDoctorStmt.get(req.params.id);
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  try {
    insertLeave.run(uuid(), doctor.id, date, reason || null);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new ApiError(409, 'Leave already recorded for this date');
    }
    throw err;
  }

  const affected = findAffectedAppointments.all(doctor.id, date);
  const results = [];

  for (const appt of affected) {
    cancelAppointmentStmt.run('Doctor unavailable (leave)', appt.id);

    // Best-effort calendar cleanup — does not block the loop on failure.
    await deleteEvent(appt.patient_id, appt.patient_calendar_event_id).catch(() => {});
    await deleteEvent(doctor.user_id, appt.doctor_calendar_event_id).catch(() => {});

    const patientTpl = cancellationEmail({
      recipientName: appt.patient_name,
      doctorName: appt.doctor_name,
      patientName: appt.patient_name,
      slotStart: appt.slot_start,
      role: 'patient',
      reason: 'The doctor is unavailable on this date. Please rebook another slot.',
    });
    const doctorTpl = cancellationEmail({
      recipientName: appt.doctor_name,
      doctorName: appt.doctor_name,
      patientName: appt.patient_name,
      slotStart: appt.slot_start,
      role: 'doctor',
      reason: 'Marked as leave.',
    });

    await sendEmail({
      type: 'leave_conflict',
      to: appt.patient_email,
      subject: patientTpl.subject,
      html: patientTpl.html,
      relatedAppointmentId: appt.id,
    });
    await sendEmail({
      type: 'leave_conflict',
      to: appt.doctor_email,
      subject: doctorTpl.subject,
      html: doctorTpl.html,
      relatedAppointmentId: appt.id,
    });

    results.push({ appointmentId: appt.id, patientEmail: appt.patient_email });
  }

  res.status(201).json({ leaveDate: date, cancelledAppointments: results });
});

module.exports = { createDoctor, listDoctors, updateDoctor, addLeave };
