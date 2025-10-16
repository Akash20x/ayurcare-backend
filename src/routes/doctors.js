const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createDoctor, listDoctors, getDoctorById, createTimeSlot, getAvailableSlots, lockTimeSlot, getSlotById } = require('../controllers/doctorController');
const adminAuth = require('../middleware/adminAuth');

// Public: Get all doctors based on filters
router.get('/', listDoctors);

// Public: Get a single doctor by id
router.get('/:id', getDoctorById);

// Protected: Create a doctor
router.post('/', auth, adminAuth, createDoctor);

// Protected: Create a time slot for a doctor
router.post('/:doctorId/slots', auth, adminAuth, createTimeSlot);

// Public: Get available slots for a doctor for a given date
router.get('/:doctorId/slots', getAvailableSlots);

// Protected: Lock a specific slot for 5 minutes
router.post('/:doctorId/slots/:slotId/lock', auth, lockTimeSlot);

// Public: Get a specific slot by ID
router.get('/:doctorId/slots/:slotId', getSlotById);

module.exports = router;


