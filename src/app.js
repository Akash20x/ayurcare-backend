const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { PrismaClient } = require('@prisma/client');
const { getDatabaseNow } = require('./utils/time');
const cron = require('node-cron'); // ✅ use require here

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(helmet());

app.use(cors({
  origin: 'https://ayurcare-web.vercel.app', 
  credentials: true
}));


app.use(morgan('combined'));
app.use(express.json());
app.use(cookieParser()); 
app.use(express.urlencoded({ extended: true }));

// Routes 
app.use('/api/auth', require('./routes/auth'));
app.use('/api/doctors', require('./routes/doctors'));
app.use('/api/appointments', require('./routes/appointments'));

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

// Background job: release expired locks every 5 minutes
if (process.env.ENABLE_LOCK_CLEANUP === 'true') {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = await getDatabaseNow(prisma);

      await prisma.timeSlot.updateMany({
        where: {
          status: "LOCKED",
          lockExpires: { lt: now }
        },
        data: {
          status: "AVAILABLE",
          lockedBy: null,
          lockedAt: null,
          lockExpires: null
        }
      });

      console.log(`[CRON] Released expired locks at ${now.toISOString()}`);
    } catch (e) {
      console.error('[CRON] Lock cleanup job error:', e);
    }
  });
}


module.exports = app;
