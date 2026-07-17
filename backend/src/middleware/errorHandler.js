// Centralized error handler. Catches any error passed via next(err).
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'Internal Server Error',
  });
};

module.exports = errorHandler;
