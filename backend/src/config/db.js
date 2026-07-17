const mongoose = require('mongoose');

// Establishes a connection to MongoDB using the URI from environment variables.
// Exits the process with a clear error if the URI is missing or the connection fails.
const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('MongoDB connection failed: MONGODB_URI is not defined in the environment.');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully.');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
