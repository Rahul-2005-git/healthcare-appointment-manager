require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db, initSchema } = require('../config/db');

initSchema();

async function seed() {
  const adminEmail = 'admin@clinic.example.com';
  const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get(adminEmail);
  if (existing) {
    console.log('Seed data already present — skipping.');
    return;
  }

  const adminId = uuid();
  const adminHash = await bcrypt.hash('Admin@123', 10);
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`)
    .run(adminId, 'Clinic Admin', adminEmail, adminHash);

  const doctorUserId = uuid();
  const doctorHash = await bcrypt.hash('Doctor@123', 10);
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'doctor')`)
    .run(doctorUserId, 'Dr. Asha Rao', 'asha.rao@clinic.example.com', doctorHash);

  db.prepare(`
    INSERT INTO doctors (id, user_id, specialisation, working_hours_start, working_hours_end, slot_duration_mins, working_days)
    VALUES (?, ?, 'General Physician', '09:00', '17:00', 30, '1,2,3,4,5')
  `).run(uuid(), doctorUserId);

  console.log('Seed complete.');
  console.log('Admin login   : admin@clinic.example.com / Admin@123');
  console.log('Doctor login  : asha.rao@clinic.example.com / Doctor@123');
  console.log('Register a patient account via POST /api/auth/register');
}

seed().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
