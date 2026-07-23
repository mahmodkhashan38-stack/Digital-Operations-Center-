const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const userRoutes = require('./routes/user.routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Core middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);

// 404 handler for unknown routes
app.use(notFound);

// Centralized error handler (must be last)
app.use(errorHandler);

module.exports = app;
