jest.mock('../../src/lib/redisClient', () => ({
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
}));

const redis = require('../../src/lib/redisClient');
const {
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
  saveDraftVerification,
  getDraftVerification,
} = require('../../src/utils/otp');

describe('booking OTP storage', () => {
  const userId = 'user-1';
  const email = 'patient@example.com';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores OTPs by user and appointment email', async () => {
    await saveBookingOTP(userId, email, '123456');

    expect(redis.set).toHaveBeenCalledWith(
      `booking:otp:${userId}:${email}`,
      '123456',
      { ex: OTP_EXPIRY_SECONDS }
    );
  });

  it('reads and deletes the matching OTP', async () => {
    redis.get.mockResolvedValueOnce('123456');

    await expect(getBookingOTP(userId, email)).resolves.toBe('123456');
    await deleteBookingOTP(userId, email);

    expect(redis.get).toHaveBeenCalledWith(`booking:otp:${userId}:${email}`);
    expect(redis.del).toHaveBeenCalledWith(`booking:otp:${userId}:${email}`);
  });

  it('enforces a resend cooldown for the same user and email', async () => {
    await saveBookingOTPCooldown(userId, email);
    redis.get.mockResolvedValueOnce('true');

    await expect(getBookingOTPCooldown(userId, email)).resolves.toBe('true');
    expect(redis.set).toHaveBeenCalledWith(
      `booking:otp-cooldown:${userId}:${email}`,
      'true',
      { ex: OTP_RESEND_COOLDOWN_SECONDS }
    );
  });

  it('stores verification separately for each user and email', async () => {
    await saveBookingVerification(userId, email);
    redis.get.mockResolvedValueOnce('true');

    await expect(getBookingVerification(userId, email)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      `booking:verified:${userId}:${email}`,
      'true',
      { ex: OTP_EXPIRY_SECONDS }
    );

    await deleteBookingVerification(userId, email);
    expect(redis.del).toHaveBeenCalledWith(`booking:verified:${userId}:${email}`);
  });

  it('binds draft OTP and verification to both the user and opaque draft ID', async () => {
    await saveDraftOTP(userId, 'draft-1', '123456');
    redis.get.mockResolvedValueOnce('123456').mockResolvedValueOnce('true');

    await expect(getDraftOTP(userId, 'draft-1')).resolves.toBe('123456');
    await saveDraftVerification(userId, 'draft-1');
    await expect(getDraftVerification(userId, 'draft-1')).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledWith(`booking:draft-otp:${userId}:draft-1`, '123456', { ex: OTP_EXPIRY_SECONDS });
    expect(redis.set).toHaveBeenCalledWith(`booking:draft-verified:${userId}:draft-1`, 'true', { ex: OTP_EXPIRY_SECONDS });
  });
});
