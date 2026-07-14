const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db } = require('../config/db');
const { signToken } = require('../utils/jwt');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, role, phone)
  VALUES (@id, @name, @email, @password_hash, @role, @phone)
`);

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone };
}

// Patients self-register. Doctor and admin accounts are created by an admin
// (see adminController) to keep clinic staff onboarding controlled.
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) {
    throw new ApiError(400, 'name, email and password are required');
  }
  if (findByEmail.get(email)) {
    throw new ApiError(409, 'An account with this email already exists');
  }

  const id = uuid();
  const password_hash = await bcrypt.hash(password, 10);
  insertUser.run({ id, name, email, password_hash, role: 'patient', phone: phone || null });

  const user = { id, name, email, role: 'patient' };
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser({ ...user, phone }) });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'email and password are required');

  const user = findByEmail.get(email);
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw new ApiError(401, 'Invalid email or password');

  const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
  res.json({ token, user: publicUser(user) });
});

const me = asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw new ApiError(404, 'User not found');
  res.json({ user: publicUser(user) });
});

module.exports = { register, login, me };
