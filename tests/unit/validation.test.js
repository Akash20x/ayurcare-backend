describe('Validation Utils', () => {
const validation = require('../../src/utils/validation');

describe('Validation utils', () => {
  describe('validateRegistration', () => {
    it('returns error for missing fields', () => {
      const result = validation.validateRegistration({});
      expect(result.error).toBeTruthy();
    });
    it('passes for valid data', () => {
  const result = validation.validateRegistration({ name: 'Ak', email: 'a@b.com', password: '123456' });
      expect(result.error).toBeFalsy();
    });
    it('returns error for password mismatch', () => {
      const result = validation.validateRegistration({ name: 'Ak', email: 'a@b.com', password: '123456', confirmPassword: '654321' });
      expect(result.error).toBeTruthy();
    });
  });
});

  describe('validateLogin', () => {
    it('returns error for missing fields', () => {
      const result = validation.validateLogin({});
      expect(result.error).toBeTruthy();
    });
    it('passes for valid data', () => {
      const result = validation.validateLogin({ email: 'a@b.com', password: '123456' });
      expect(result.error).toBeFalsy();
    });
  });

  describe('validateEmail', () => {
    it('returns error for missing email', () => {
      const result = validation.validateEmail({});
      expect(result.error).toBeTruthy();
    });
    it('passes for valid email', () => {
      const result = validation.validateEmail({ email: 'a@b.com' });
      expect(result.error).toBeFalsy();
    });
  });

  describe('validateOTP', () => {
    it('returns error for missing fields', () => {
      const result = validation.validateOTP({});
      expect(result.error).toBeTruthy();
    });
    it('returns error for invalid OTP', () => {
      const result = validation.validateOTP({ email: 'a@b.com', otp: 'abc' });
      expect(result.error).toBeTruthy();
    });
    it('passes for valid OTP', () => {
      const result = validation.validateOTP({ email: 'a@b.com', otp: '123456' });
      expect(result.error).toBeFalsy();
    });
  });
});
