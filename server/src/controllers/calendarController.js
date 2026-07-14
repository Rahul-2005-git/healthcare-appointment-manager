const { getAuthUrl, exchangeCodeForTokens, isConnected } = require('../services/calendarService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');

// Returns the Google consent URL. The frontend redirects the browser here;
// `state` carries the logged-in user's id so the callback knows whose tokens
// to store (Google's redirect is a fresh, unauthenticated request).
const connect = asyncHandler(async (req, res) => {
  const url = getAuthUrl(req.user.id);
  res.json({ url });
});

const status = asyncHandler(async (req, res) => {
  res.json({ connected: isConnected(req.user.id) });
});

// Public callback (Google redirects the user's browser here directly, with no
// Authorization header) — identity comes from the `state` param instead.
const callback = asyncHandler(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) throw new ApiError(400, 'Missing code or state from Google');

  await exchangeCodeForTokens(state, code);
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  res.redirect(`${clientUrl}/calendar-connected`);
});

module.exports = { connect, status, callback };
