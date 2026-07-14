require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { initSchema } = require('./config/db');
const ApiError = require('./utils/apiError');
const { startBackgroundJobs } = require('./services/reminderJob');

initSchema();

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/doctors', require('./routes/doctorRoutes'));
app.use('/api/appointments', require('./routes/appointmentRoutes'));
app.use('/api/calendar', require('./routes/calendarRoutes'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler. ApiError carries an explicit statusCode; anything
// else (a bug, an unexpected driver error) is logged and returned as a 500
// without leaking internals to the client.
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Healthcare Appointment Manager API listening on port ${PORT}`);
  startBackgroundJobs();
});
