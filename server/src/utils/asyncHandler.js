// Wraps an async route handler so thrown errors / rejected promises reach Express's
// error-handling middleware instead of crashing the process or hanging the request.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
