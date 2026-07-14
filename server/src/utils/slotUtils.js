// All slot times are handled as UTC ISO strings. working_hours_start/end are
// 'HH:MM' local-clinic-time strings; for simplicity the whole system assumes a
// single clinic timezone (configure via CLINIC_UTC_OFFSET_MINUTES if needed).

function isoWeekday(dateStr) {
  // dateStr: 'YYYY-MM-DD' -> 1 (Mon) .. 7 (Sun)
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

// Generates every slot start/end (ISO strings) for a doctor on a given date,
// based on working hours and slot duration. Does not yet filter out booked
// slots, leaves, or holds — the caller subtracts those.
function generateSlotsForDate(doctor, dateStr) {
  const [startH, startM] = doctor.working_hours_start.split(':').map(Number);
  const [endH, endM] = doctor.working_hours_end.split(':').map(Number);
  const duration = doctor.slot_duration_mins;

  const slots = [];
  let cursor = new Date(`${dateStr}T00:00:00Z`);
  cursor.setUTCHours(startH, startM, 0, 0);
  const end = new Date(`${dateStr}T00:00:00Z`);
  end.setUTCHours(endH, endM, 0, 0);

  while (cursor.getTime() + duration * 60000 <= end.getTime()) {
    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor.getTime() + duration * 60000);
    slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
    cursor = slotEnd;
  }
  return slots;
}

function doctorWorksOnDate(doctor, dateStr) {
  const workingDays = String(doctor.working_days).split(',').map(Number);
  return workingDays.includes(isoWeekday(dateStr));
}

module.exports = { generateSlotsForDate, doctorWorksOnDate, isoWeekday };
