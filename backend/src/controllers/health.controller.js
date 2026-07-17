// Returns the current health status of the API.
const getHealth = (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Digital Operations Center API is running',
  });
};

module.exports = { getHealth };
