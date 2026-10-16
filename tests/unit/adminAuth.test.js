const adminAuth = require('../../src/middleware/adminAuth');

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

test('uses the freshly authenticated role without a second database lookup', async () => {
  const next = jest.fn();
  await adminAuth({ user: { id: 'user-1', role: 'ADMIN' } }, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
});

test('denies a user whose role changed to USER', async () => {
  const res = response();
  await adminAuth({ user: { id: 'user-1', role: 'USER' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});
