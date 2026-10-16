jest.mock('../../src/lib/prisma', () => ({
  appointment: { findMany: jest.fn() },
}));
jest.mock('../../src/lib/redisClient', () => ({
  get: jest.fn(), set: jest.fn(), del: jest.fn(),
}));
jest.mock('../../src/utils/time', () => ({
  getDatabaseNow: jest.fn(),
}));

const prisma = require('../../src/lib/prisma');
const redis = require('../../src/lib/redisClient');
const { getDatabaseNow } = require('../../src/utils/time');
const { listAppointments } = require('../../src/controllers/appointmentController');

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

beforeEach(() => {
  jest.clearAllMocks();
  getDatabaseNow.mockResolvedValue(new Date('2026-10-03T09:00:00.000Z'));
  prisma.appointment.findMany.mockResolvedValue([]);
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
});

test.each(['upcoming', 'past'])('%s appointments bypass time-stale Redis lists', async (type) => {
  await listAppointments({ user: { id: 'user-1' }, query: { type } }, response());

  expect(prisma.appointment.findMany).toHaveBeenCalledTimes(1);
  expect(redis.get).not.toHaveBeenCalled();
  expect(redis.set).not.toHaveBeenCalled();
});

test('time-independent all list retains the cache-hit response contract', async () => {
  const req = { user: { id: 'user-1' }, query: { type: 'all' } };
  await listAppointments(req, response());
  expect(redis.set).toHaveBeenCalledWith(
    'user:user-1:appointments:any:all',
    JSON.stringify([]),
    { ex: 14400 }
  );

  redis.get.mockResolvedValueOnce(JSON.stringify([{ id: 'appointment-1' }]));
  const cached = response();
  await listAppointments(req, cached);
  expect(cached.json).toHaveBeenCalledWith({
    success: true, message: 'Appointments fetched from cache',
    data: [{ id: 'appointment-1' }],
  });
  expect(prisma.appointment.findMany).toHaveBeenCalledTimes(1);
});

test('continues with the database when the appointment-list cache is unavailable', async () => {
  redis.get.mockRejectedValueOnce(new Error('Redis unavailable'));
  const res = response();

  await listAppointments({ user: { id: 'user-1' }, query: { type: 'all' } }, res);

  expect(prisma.appointment.findMany).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith({
    success: true,
    message: 'Appointments fetched successfully',
    data: [],
  });
});

test('returns the database response when writing the appointment-list cache fails', async () => {
  redis.set.mockRejectedValueOnce(new Error('Redis unavailable'));
  const res = response();

  await listAppointments({ user: { id: 'user-1' }, query: { type: 'all' } }, res);

  expect(res.json).toHaveBeenCalledWith({
    success: true,
    message: 'Appointments fetched successfully',
    data: [],
  });
});
