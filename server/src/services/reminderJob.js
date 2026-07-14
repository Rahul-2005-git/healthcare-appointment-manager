const cron = require('node-cron');
const { db } = require('../config/db');
const { sendEmail, medicationReminderEmail, reminderEmail } = require('./emailService');

const dueReminders = db.prepare(`
  SELECT r.*, u.name as patient_name, u.email as patient_email
  FROM medication_reminders r JOIN users u ON u.id = r.patient_id
  WHERE r.status = 'active' AND r.next_send_at <= datetime('now') AND r.sends_remaining > 0
`);
const bumpReminder = db.prepare(`
  UPDATE medication_reminders
  SET sends_remaining = sends_remaining - 1,
      next_send_at = datetime('now', '+' || (24 / times_per_day) || ' hours'),
      status = CASE WHEN sends_remaining - 1 <= 0 THEN 'completed' ELSE 'active' END
  WHERE id = ?
`);

const upcomingAppointments = db.prepare(`
  SELECT a.*, p.name as patient_name, p.email as patient_email, du.name as doctor_name
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  WHERE a.status = 'confirmed'
    AND a.slot_start BETWEEN datetime('now', '+23 hours') AND datetime('now', '+25 hours')
`);

const failedNotifications = db.prepare(`
  SELECT * FROM notifications_log WHERE status = 'failed' AND retry_count < max_retries LIMIT 50
`);
const markSent = db.prepare(`UPDATE notifications_log SET status='sent', sent_at=datetime('now') WHERE id=?`);
const markFailedAgain = db.prepare(`UPDATE notifications_log SET error=?, retry_count=retry_count+1 WHERE id=?`);

async function runMedicationReminders() {
  for (const r of dueReminders.all()) {
    const tpl = medicationReminderEmail({ recipientName: r.patient_name, medication: r.medication, dosage: r.dosage });
    await sendEmail({ type: 'medication_reminder', to: r.patient_email, subject: tpl.subject, html: tpl.html, relatedAppointmentId: r.appointment_id });
    bumpReminder.run(r.id);
  }
}

async function runAppointmentReminders() {
  for (const a of upcomingAppointments.all()) {
    const tpl = reminderEmail({ recipientName: a.patient_name, doctorName: a.doctor_name, slotStart: a.slot_start });
    await sendEmail({ type: 'reminder', to: a.patient_email, subject: tpl.subject, html: tpl.html, relatedAppointmentId: a.id });
  }
}

// Retries emails that previously failed (e.g. SMTP timeout). Uses the
// nodemailer transporter directly rather than sendEmail() to avoid creating a
// duplicate log row — this updates the existing failed row in place.
async function retryFailedNotifications() {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });

  for (const n of failedNotifications.all()) {
    try {
      await transporter.sendMail({ from: process.env.EMAIL_FROM, to: n.recipient, subject: n.subject, html: n.body });
      markSent.run(n.id);
    } catch (err) {
      markFailedAgain.run(err.message, n.id);
    }
  }
}

function startBackgroundJobs() {
  cron.schedule(process.env.REMINDER_JOB_CRON || '*/5 * * * *', () => {
    runMedicationReminders().catch((e) => console.error('[medication reminders]', e.message));
    runAppointmentReminders().catch((e) => console.error('[appointment reminders]', e.message));
  });

  cron.schedule(process.env.EMAIL_RETRY_JOB_CRON || '*/2 * * * *', () => {
    retryFailedNotifications().catch((e) => console.error('[email retry]', e.message));
  });

  console.log('Background jobs scheduled: medication/appointment reminders + email retry.');
}

module.exports = { startBackgroundJobs, runMedicationReminders, runAppointmentReminders, retryFailedNotifications };
