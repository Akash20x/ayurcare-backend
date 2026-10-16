const auth = require('../../src/middleware/auth');
const adminAuth = require('../../src/middleware/adminAuth');
const jwt = require('jsonwebtoken');

jest.mock('../../src/lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
  },
}));
const prisma = require('../../src/lib/prisma');
jest.mock('jsonwebtoken');

describe('auth middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { header: jest.fn(), cookies: {}, user: undefined };
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

  it('accepts the HTTP-only access-token cookie when no bearer header is present', async () => {
    req.cookies.accessToken = 'cookie-access-token';
    jwt.verify.mockReturnValueOnce({ userId: 1 });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 1, email: 'a@b.com' });

    await auth(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('cookie-access-token', process.env.JWT_SECRET);
    expect(next).toHaveBeenCalled();
  });

  it('uses one fresh user lookup for authentication and admin authorization', async () => {
    req.header.mockReturnValueOnce('Bearer validtoken');
    jwt.verify.mockReturnValueOnce({ userId: 'user-1' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1', role: 'ADMIN' });

    await auth(req, res, next);
    await adminAuth(req, res, next);

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ role: true }),
    }));
    expect(next).toHaveBeenCalledTimes(2);
  });
});
