const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const { db } = require('../config/db');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    // Fail fast rather than hanging if the SMTP host is unreachable/misconfigured —
    // the outbox/retry pattern depends on failures surfacing quickly.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  return transporter;
}

const insertLog = db.prepare(`
  INSERT INTO notifications_log (id, type, recipient, subject, body, status, related_appointment_id)
  VALUES (@id, @type, @recipient, @subject, @body, @status, @related_appointment_id)
`);
const markSent = db.prepare(`UPDATE notifications_log SET status='sent', sent_at=datetime('now') WHERE id=?`);
const markFailed = db.prepare(`UPDATE notifications_log SET status='failed', error=?, retry_count=retry_count+1 WHERE id=?`);

// Every email is logged BEFORE sending is attempted (an outbox pattern), so that
// if the process crashes mid-send or the SMTP server is down, the background
// retry job can find and resend it later. This is how notification delivery
// stays reliable despite transient failures.
async function sendEmail({ type, to, subject, html, relatedAppointmentId = null }) {
  const id = uuid();
  insertLog.run({
    id,
    type,
    recipient: to,
    subject,
    body: html,
    status: 'pending',
    related_appointment_id: relatedAppointmentId,
  });

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    });
    markSent.run(id);
    return { ok: true };
  } catch (err) {
    markFailed.run(err.message, id);
    // Do not throw: a failed notification must never break the calling flow
    // (booking, cancellation, etc). The retry job will pick it up.
    return { ok: false, error: err.message };
  }
}

// --- Templated helpers -----------------------------------------------------

function bookingConfirmationEmail({ recipientName, doctorName, patientName, slotStart, role }) {
  const when = new Date(slotStart).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return {
    subject: 'Appointment Confirmed',
    html: `<p>Hi ${recipientName},</p>
      <p>${role === 'doctor'
        ? `A new appointment with <strong>${patientName}</strong> has been confirmed for <strong>${when}</strong>.`
        : `Your appointment with <strong>Dr. ${doctorName}</strong> has been confirmed for <strong>${when}</strong>.`}</p>
      <p>You'll receive a reminder before the visit. A calendar invite has also been sent.</p>
      <p>— Clinic Care</p>`,
  };
}

function cancellationEmail({ recipientName, doctorName, patientName, slotStart, role, reason }) {
  const when = new Date(slotStart).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return {
    subject: 'Appointment Cancelled',
    html: `<p>Hi ${recipientName},</p>
      <p>${role === 'doctor'
        ? `The appointment with <strong>${patientName}</strong> on <strong>${when}</strong> has been cancelled.`
        : `Your appointment with <strong>Dr. ${doctorName}</strong> on <strong>${when}</strong> has been cancelled.`}</p>
      ${reason ? `<p>Reason: ${reason}</p>` : ''}
      <p>Please book a new slot at your convenience.</p>
      <p>— Clinic Care</p>`,
  };
}

function reminderEmail({ recipientName, doctorName, slotStart }) {
  const when = new Date(slotStart).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return {
    subject: 'Upcoming Appointment Reminder',
    html: `<p>Hi ${recipientName},</p>
      <p>This is a reminder of your upcoming appointment with <strong>Dr. ${doctorName}</strong> on <strong>${when}</strong>.</p>
      <p>— Clinic Care</p>`,
  };
}

function medicationReminderEmail({ recipientName, medication, dosage }) {
  return {
    subject: `Medication Reminder: ${medication}`,
    html: `<p>Hi ${recipientName},</p>
      <p>This is a reminder to take your medication: <strong>${medication}${dosage ? ' (' + dosage + ')' : ''}</strong>.</p>
      <p>— Clinic Care</p>`,
  };
}

module.exports = {
  sendEmail,
  bookingConfirmationEmail,
  cancellationEmail,
  reminderEmail,
  medicationReminderEmail,
};
