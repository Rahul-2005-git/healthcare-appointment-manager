const { verifyToken } = require('../utils/jwt');
const ApiError = require('../utils/apiError');

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new ApiError(401, 'Missing or malformed Authorization header'));
  }

  try {
    const payload = verifyToken(token);
    req.user = payload; // { id, role, email, name }
    next();
  } catch (err) {
    next(new ApiError(401, 'Invalid or expired token'));
  }
}

// Usage: authorize('doctor', 'admin')
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));
    if (!allowedRoles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
}

module.exports = { authenticate, authorize };
