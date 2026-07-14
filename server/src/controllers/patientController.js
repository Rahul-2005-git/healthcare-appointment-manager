const { db } = require('../config/db');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { generateSlotsForDate, doctorWorksOnDate } = require('../utils/slotUtils');

const searchStmt = db.prepare(`
  SELECT d.id, d.specialisation, d.working_hours_start, d.working_hours_end, d.slot_duration_mins, d.working_days,
         u.name, u.email
  FROM doctors d JOIN users u ON u.id = d.user_id
  WHERE (@specialisation IS NULL OR d.specialisation LIKE '%' || @specialisation || '%')
  ORDER BY u.name
`);

const searchDoctors = asyncHandler(async (req, res) => {
  const specialisation = req.query.specialisation || null;
  res.json({ doctors: searchStmt.all({ specialisation }) });
});

const getDoctorStmt = db.prepare('SELECT * FROM doctors WHERE id = ?');
const leaveStmt = db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?');
const bookedStmt = db.prepare(`
  SELECT slot_start FROM appointments WHERE doctor_id = ? AND status = 'confirmed' AND date(slot_start) = ?
`);
const heldStmt = db.prepare(`
  SELECT slot_start FROM slot_holds WHERE doctor_id = ? AND date(slot_start) = ? AND expires_at > datetime('now')
`);

// Returns every bookable slot for a doctor on a given date: generated from
// working hours, minus leave days, minus already-booked slots, minus slots
// someone else currently has a live (unexpired) hold on.
const getAvailableSlots = asyncHandler(async (req, res) => {
  const doctor = getDoctorStmt.get(req.params.id);
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const date = req.query.date; // 'YYYY-MM-DD'
  if (!date) throw new ApiError(400, 'date query param (YYYY-MM-DD) is required');

  if (leaveStmt.get(doctor.id, date)) {
    return res.json({ date, slots: [], reason: 'doctor_on_leave' });
  }
  if (!doctorWorksOnDate(doctor, date)) {
    return res.json({ date, slots: [], reason: 'not_a_working_day' });
  }

  const all = generateSlotsForDate(doctor, date);
  const booked = new Set(bookedStmt.all(doctor.id, date).map((r) => r.slot_start));
  const held = new Set(heldStmt.all(doctor.id, date).map((r) => r.slot_start));

  const now = Date.now();
  const available = all.filter(
    (s) => !booked.has(s.start) && !held.has(s.start) && new Date(s.start).getTime() > now
  );

  res.json({ date, slots: available });
});

module.exports = { searchDoctors, getAvailableSlots };
