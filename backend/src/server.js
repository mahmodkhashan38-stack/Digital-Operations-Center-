require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');

const PORT = process.env.PORT || 5000;

// JWT_SECRET is required to sign and verify authentication tokens.
// Validated the same way MONGODB_URI is in config/db.js: fail fast with a
// clear message instead of letting login fail mysteriously later.
if (!process.env.JWT_SECRET) {
  console.error('Server startup failed: JWT_SECRET is not defined in the environment.');
  process.exit(1);
}

// Connect to MongoDB before accepting HTTP traffic.
const startServer = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();
