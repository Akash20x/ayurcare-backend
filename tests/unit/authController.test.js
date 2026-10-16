const authController = require('../../src/controllers/authController');
const validation = require('../../src/utils/validation');
const jwt = require('jsonwebtoken');

jest.mock('../../src/lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
}));
const prisma = require('../../src/lib/prisma');

jest.mock('../../src/lib/redisClient', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
}));

// Mock validation
jest.mock('../../src/utils/validation');

describe('Auth Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { name: 'Test', email: 'test@example.com', password: 'pass123' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  describe('register', () => {
    it('returns 400 for invalid payload', async () => {
      validation.validateRegistration.mockReturnValueOnce({ error: { details: [{ message: 'Invalid' }] } });
      await authController.register(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid', success: false });
    });

    it('returns 400 if user already exists', async () => {
      validation.validateRegistration.mockReturnValueOnce({ error: null });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 1 });
      await authController.register(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'User already exists with this email', success: false });
    });
  });

  describe('login', () => {
    it('returns 400 if user not found', async () => {
      validation.validateLogin.mockReturnValueOnce({ error: null });
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await authController.login(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid email or password' });
    });

    it('returns 400 when password mismatch', async () => {
      validation.validateLogin.mockReturnValueOnce({ error: null });
      prisma.user.findUnique.mockResolvedValueOnce({ password: 'hashed' });
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

      await authController.login({ body: { email: 'u@u.com', password: 'wrong' } }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid email or password' });
    });
  });

  describe('getSession', () => {
    it('returns the cookie-authenticated user in the session response shape', async () => {
      const verify = jest.spyOn(jwt, 'verify').mockReturnValueOnce({ userId: 1 });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 1,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
      });

      await authController.getSession({ cookies: { accessToken: 'signed-access-token' } }, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        user: { id: 1, name: 'Test User', email: 'test@example.com', role: 'user' },
      });
      verify.mockRestore();
    });

    it('returns the unauthenticated response when the session cookie is missing', async () => {
      await authController.getSession({ cookies: {} }, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, user: {} });
    });

    it('returns 401 with the same response body when a refresh cookie can renew the session', async () => {
      const verify = jest.spyOn(jwt, 'verify').mockReturnValueOnce({ userId: 1 });

      await authController.getSession({ cookies: { refreshToken: 'valid-refresh-token' } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, user: {} });
      verify.mockRestore();
    });
  });
});
