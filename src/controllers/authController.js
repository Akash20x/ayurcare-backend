const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../lib/prisma');
const {
  validateRegistration,
  validateLogin,
  validateOTP,
  validateEmail,
} = require('../utils/validation');
const {
  OTP_EXPIRY_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  saveBookingOTP,
  getBookingOTP,
  deleteBookingOTP,
  getBookingOTPCooldown,
  saveBookingOTPCooldown,
  saveBookingVerification,
} = require('../utils/otp');
const redis = require('../lib/redisClient');
const { sendOtpEmail } = require('../services/emailService');

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const normalizeEmail = (email) => String(email).trim().toLowerCase();
const ACCESS_TOKEN_COOKIE_NAME = 'accessToken';
const googleOAuthClient = new OAuth2Client();
const accessTokenCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 60 * 1000,
  path: '/',
};
const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { userId: user.id, email: user.email, role: user.role.toLowerCase() },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );

  const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: '30d',
  });

  return { accessToken, refreshToken };
};

const setSessionCookies = (res, tokens) => {
  res.cookie('refreshToken', tokens.refreshToken, refreshTokenCookieOptions);
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, tokens.accessToken, accessTokenCookieOptions);
};

const establishSession = async (res, user, status = 200, message = 'Login successful') => {
  const tokens = generateTokens(user);
  await saveRefreshTokenInRedis(tokens.refreshToken, user.id);
  setSessionCookies(res, tokens);

  return res.status(status).json({
    success: true,
    message,
    data: {
      user: { id: user.id, name: user.name, email: user.email, role: user.role.toLowerCase() },
    },
  });
};

// Save hashed refresh token in Redis with TTL (seconds)
const saveRefreshTokenInRedis = async (refreshToken, userId) => {
  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex');
  // TTL in seconds (30 days)
  const TTL_SECONDS = 30 * 24 * 60 * 60;
  await redis.set(`refresh:${hashed}`, String(userId), { ex: TTL_SECONDS });
  return hashed;
};

// Remove refresh token (by raw token)
const deleteRefreshTokenFromRedis = async (refreshToken) => {
  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await redis.del(`refresh:${hashed}`);
  return hashed;
};

const hasUsableRefreshToken = (refreshToken) => {
  if (!refreshToken) return false;

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    return Boolean(payload.userId);
  } catch {
    return false;
  }
};

// -------------------- Register --------------------
const register = async (req, res) => {
  try {
    const { error } = validateRegistration(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { name, email, password, adminSecret } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Assign role based on admin secret
    const role = adminSecret && adminSecret === process.env.ADMIN_SECRET ? 'ADMIN' : 'USER';

    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, role },
      select: { id: true, name: true, email: true, role: true },
    });

    const tokens = generateTokens(user);
    await saveRefreshTokenInRedis(tokens.refreshToken, user.id);

    setSessionCookies(res, tokens);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user,
      },
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// -------------------- Login --------------------
const login = async (req, res) => {
  try {
    const { error } = validateLogin(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, error: 'Invalid email or password' });
    }

    return establishSession(res, user);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Google Identity Services sends a signed ID token. It must be verified on the
// server; a decoded token or client-provided email is never trusted.
const loginWithGoogle = async (req, res) => {
  try {
    const credential = req.body?.credential;
    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ success: false, error: 'Google credential is required' });
    }
    if (!clientId) {
      console.error('Google sign-in is not configured: GOOGLE_CLIENT_ID is missing');
      return res.status(503).json({ success: false, error: 'Google sign-in is unavailable' });
    }

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    const googleId = payload?.sub;

    if (!payload?.email_verified || !email || !googleId) {
      return res
        .status(401)
        .json({ success: false, error: 'Google did not provide a verified email address' });
    }

    // googleId is protected by a MongoDB sparse unique index. Prisma cannot
    // model that optional MongoDB constraint, so use findFirst here.
    let user = await prisma.user.findFirst({ where: { googleId } });

    if (!user) {
      const userWithEmail = await prisma.user.findUnique({ where: { email } });
      // A verified Google email can safely be linked to the matching local account.
      if (userWithEmail) {
        if (userWithEmail.googleId && userWithEmail.googleId !== googleId) {
          return res.status(409).json({
            success: false,
            error: 'This email is already linked to another Google account',
          });
        }
        user = await prisma.user.update({ where: { id: userWithEmail.id }, data: { googleId } });
      } else {
        user = await prisma.user.create({
          data: {
            name: payload.name?.trim() || email.split('@')[0],
            email,
            googleId,
            role: 'USER',
          },
        });
      }
    }

    return establishSession(res, user, 200, 'Google sign-in successful');
  } catch (err) {
    console.error('Google sign-in error:', err.message);
    return res.status(401).json({ success: false, error: 'Unable to verify Google sign-in' });
  }
};

