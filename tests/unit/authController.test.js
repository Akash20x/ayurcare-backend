const authController = require('../../src/controllers/authController');
const validation = require('../../src/utils/validation');
const { __prismaMock: prisma } = require('@prisma/client');

// Mock Prisma
jest.mock('@prisma/client', () => {
  const prismaMock = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => prismaMock), __prismaMock: prismaMock };
});

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
});
