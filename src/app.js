const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { getDatabaseNow } = require('./utils/time');
const { releaseExpiredLocks } = require('./utils/timeSlotHelpers');
const cron = require('node-cron'); 
const prisma = require('./lib/prisma');
const cleanResponse = require('./middleware/cleanResponse');

const app = express();

// Middleware
app.use(helmet());

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN, 
  credentials: true
}));

app.use(morgan('combined'));
app.use(express.json());
app.use(cookieParser()); 
app.use(express.urlencoded({ extended: true }));
app.use(cleanResponse);

// Routes 
app.use('/api/auth', require('./routes/auth'));
app.use('/api/doctors', require('./routes/doctors'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/booking-drafts', require('./routes/bookingDrafts'));
app.use('/api/admin', require('./routes/admin'));

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Ayurcare API is running!' });
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Releases expired slot locks every hour
if (process.env.ENABLE_LOCK_CLEANUP === 'true') {
  cron.schedule('0 * * * *', async () => {
    try {
      const now = await getDatabaseNow(prisma);
      const result = await releaseExpiredLocks(prisma, now);

      if (result.count > 0) {
        console.log(`[CRON] Released ${result.count} expired lock(s) at ${now.toISOString()}`);
      }
    } catch (e) {
      console.error('[CRON] Lock cleanup job error:', e);
    }
  }, { timezone: 'Asia/Kolkata' });
}


module.exports = app;
