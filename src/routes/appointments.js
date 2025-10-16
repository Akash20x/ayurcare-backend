const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { confirmBooking, listAppointments, getAppointmentById, updateAppointmentStatus, rescheduleAppointment, cancelAppointment, confirmReschedule } = require('../controllers/appointmentController');
const adminAuth = require('../middleware/adminAuth');

// Protected: confirm booking
router.post('/confirm', auth, confirmBooking);

// Protected: list appointments for current user
router.get('/', auth, listAppointments);

// Protected: get appointment details
router.get('/:id', auth, getAppointmentById);

// Protected: update appointment status
router.put('/:id/status', auth, adminAuth, updateAppointmentStatus);

// Protected: reschedule appointment (>24h only)
router.put('/:id/reschedule', auth, rescheduleAppointment);

// Protected: confirm reschedule (finalize new slot and release old)
router.post('/reschedule/confirm', auth, confirmReschedule);

// Protected: cancel appointment (>24h only)
router.put('/:id/cancel', auth, cancelAppointment);

module.exports = router;


