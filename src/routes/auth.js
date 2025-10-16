const express = require('express');
const router = express.Router();
const { register, login, generateOTPForUser, verifyOTP, getProfile, logout, refresh } = require('../controllers/authController');
const auth = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.post('/generate-otp', generateOTPForUser);
router.post('/verify-otp', verifyOTP);
router.post('/logout', logout);
router.post('/refresh', refresh);
router.get('/me', auth, getProfile);

module.exports = router;

