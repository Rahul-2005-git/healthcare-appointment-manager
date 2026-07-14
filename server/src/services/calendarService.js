const { google } = require('googleapis');
const { db } = require('../config/db');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state,
  });
}

const upsertTokens = db.prepare(`
  INSERT INTO google_tokens (user_id, access_token, refresh_token, scope, token_type, expiry_date, updated_at)
  VALUES (@user_id, @access_token, @refresh_token, @scope, @token_type, @expiry_date, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET
    access_token = excluded.access_token,
    refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
    scope = excluded.scope,
    token_type = excluded.token_type,
    expiry_date = excluded.expiry_date,
    updated_at = datetime('now')
`);
const getTokensStmt = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?');

async function exchangeCodeForTokens(userId, code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  upsertTokens.run({
    user_id: userId,
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    scope: tokens.scope || null,
    token_type: tokens.token_type || null,
    expiry_date: tokens.expiry_date || null,
  });
  return tokens;
}

function isConnected(userId) {
  return !!getTokensStmt.get(userId);
}

function getClientForUser(userId) {
  const row = getTokensStmt.get(userId);
  if (!row) return null;
  const client = getOAuthClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    scope: row.scope,
    token_type: row.token_type,
    expiry_date: row.expiry_date,
  });
  client.on('tokens', (tokens) => {
    upsertTokens.run({
      user_id: userId,
      access_token: tokens.access_token || row.access_token,
      refresh_token: tokens.refresh_token || row.refresh_token,
      scope: tokens.scope || row.scope,
      token_type: tokens.token_type || row.token_type,
      expiry_date: tokens.expiry_date || row.expiry_date,
    });
  });
  return client;
}

// Creates a calendar event for a given user (patient or doctor), IF they have
// connected Google Calendar. If not connected, or the API call fails, this
// returns { ok: false } and the caller proceeds without blocking the booking —
// calendar sync is a best-effort convenience, not a hard dependency.
async function createEvent(userId, { summary, description, startISO, endISO, attendeesEmails = [] }) {
  try {
    const client = getClientForUser(userId);
    if (!client) return { ok: false, reason: 'not_connected' };

    const calendar = google.calendar({ version: 'v3', auth: client });
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO },
        end: { dateTime: endISO },
        attendees: attendeesEmails.map((email) => ({ email })),
      },
    });
    return { ok: true, eventId: res.data.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function updateEvent(userId, eventId, { startISO, endISO, summary, description }) {
  try {
    if (!eventId) return { ok: false, reason: 'no_event_id' };
    const client = getClientForUser(userId);
    if (!client) return { ok: false, reason: 'not_connected' };

    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        ...(summary && { summary }),
        ...(description && { description }),
        ...(startISO && { start: { dateTime: startISO } }),
        ...(endISO && { end: { dateTime: endISO } }),
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function deleteEvent(userId, eventId) {
  try {
    if (!eventId) return { ok: true }; // nothing to delete
    const client = getClientForUser(userId);
    if (!client) return { ok: false, reason: 'not_connected' };

    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId: 'primary', eventId }).catch((err) => {
      // 410/404 = already gone; treat as success
      if (!(err.code === 410 || err.code === 404)) throw err;
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  isConnected,
  createEvent,
  updateEvent,
  deleteEvent,
};