// Generate OTP
const generateOTPForUser = async (req, res) => {
  try {
    const { error, value } = validateEmail(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const email = normalizeEmail(value.email);
    const cooldown = await getBookingOTPCooldown(userId, email);
    if (cooldown) {
      return res.status(429).json({
        success: false,
        error: `Please wait ${OTP_RESEND_COOLDOWN_SECONDS} seconds before requesting another OTP`,
      });
    }

    const otp = generateOTP();
    await saveBookingOTP(userId, email, otp);

    try {
      const emailResult = await sendOtpEmail(email, otp, OTP_EXPIRY_SECONDS / 60);
      await saveBookingOTPCooldown(userId, email);

      return res.json({
        success: true,
        message: emailResult.sent ? 'OTP sent successfully' : 'OTP generated successfully',
        data: {
          email,
          expiresInMinutes: OTP_EXPIRY_SECONDS / 60,
          emailDelivery: emailResult.sent ? 'sent' : 'disabled',
        },
      });
    } catch (err) {
      await deleteBookingOTP(userId, email);
      console.error('Send OTP email error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to send OTP email' });
    }
  } catch (err) {
    console.error('Generate OTP error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Verify OTP
const verifyOTP = async (req, res) => {
  try {
    const { error, value } = validateOTP(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const email = normalizeEmail(value.email);
    const { otp } = value;
    if (!email || !otp)
      return res.status(400).json({ success: false, error: 'Email and OTP required' });

    const isMasterOTP =
      process.env.MASTER_OTP && String(process.env.MASTER_OTP).trim() === String(otp).trim();
    if (!isMasterOTP) {
      const storedOTP = await getBookingOTP(userId, email);
      if (!storedOTP) {
        return res.status(400).json({ success: false, error: 'OTP expired or not found' });
      }

      if (String(storedOTP).trim() !== String(otp).trim()) {
        return res.status(400).json({ success: false, error: 'Invalid OTP' });
      }
    }

    await deleteBookingOTP(userId, email);
    await saveBookingVerification(userId, email);

    const verifiedUntil = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

    res.json({
      success: true,
      message: 'OTP verified successfully',
      data: { email, verifiedUntil: verifiedUntil.toISOString() },
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// -------------------- Session --------------------
const getSession = async (req, res) => {
  const unauthenticated = () => {
    // Keep the response body stable. A 401 means the browser has a usable
    // refresh cookie, so the frontend should refresh the access-token cookie.
    if (hasUsableRefreshToken(req.cookies?.refreshToken)) {
      return res.status(401).json({ success: false, user: {} });
    }

    // A guest session is a successful session check, not an API error.
    return res.json({ success: true, user: {} });
  };

  try {
    const token = req.cookies?.[ACCESS_TOKEN_COOKIE_NAME];
    if (!token) return unauthenticated();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId) return unauthenticated();

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) return unauthenticated();

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.toLowerCase(),
      },
    });
  } catch (err) {
    console.warn('Session validation failed:', err.message);
    return unauthenticated();
  }
};

// -------------------- Logout --------------------
const logout = async (req, res) => {
  try {
    // Support both body & cookie (if you set cookie on login)
    const incomingToken = req.body?.refreshToken || req.cookies?.refreshToken;
    res.clearCookie('refreshToken');
    res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' });
    if (!incomingToken) {
      return res.status(400).json({ success: false, error: 'Refresh token is required' });
    }

    await deleteRefreshTokenFromRedis(incomingToken);

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// -------------------- Refresh Token --------------------
const refresh = async (req, res) => {
  try {
    const incomingToken = req.body?.refreshToken || req.cookies?.refreshToken;

    if (!incomingToken) {
      return res.status(400).json({ success: false, error: 'Refresh token is required' });
    }

    // Verify refresh token signature and get payload
    let payload;
    try {
      payload = jwt.verify(incomingToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    // Check hashed refresh token exists in Redis
    const hashed = crypto.createHash('sha256').update(incomingToken).digest('hex');
    const storedUserId = await redis.get(`refresh:${hashed}`);
    if (!storedUserId || String(storedUserId) !== String(payload.userId)) {
      return res.status(401).json({ success: false, error: 'Refresh token not found or invalid' });
    }

    // Rotate: delete old token in Redis
    await redis.del(`refresh:${hashed}`);

    // Generate new tokens and store new refresh token
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const tokens = generateTokens(user);
    await saveRefreshTokenInRedis(tokens.refreshToken, user.id);

    setSessionCookies(res, tokens);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {},
    });
  } catch (err) {
    console.error('Refresh token error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

module.exports = {
  register,
  login,
  loginWithGoogle,
  generateOTPForUser,
  verifyOTP,
  getSession,
  logout,
  refresh,
};
