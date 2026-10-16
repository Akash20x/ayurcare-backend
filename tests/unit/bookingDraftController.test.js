jest.mock('../../src/lib/prisma', () => ({
  doctor: { findUnique: jest.fn() },
  timeSlot: { findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../../src/lib/redisClient', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../../src/utils/time', () => ({ getDatabaseNow: jest.fn() }));
jest.mock('../../src/utils/otp', () => ({
  OTP_EXPIRY_SECONDS: 300,
  OTP_RESEND_COOLDOWN_SECONDS: 60,
  saveDraftOTP: jest.fn(), getDraftOTP: jest.fn(), deleteDraftOTP: jest.fn(),
  getDraftOTPCooldown: jest.fn(), saveDraftOTPCooldown: jest.fn(),
  saveDraftVerification: jest.fn(), getDraftVerification: jest.fn(), deleteDraftVerification: jest.fn(),
}));
jest.mock('../../src/services/emailService', () => ({ sendOtpEmail: jest.fn(), sendAppointmentConfirmation: jest.fn() }));
jest.mock('../../src/utils/appointmentCache', () => ({ invalidateAppointmentCaches: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const redis = require('../../src/lib/redisClient');
const { getDatabaseNow } = require('../../src/utils/time');
const { getDraftVerification } = require('../../src/utils/otp');
const { createBookingDraft, getBookingConfirmation } = require('../../src/controllers/bookingDraftController');

describe('booking draft creation', () => {
  const now = new Date('2026-10-13T10:00:00.000Z');
  const body = {
    doctorId: 'doctor-1',
    slotId: 'slot-1',
    contactEmail: 'contact@example.com',
    bookingForSomeoneElse: false,
    patient: { name: 'Rohit Sharma' },
  };
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    getDatabaseNow.mockResolvedValue(now);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    prisma.doctor.findUnique.mockResolvedValue({ id: 'doctor-1', consultationMode: 'in_person' });
    prisma.timeSlot.findUnique.mockResolvedValue({
      id: 'slot-1', doctorId: 'doctor-1', status: 'AVAILABLE',
      date: new Date('2026-10-14T00:00:00.000Z'), startTime: '10:00',
    });
    prisma.timeSlot.count.mockResolvedValue(0);
    prisma.timeSlot.updateMany.mockResolvedValue({ count: 1 });
  });

  it('requires a patient name before attempting a slot lock', async () => {
    const res = response();
    await createBookingDraft({ user: { id: 'user-1' }, body: { ...body, patient: {} } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.timeSlot.updateMany).not.toHaveBeenCalled();
  });

  it('allows a patient name without optional demographic details', async () => {
    const res = response();
    await createBookingDraft({ user: { id: 'user-1' }, body }, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('locks the selected slot and stores a five-minute server-side draft', async () => {
    const res = response();
    await createBookingDraft({ user: { id: 'user-1' }, body }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(prisma.timeSlot.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'LOCKED', lockedBy: 'user-1', lockExpires: new Date('2026-10-13T10:05:00.000Z') }),
    }));
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^booking:draft:user-1:/), expect.any(String), { ex: 300 });
    expect(redis.set).toHaveBeenCalledWith('booking:draft:current:user-1', expect.any(String), { ex: 300 });
  });

  it('releases the previous current draft slot before replacing it', async () => {
    redis.get
      .mockResolvedValueOnce('old-draft')
      .mockResolvedValueOnce(JSON.stringify({ timeSlotId: 'old-slot' }));
    const res = response();
    await createBookingDraft({ user: { id: 'user-1' }, body }, res);

    expect(prisma.timeSlot.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'old-slot', status: 'LOCKED', lockedBy: 'user-1' },
      data: { status: 'AVAILABLE', lockedBy: null, lockedAt: null, lockExpires: null },
    }));
  });
});

describe('booking confirmation summary', () => {
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get
      .mockResolvedValueOnce('draft-1')
      .mockResolvedValueOnce('draft-1')
      .mockResolvedValueOnce(JSON.stringify({
        draftId: 'draft-1',
        doctorId: 'doctor-1',
        timeSlotId: 'slot-1',
        contactEmail: 'contact@example.com',
        patient: { name: 'Rohit Sharma', phone: '9999999999' },
      }));
    getDraftVerification.mockResolvedValue(true);
    prisma.doctor.findUnique.mockResolvedValue({
      name: 'Dr. Arvind Sharma',
      specialization: 'Roga Nidana',
      consultationFee: 500,
      clinicName: 'Ayurveda Wellness Clinic',
      city: 'Jaipur',
    });
    prisma.timeSlot.findFirst.mockResolvedValue({
      date: new Date('2026-10-17T00:00:00.000Z'),
      startTime: '09:30',
      endTime: '10:00',
    });
  });

  it('returns venue under appointment context and email under patient context', async () => {
    const res = response();

    await getBookingConfirmation({ user: { id: 'user-1' } }, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        doctor: {
          name: 'Dr. Arvind Sharma',
          specialization: 'Roga Nidana',
          consultationFee: 500,
          venue: 'Ayurveda Wellness Clinic, Jaipur',
        },
        appointment: {
          date: '2026-10-17',
          startTime: '09:30',
          endTime: '10:00',
        },
        patient: {
          name: 'Rohit Sharma',
          age: null,
          gender: null,
          phone: '9999999999',
          email: 'contact@example.com',
        },
      },
    });
  });
});
