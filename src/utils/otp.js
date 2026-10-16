const redis = require('../lib/redisClient');

const OTP_EXPIRY_SECONDS = Number(process.env.OTP_EXPIRY_SECONDS) || 5 * 60;
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60;

const getBookingOTPKey = (userId, email) => `booking:otp:${userId}:${email}`;
const getBookingCooldownKey = (userId, email) => `booking:otp-cooldown:${userId}:${email}`;
const getBookingVerifiedKey = (userId, email) => `booking:verified:${userId}:${email}`;
const getDraftOTPKey = (userId, draftId) => `booking:draft-otp:${userId}:${draftId}`;
const getDraftCooldownKey = (userId, draftId) => `booking:draft-otp-cooldown:${userId}:${draftId}`;
const getDraftVerifiedKey = (userId, draftId) => `booking:draft-verified:${userId}:${draftId}`;

async function saveBookingOTP(userId, email, otp) {
  if (!userId || !email || !otp) throw new Error('User, email and OTP are required');

  try {
    await redis.set(getBookingOTPKey(userId, email), otp, { ex: OTP_EXPIRY_SECONDS });
    return true;
  } catch (err) {
    throw new Error('Failed to save OTP');
  }
}

async function getBookingOTP(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    const otp = await redis.get(getBookingOTPKey(userId, email));
    return otp || null;
  } catch (err) {
    throw new Error('Failed to get OTP from Redis');
  }
}

async function deleteBookingOTP(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    await redis.del(getBookingOTPKey(userId, email));
    return true;
  } catch (err) {
    throw new Error('Failed to delete OTP');
  }
}

async function getBookingOTPCooldown(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    const cooldown = await redis.get(getBookingCooldownKey(userId, email));
    return cooldown || null;
  } catch (err) {
    throw new Error('Failed to get OTP cooldown');
  }
}

async function saveBookingOTPCooldown(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    await redis.set(getBookingCooldownKey(userId, email), 'true', { ex: OTP_RESEND_COOLDOWN_SECONDS });
    return true;
  } catch (err) {
    throw new Error('Failed to save OTP cooldown');
  }
}

async function saveBookingVerification(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    await redis.set(getBookingVerifiedKey(userId, email), 'true', { ex: OTP_EXPIRY_SECONDS });
    return true;
  } catch (err) {
    throw new Error('Failed to save booking verification');
  }
}

async function getBookingVerification(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    const verified = await redis.get(getBookingVerifiedKey(userId, email));
    return verified === 'true' || verified === true;
  } catch (err) {
    throw new Error('Failed to get booking verification');
  }
}

async function deleteBookingVerification(userId, email) {
  if (!userId || !email) throw new Error('User and email are required');

  try {
    await redis.del(getBookingVerifiedKey(userId, email));
    return true;
  } catch (err) {
    throw new Error('Failed to delete booking verification');
  }
}

async function saveDraftOTP(userId, draftId, otp) {
  if (!userId || !draftId || !otp) throw new Error('User, draft and OTP are required');
  await redis.set(getDraftOTPKey(userId, draftId), otp, { ex: OTP_EXPIRY_SECONDS });
}

async function getDraftOTP(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  return (await redis.get(getDraftOTPKey(userId, draftId))) || null;
}

async function deleteDraftOTP(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  await redis.del(getDraftOTPKey(userId, draftId));
}

async function getDraftOTPCooldown(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  return (await redis.get(getDraftCooldownKey(userId, draftId))) || null;
}

async function saveDraftOTPCooldown(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  await redis.set(getDraftCooldownKey(userId, draftId), 'true', { ex: OTP_RESEND_COOLDOWN_SECONDS });
}

async function saveDraftVerification(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  await redis.set(getDraftVerifiedKey(userId, draftId), 'true', { ex: OTP_EXPIRY_SECONDS });
}

async function getDraftVerification(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  const verified = await redis.get(getDraftVerifiedKey(userId, draftId));
  return verified === 'true' || verified === true;
}

async function deleteDraftVerification(userId, draftId) {
  if (!userId || !draftId) throw new Error('User and draft are required');
  await redis.del(getDraftVerifiedKey(userId, draftId));
}

module.exports = {
  OTP_EXPIRY_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  saveBookingOTP,
  getBookingOTP,
  deleteBookingOTP,
  getBookingOTPCooldown,
  saveBookingOTPCooldown,
  saveBookingVerification,
  getBookingVerification,
  deleteBookingVerification,
  saveDraftOTP,
  getDraftOTP,
  deleteDraftOTP,
  getDraftOTPCooldown,
  saveDraftOTPCooldown,
  saveDraftVerification,
  getDraftVerification,
  deleteDraftVerification,
};
