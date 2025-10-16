const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // ← add this
const { PrismaClient } = require('@prisma/client');
const { getDatabaseNow } = require('../utils/time');
const { validateRegistration, validateLogin, validateOTP, validateEmail } = require('../utils/validation');
const { getOTP, deleteOTP, saveOTP } = require('../utils/otp');
const redis = require('../lib/redisClient');

const prisma = new PrismaClient();

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { userId: user.id, email: user.email, role: user.role.toLowerCase() },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );

  const refreshToken = jwt.sign(
    { userId: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
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
      select: { id: true, name: true, email: true, phone: true, createdAt: true, role:true }
    });

    const tokens = generateTokens(user);
    await saveRefreshTokenInRedis(tokens.refreshToken, user.id);

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });


    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: { 
        user,         
        accessToken: tokens.accessToken
      }
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

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, error: 'Invalid email or password' });
    }

    const tokens = generateTokens(user);
    await saveRefreshTokenInRedis(tokens.refreshToken, user.id);

    res.cookie('refreshToken', tokens.refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30*24*60*60*1000 });


    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
        accessToken: tokens.accessToken
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Generate OTP
const generateOTPForUser = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ success: false, error: "User not found" });

    const otp = generateOTP();
    await saveOTP(email, otp);

    res.json({
      success: true,
      message: "OTP generated and sent",
      data: { email, otp }, 
    });
  } catch (err) {
    console.error("Generate OTP error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// Verify OTP
const verifyOTP = async (req, res) => {
  try {

    const { error } = validateOTP(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, error: "Email and OTP required" });

    const storedOTP = await getOTP(email);
    if (!storedOTP) {
      return res.status(400).json({ success: false, error: "OTP expired or not found" });
    }

   if (String(storedOTP).trim() !== String(otp).trim()) {
  return res.status(400).json({ success: false, error: "Invalid OTP" });
}
    await deleteOTP(email);

    
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const nowDb = await getDatabaseNow(prisma);
    const verifiedUntil = new Date(nowDb.getTime() + 5 * 60 * 1000);

    await prisma.user.update({ where: { id: user.id }, data: { otpVerifiedUntil: verifiedUntil } });

    res.json({
      success: true,
      message: 'OTP verified successfully',
      data: { otpVerifiedUntil: verifiedUntil.toISOString() }
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};


// -------------------- Get Profile --------------------
const getProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const cacheKey = `user:${userId}:profile`;
    const CACHE_TTL = 600; // 10 minutes

    // Try cache first
    const cachedProfile = await redis.get(cacheKey);
    if (cachedProfile) {
      try {
        const parsed = JSON.parse(cachedProfile);
        return res.json({
          success: true,
          data: parsed,
          message: "Profile fetched successfully (from cache)",
        });
      } catch (err) {
        console.warn("Invalid JSON in Redis for key:", cacheKey, cachedProfile);
        // Clear bad cache so fresh data can be stored
        await redis.del(cacheKey);
      }
    }

    // Fetch user from DB including role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Normalize role for API response
    const userResponse = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role?.toLowerCase() || null,
      createdAt: user.createdAt,
    };

    // Store valid JSON in Redis
    await redis.set(cacheKey, JSON.stringify(userResponse), { ex: CACHE_TTL });

    res.json({
      success: true,
      data: userResponse,
      message: "Profile fetched successfully",
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};



// -------------------- Logout --------------------
const logout = async (req, res) => {
  try {
    // Support both body & cookie (if you set cookie on login)
    const incomingToken = req.body.refreshToken || (req.cookies && req.cookies.refreshToken);
    if (!incomingToken) {
      return res.status(400).json({ success: false, error: 'Refresh token is required' });
    }

    await deleteRefreshTokenFromRedis(incomingToken);

    res.clearCookie('refreshToken');

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// -------------------- Refresh Token --------------------
const refresh = async (req, res) => {
  try {
    const incomingToken = req.body.refreshToken || (req.cookies && req.cookies.refreshToken);

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

   res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: { accessToken: tokens.accessToken }
    });

  } catch (err) {
    console.error('Refresh token error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


module.exports = {
  register,
  login,
  generateOTPForUser,
  verifyOTP,
  getProfile,
  logout,
  refresh
};
