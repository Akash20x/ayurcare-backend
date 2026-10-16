const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const {
  getStats,
  getTodayAppointments,
  getPatients,
  getPatientAppointments,
  getUpcomingSlots,
  getDoctorUpcomingAppointments,
} = require('../controllers/adminController');

router.use(auth, adminAuth);

router.get('/stats', getStats);
router.get('/appointments/today', getTodayAppointments);
router.get('/patients', getPatients);
router.get('/patients/:patientId/appointments', getPatientAppointments);
router.get('/slots/upcoming', getUpcomingSlots);
router.get('/doctors/:doctorId/appointments/upcoming', getDoctorUpcomingAppointments);
module.exports = router;
