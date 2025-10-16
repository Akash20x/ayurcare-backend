// utils/otp.js
const redis = require('../lib/redisClient');

const OTP_EXPIRY_SECONDS = 5 * 60; // 5 minutes


// Save OTP with TTL
async function saveOTP(email, otp) {
  if (!email || !otp) throw new Error("Email and OTP are required");
  const key = `otp:${email}`;

  try {
    await redis.set(key, otp, { ex: OTP_EXPIRY_SECONDS });
    return true;
  } catch (err) {
    throw new Error("Failed to save OTP");
  }
}

// Get OTP
async function getOTP(email) {
  if (!email) throw new Error("Email is required");
  const key = `otp:${email}`;

  // Retry wrapper
  for (let i = 0; i < 2; i++) {
    try {
      const value = await redis.get(key);
      return value || null;
    } catch (err) {
      // if second attempt fails, throw
      if (i === 1) throw new Error("Failed to get OTP from Redis");
      await new Promise(res => setTimeout(res, 50)); // wait 50ms and retry
    }
  }
}

// Delete OTP
async function deleteOTP(email) {
  if (!email) throw new Error("Email is required");
  const key = `otp:${email}`;

  try {
    await redis.del(key);
    return true;
  } catch (err) {
    throw new Error("Failed to delete OTP");
  }
}

module.exports = { saveOTP, getOTP, deleteOTP };
