const appointmentController = require('../../src/controllers/appointmentController');
const validation = require('../../src/utils/validation');
jest.mock('../../src/utils/validation');
jest.mock('../../src/utils/time', () => ({ getDatabaseNow: jest.fn() }));
const { getDatabaseNow } = require('../../src/utils/time');

jest.mock('@prisma/client', () => {
  const prismaMock = {
    timeSlot: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    appointment: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  return {
    PrismaClient: jest.fn(() => prismaMock),
    __prismaMock: prismaMock,
  };
});
const { __prismaMock: prisma } = require('@prisma/client');

describe('appointmentController.confirmBooking', () => {
  let req, res;
  beforeEach(() => {
    req = { body: { doctorId: 1, timeSlotId: 2, notes: 'note' }, user: { id: 10 } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    jest.clearAllMocks();
    getDatabaseNow.mockResolvedValue(new Date(Date.now() + 60000));
  });

  it('returns 400 for invalid payload', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: { details: [{ message: 'Invalid' }] } });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid' });
  });

  it('returns 404 if slot not found', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    prisma.timeSlot.findUnique.mockResolvedValueOnce(null);
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Time slot not found for this doctor',
      code: 'SLOT_NOT_FOUND'
    });
  });

  it('returns 409 if slot already booked', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    prisma.timeSlot.findUnique.mockResolvedValueOnce({ id: 2, doctorId: 1, status: 'BOOKED' });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Time slot already booked',
      code: 'SLOT_ALREADY_BOOKED'
    });
  });

  it('returns 403 if OTP not verified', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    prisma.timeSlot.findUnique.mockResolvedValueOnce({ id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 10, lockExpires: new Date(Date.now() + 60000) });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: null });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'OTP verification required',
      code: 'OTP_REQUIRED'
    });
  });

  it('returns 409 if slot not locked by user or lock expired', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    const nowUtc = new Date('2025-09-02T12:00:00Z');
    getDatabaseNow.mockResolvedValueOnce(nowUtc);
    prisma.timeSlot.findUnique.mockResolvedValueOnce({ id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 99, lockExpires: new Date('2025-09-02T12:10:00Z') });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: new Date('2025-09-02T12:10:00Z') });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Slot is not locked by you or lock has expired',
      code: 'LOCK_INVALID'
    });
  });

  it('returns 201 and appointment on success', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    const now = new Date(Date.now() + 60000);
    prisma.timeSlot.findUnique.mockResolvedValueOnce({
      id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 10,
      lockExpires: new Date(now.getTime() + 60000),
      date: new Date(now.getTime() + 86400000),
      startTime: '23:59'
    });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: new Date(now.getTime() + 60000) });
    prisma.timeSlot.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.appointment.findFirst.mockResolvedValueOnce(null);
    prisma.appointment.create.mockResolvedValueOnce({ id: 123 });
    prisma.user.update.mockResolvedValueOnce({});
    prisma.$transaction.mockImplementationOnce(async (cb) => cb(prisma));
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Appointment booked successfully',
      data: { id: 123 }
    });
  });

  it('returns 409 if slot state changed during booking', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    const now = new Date(Date.now() + 60000);
    prisma.timeSlot.findUnique.mockResolvedValueOnce({
      id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 10,
      lockExpires: new Date(now.getTime() + 60000),
      date: new Date(now.getTime() + 86400000),
      startTime: '23:59'
    });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: new Date(now.getTime() + 60000) });
    prisma.timeSlot.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.$transaction.mockImplementationOnce(async () => { throw { code: 'CONFLICT_SLOT_STATE', message: 'Slot state changed, try again' }; });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Slot state changed, try again'
    });
  });

  it('returns 409 if slot is in the past', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    const now = new Date(Date.now() + 60000);
    prisma.timeSlot.findUnique.mockResolvedValueOnce({
      id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 10,
      lockExpires: new Date(now.getTime() + 60000),
      date: new Date(now.getTime() - 86400000),
      startTime: '10:00'
    });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: new Date(now.getTime() + 60000) });
    prisma.timeSlot.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.$transaction.mockImplementationOnce(async () => { throw { code: 'SLOT_IN_PAST', message: 'Cannot book a past date slot' }; });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Cannot book a past date slot'
    });
  });

  it('returns 500 on DB error', async () => {
    validation.validateAppointment.mockReturnValueOnce({ error: null, value: req.body });
    const now = new Date(Date.now() + 60000);
    prisma.timeSlot.findUnique.mockResolvedValueOnce({
      id: 2, doctorId: 1, status: 'LOCKED', lockedBy: 10,
      lockExpires: new Date(now.getTime() + 60000),
      date: new Date(now.getTime() + 86400000),
      startTime: '23:59'
    });
    prisma.user.findUnique.mockResolvedValueOnce({ otpVerifiedUntil: new Date(now.getTime() + 60000) });
    prisma.timeSlot.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.$transaction.mockImplementationOnce(() => { throw new Error('DB error'); });
    await appointmentController.confirmBooking(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal server error' });
  });
});
