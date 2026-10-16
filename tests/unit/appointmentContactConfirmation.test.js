const mockPrisma = {
  timeSlot: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  doctor: {
    findUnique: jest.fn(),
  },
  appointment: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock('../../src/lib/prisma', () => mockPrisma);

jest.mock('../../src/utils/time', () => ({
  getDatabaseNow: jest.fn(),
  getUtcDateTime: jest.fn(),
}));

jest.mock('../../src/utils/otp', () => ({
  getBookingVerification: jest.fn(),
  deleteBookingVerification: jest.fn(),
}));

jest.mock('../../src/lib/redisClient', () => ({
  smembers: jest.fn(),
  del: jest.fn(),
}));

jest.mock('../../src/services/emailService', () => ({
  sendAppointmentConfirmation: jest.fn(),
}));

const appointmentController = require('../../src/controllers/appointmentController');
const { getDatabaseNow } = require('../../src/utils/time');
const { getBookingVerification, deleteBookingVerification } = require('../../src/utils/otp');
const redis = require('../../src/lib/redisClient');
const { sendAppointmentConfirmation } = require('../../src/services/emailService');

describe('appointment contact confirmation', () => {
  const req = {
    user: { id: 'user-1' },
    body: {
      doctorId: 'doctor-1',
      timeSlotId: 'slot-1',
      contactEmail: 'Mother@Example.com',
      patient: {
        name: 'Sita Sharma',
        age: 58,
        gender: 'Female',
        phone: '9876543210',
      },
    },
  };

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getDatabaseNow.mockResolvedValue(new Date('2026-10-02T08:00:00.000Z'));
    getBookingVerification.mockResolvedValue(true);
    mockPrisma.timeSlot.findUnique.mockResolvedValue({
      id: 'slot-1',
      doctorId: 'doctor-1',
      status: 'LOCKED',
      lockedBy: 'user-1',
      lockExpires: new Date('2026-10-02T08:10:00.000Z'),
      date: new Date('2026-10-03T00:00:00.000Z'),
      startTime: '10:00',
    });
    mockPrisma.doctor.findUnique.mockResolvedValue({
      id: 'doctor-1',
      name: 'Dr. Sharma',
      specialization: 'Ayurveda',
      consultationMode: 'in_person',
      consultationFee: 500,
    });
    mockPrisma.timeSlot.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.appointment.findFirst.mockResolvedValue(null);
    mockPrisma.appointment.create.mockResolvedValue({
      id: 'appointment-1',
      contactEmail: 'mother@example.com',
      consultationMode: 'in_person',
      consultationFee: 500,
      patientName: 'Sita Sharma',
      notes: null,
    });
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
    redis.smembers.mockResolvedValue([]);
    sendAppointmentConfirmation.mockResolvedValue({ sent: true });
  });

  it('requires verification for the same appointment contact email', async () => {
    getBookingVerification.mockResolvedValue(false);

    await appointmentController.confirmBooking(req, res);

    expect(getBookingVerification).toHaveBeenCalledWith('user-1', 'mother@example.com');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.appointment.create).not.toHaveBeenCalled();
  });

  it('saves contact, patient, in-person mode and doctor fee after verification', async () => {
    await appointmentController.confirmBooking(req, res);

    expect(mockPrisma.appointment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        contactEmail: 'mother@example.com',
        consultationMode: 'in_person',
        consultationFee: 500,
        patientName: 'Sita Sharma',
        patientAge: 58,
        patientGender: 'female',
        patientPhone: '9876543210',
      }),
    }));
    expect(deleteBookingVerification).toHaveBeenCalledWith('user-1', 'mother@example.com');
    expect(sendAppointmentConfirmation).toHaveBeenCalledWith('mother@example.com', expect.objectContaining({
      doctorName: 'Dr. Sharma',
      consultationFee: 500,
      patientName: 'Sita Sharma',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ emailDelivery: 'sent' }),
    }));
  });

  it('keeps the booking confirmed when confirmation email delivery fails', async () => {
    sendAppointmentConfirmation.mockRejectedValue(new Error('EmailJS rejected the email request'));

    await appointmentController.confirmBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ emailDelivery: 'failed' }),
    }));
  });

  it('reports disabled delivery without calling a real mail provider', async () => {
    sendAppointmentConfirmation.mockResolvedValue({ sent: false, reason: 'EMAIL_DISABLED' });

    await appointmentController.confirmBooking(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ emailDelivery: 'disabled' }),
    }));
  });
});
