// Handles requests to routes that do not exist.
const notFound = (req, res, next) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.originalUrl}`,
  });
};

module.exports = notFound;
