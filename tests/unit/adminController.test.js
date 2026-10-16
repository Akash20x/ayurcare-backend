jest.mock('../../src/lib/prisma', () => ({
  doctor: { findUnique: jest.fn() },
  appointment: { findMany: jest.fn() },
}));
jest.mock('../../src/utils/time', () => ({ getDatabaseNow: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { getDatabaseNow } = require('../../src/utils/time');
const { getDoctorUpcomingAppointments } = require('../../src/controllers/adminController');

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

describe('getDoctorUpcomingAppointments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDatabaseNow.mockResolvedValue(new Date('2026-10-16T04:00:00.000Z'));
  });

  it('returns the next ten booked appointments with only table fields', async () => {
    const doctor = { id: 'doctor-1', name: 'Dr. Arvind Sharma', specialization: 'Roga Nidana' };
    const appointments = [{
      id: 'appointment-1',
      patientName: 'Rohit Sharma',
      contactEmail: 'rohit@example.com',
      patientPhone: '9999999999',
      timeSlot: { date: new Date('2026-10-17T00:00:00.000Z'), startTime: '09:30', endTime: '10:00' },
    }];
    prisma.doctor.findUnique.mockResolvedValue(doctor);
    prisma.appointment.findMany.mockResolvedValue(appointments);
    const res = response();

    await getDoctorUpcomingAppointments({ params: { doctorId: doctor.id } }, res);

    expect(prisma.appointment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 10,
      where: expect.objectContaining({ doctorId: doctor.id, status: 'BOOKED' }),
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { doctor, appointments } });
  });

  it('returns 404 when the doctor does not exist', async () => {
    prisma.doctor.findUnique.mockResolvedValue(null);
    const res = response();

    await getDoctorUpcomingAppointments({ params: { doctorId: 'missing-doctor' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });
});
