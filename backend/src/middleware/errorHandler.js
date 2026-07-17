// Centralized error handler. Catches any error passed via next(err).
// Errors with an explicit 4xx status (e.g. a validation error, or a
// malformed-JSON error from the body parser) keep their real, useful
// message. Anything that resolves to a 5xx is treated as unexpected and
// always returns a generic message, so internal server details (stack
// traces, driver error text, etc.) are never exposed to the client. The
// real error is still logged server-side for debugging.
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    console.error('Unexpected server error:', err);
  }

  res.status(statusCode).json({
    status: 'error',
    message: isServerError ? 'Internal Server Error' : err.message || 'Internal Server Error',
  });
};

module.exports = errorHandler;
