const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createBookingDraft,
  getBookingDraft,
  getBookingConfirmation,
  requestDraftOTP,
  verifyDraftOTP,
  confirmBookingDraft,
} = require('../controllers/bookingDraftController');

router.use(auth);

router.post('/', createBookingDraft);
router.get('/current', getBookingDraft);
router.get('/current/confirmation', getBookingConfirmation);
router.post('/current/otp', requestDraftOTP);
router.post('/current/verify-otp', verifyDraftOTP);
router.post('/current/confirm', confirmBookingDraft);

module.exports = router;
