const express = require('express');
const router = express.Router();
const { register, login, loginWithGoogle, generateOTPForUser, verifyOTP, getSession, logout, refresh } = require('../controllers/authController');
const auth = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.post('/google', loginWithGoogle);
router.post('/generate-otp', auth, generateOTPForUser);
router.post('/verify-otp', auth, verifyOTP);
router.post('/logout', logout);
router.post('/refresh', refresh);
router.get('/session', getSession);

module.exports = router;

