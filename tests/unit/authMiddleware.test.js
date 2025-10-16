const auth = require('../../src/middleware/auth');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

jest.mock('@prisma/client', () => {
  const prismaMock = {
    user: {
      findUnique: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => prismaMock),
    __prismaMock: prismaMock,
  };
});
const { __prismaMock: prisma } = require('@prisma/client');
jest.mock('jsonwebtoken');

describe('auth middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { header: jest.fn(), user: undefined };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('returns 401 if no token', async () => {
    req.header.mockReturnValueOnce(undefined);
    await auth(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Access denied. No token provided.', success: false });
  });

  it('returns 401 if token invalid', async () => {
    req.header.mockReturnValueOnce('Bearer badtoken');
    jwt.verify.mockImplementationOnce(() => { throw new Error('invalid'); });
    await auth(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token.', success: false });
  });

  it('returns 401 if user not found', async () => {
    req.header.mockReturnValueOnce('Bearer validtoken');
    jwt.verify.mockReturnValueOnce({ userId: 1 });
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await auth(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token.', success: false });
  });

  it('attaches user to request if token valid', async () => {
    req.header.mockReturnValueOnce('Bearer validtoken');
    jwt.verify.mockReturnValueOnce({ userId: 1 });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 1, email: 'a@b.com' });
    await auth(req, res, next);
    expect(req.user).toEqual({ id: 1, email: 'a@b.com' });
    expect(next).toHaveBeenCalled();
  });
});
