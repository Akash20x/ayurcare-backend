jest.mock('../../src/lib/prisma', () => ({
  appointment: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  timeSlot: { findUnique: jest.fn() },
  doctor: { findUnique: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/lib/redisClient', () => ({ del: jest.fn().mockResolvedValue(1) }));
jest.mock('../../src/utils/time', () => ({
  ...jest.requireActual('../../src/utils/time'),
  getDatabaseNow: jest.fn(),
}));
jest.mock('../../src/utils/otp', () => ({
  getBookingVerification: jest.fn(), deleteBookingVerification: jest.fn(),
}));
jest.mock('../../src/services/emailService', () => ({
  sendAppointmentConfirmation: jest.fn(),
}));

const prisma = require('../../src/lib/prisma');
const redis = require('../../src/lib/redisClient');
const { getDatabaseNow } = require('../../src/utils/time');
const { getBookingVerification } = require('../../src/utils/otp');
const { sendAppointmentConfirmation } = require('../../src/services/emailService');
const controller = require('../../src/controllers/appointmentController');

const now = new Date('2026-10-03T09:00:00.000Z');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const expectInvalidation = (...ids) => {
  expect(redis.del).toHaveBeenCalledTimes(1);
  const keys = redis.del.mock.calls[0];
  expect(keys).toContain('user:user-1:appointments:any:all');
  for (const id of ids) expect(keys).toContain(`appointment:user-1:${id}`);
};

beforeEach(() => {
  jest.clearAllMocks();
  getDatabaseNow.mockResolvedValue(now);
  redis.del.mockResolvedValue(1);
  getBookingVerification.mockResolvedValue(true);
  sendAppointmentConfirmation.mockResolvedValue({ sent: true });
});

test('booking invalidates appointment lists in one Redis call', async () => {
  prisma.timeSlot.findUnique.mockResolvedValue({
    id: 'slot-1', doctorId: 'doctor-1', status: 'LOCKED', lockedBy: 'user-1',
    lockExpires: new Date(now.getTime() + 60000),
    date: new Date('2026-10-04T00:00:00.000Z'), startTime: '10:00',
  });
  prisma.doctor.findUnique.mockResolvedValue({
    id: 'doctor-1', name: 'Dr. Test', specialization: 'Ayurveda',
    consultationMode: 'in_person', consultationFee: 500,
  });
  prisma.$transaction.mockResolvedValue({ id: 'appointment-1', contactEmail: 'patient@example.com' });

  const res = response();
  await controller.confirmBooking({
    user: { id: 'user-1' },
    body: { doctorId: 'doctor-1', timeSlotId: 'slot-1', contactEmail: 'patient@example.com' },
  }, res);

  expect(res.status).toHaveBeenCalledWith(201);
  expectInvalidation('appointment-1');
});

test('status update invalidates its list and detail caches', async () => {
  prisma.appointment.findUnique.mockResolvedValue({ id: 'appointment-1', userId: 'user-1', status: 'BOOKED' });
  prisma.appointment.update.mockResolvedValue({ id: 'appointment-1', status: 'COMPLETED' });

  await controller.updateAppointmentStatus({
    user: { id: 'user-1' }, params: { id: 'appointment-1' }, body: { status: 'COMPLETED' },
  }, response());

  expectInvalidation('appointment-1');
});

test('cancellation invalidates its list and detail caches', async () => {
  prisma.appointment.findFirst.mockResolvedValue({
    id: 'appointment-1', status: 'BOOKED', timeSlotId: 'slot-1',
    timeSlot: { id: 'slot-1', date: new Date('2026-10-05T00:00:00.000Z'), startTime: '10:00', status: 'BOOKED' },
  });
  prisma.$transaction.mockResolvedValue({ id: 'appointment-1', status: 'CANCELLED' });

  await controller.cancelAppointment({ user: { id: 'user-1' }, params: { id: 'appointment-1' } }, response());

  expectInvalidation('appointment-1');
});

test('reschedule confirmation invalidates both appointment details', async () => {
  prisma.appointment.findFirst.mockResolvedValue({
    id: 'appointment-1', userId: 'user-1', doctorId: 'doctor-1',
    status: 'BOOKED', timeSlotId: 'slot-old',
  });
  prisma.$transaction.mockResolvedValue({ id: 'appointment-2' });

  await controller.confirmReschedule({
    user: { id: 'user-1' },
    body: { appointmentId: 'appointment-1', oldSlotId: 'slot-old', newSlotId: 'slot-new', doctorId: 'doctor-1' },
  }, response());

  expectInvalidation('appointment-1', 'appointment-2');
});
