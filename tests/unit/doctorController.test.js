const doctorController = require('../../src/controllers/doctorController');
const validation = require('../../src/utils/validation');

jest.mock('../../src/lib/prisma', () => ({
  doctor: {
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  timeSlot: {
    findMany: jest.fn(),
    aggregateRaw: jest.fn(),
    updateMany: jest.fn(),
  },
}));
const prisma = require('../../src/lib/prisma');

jest.mock('../../src/lib/redisClient', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  unlink: jest.fn().mockResolvedValue(0),
  scan: jest.fn().mockResolvedValue(['0', []]),
}));

jest.mock('../../src/utils/validation');

describe('Doctor Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      body: {
        name: 'Dr. Test',
        email: 'drtest@example.com',
        phone: '1234567890',
        specialization: 'Cardiology',
        consultationMode: 'in_person',
        consultationFee: 500,
        languages: ['Hindi', 'English'],
        clinicName: 'Ayurveda Wellness Clinic',
        city: 'Jaipur',
        experience: 5,
        bio: 'Bio',
        imageUrl: 'img.jpg',
      },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  // ---------------- createDoctor ----------------
  describe('createDoctor', () => {
    it('returns 400 for invalid payload', async () => {
      validation.validateDoctorCreate.mockReturnValueOnce({
        error: { details: [{ message: 'Invalid' }] },
      });

      await doctorController.createDoctor(req, res);

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid', success: false });
    });

    it('returns 409 for duplicate email (P2002)', async () => {
      validation.validateDoctorCreate.mockReturnValueOnce({ error: null });
      const error = new Error('Unique constraint');
      error.code = 'P2002';
      prisma.doctor.create.mockImplementationOnce(() => { throw error; });

      await doctorController.createDoctor(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Doctor with this email already exists',
        success: false,
      });
    });

  it('returns 201 and doctor object on success', async () => {
      validation.validateDoctorCreate.mockReturnValueOnce({ error: null });
      prisma.doctor.create.mockResolvedValueOnce({
        id: 1,
        name: 'Dr. Test',
        email: 'drtest@example.com',
      });

      await doctorController.createDoctor(req, res);

    expect(prisma.doctor.create).toHaveBeenCalled();
    expect(prisma.doctor.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ consultationMode: 'in_person' }),
      select: expect.objectContaining({ consultationFee: true, languages: true, clinicName: true, city: true }),
    }));
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        data: expect.any(Object),
        message: expect.any(String),
        success: true,
      });
    });

    it('returns 500 on other errors', async () => {
      validation.validateDoctorCreate.mockReturnValueOnce({ error: null });
      prisma.doctor.create.mockImplementationOnce(() => { throw new Error('DB error'); });

      await doctorController.createDoctor(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error', success: false });
    });
  });

  // ---------------- updateDoctor ----------------
  describe('updateDoctor', () => {
    it('returns 400 for invalid payload', async () => {
      validation.validateDoctorUpdate.mockReturnValueOnce({
        error: { details: [{ message: 'Invalid' }] },
      });

      await doctorController.updateDoctor({ params: { id: 'doctor-1' }, body: {} }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid', success: false });
    });

    it('updates doctor details and clears doctor caches', async () => {
      validation.validateDoctorUpdate.mockReturnValueOnce({ error: null, value: { clinicName: 'Ayurveda Wellness Clinic', city: 'Jaipur' } });
      prisma.doctor.update.mockResolvedValueOnce({ id: 'doctor-1', clinicName: 'Ayurveda Wellness Clinic', city: 'Jaipur' });

      await doctorController.updateDoctor({ params: { id: 'doctor-1' }, body: { clinicName: 'Ayurveda Wellness Clinic', city: 'Jaipur' } }, res);

      expect(prisma.doctor.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'doctor-1' },
        data: expect.objectContaining({
          consultationMode: 'in_person',
          clinicName: 'Ayurveda Wellness Clinic',
          city: 'Jaipur',
        }),
      }));
      expect(res.json).toHaveBeenCalledWith({
        data: { doctor: expect.any(Object) },
        message: 'Doctor updated successfully',
        success: true,
      });
    });

    it('returns 404 when doctor does not exist', async () => {
      validation.validateDoctorUpdate.mockReturnValueOnce({ error: null, value: { languages: ['Hindi'] } });
      const error = new Error('Doctor not found');
      error.code = 'P2025';
      prisma.doctor.update.mockImplementationOnce(() => { throw error; });

      await doctorController.updateDoctor({ params: { id: 'doctor-1' }, body: { languages: ['Hindi'] } }, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Doctor not found', success: false });
    });
  });

  // ---------------- listDoctors ----------------
  describe('listDoctors', () => {
  beforeEach(() => {
    req.query = { consultation_mode: '' }; // <-- minimal fix
  });

  it('returns list of doctors successfully', async () => {
    prisma.doctor.findMany.mockResolvedValueOnce([{ id: 1, name: 'Dr A' }]);
    prisma.doctor.count.mockResolvedValueOnce(1);
    await doctorController.listDoctors(req, res);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ id: 1, name: 'Dr A' }],
      currentPage: 1,
      pageSize: 8,
      totalPages: 1,
      totalResults: 1,
      message: 'Doctors fetched successfully',
      success: true,
    });
  }, 10000);

it('returns empty list when no doctors', async () => {
  prisma.doctor.findMany.mockResolvedValueOnce([]);
  prisma.doctor.count.mockResolvedValueOnce(0);
  await doctorController.listDoctors(req, res);

  expect(res.json).toHaveBeenCalledWith({
    data: [],
    currentPage: 1,
    pageSize: 8,
    totalPages: 0,
    totalResults: 0,
    message: 'Doctors fetched successfully', // <-- updated
    success: true,
  });
}, 10000);

  it('ranks every matching doctor before returning the first Explore page', async () => {
    req.query = { available: 'earliest', page: '1' };
    const doctors = [
      { id: 'ananya', name: 'Dr Ananya' },
      { id: 'arvind', name: 'Dr Arvind' },
      ...Array.from({ length: 7 }, (_, index) => ({ id: `doctor-${index}`, name: `Dr ${index}` })),
    ];
    prisma.timeSlot.aggregateRaw.mockResolvedValueOnce([
      { doctorId: 'ananya', slotId: 'slot-ananya', date: '2099-01-02', startTime: '10:00', endTime: '10:30' },
      { doctorId: 'arvind', slotId: 'slot-arvind', date: '2099-01-01', startTime: '09:00', endTime: '09:30' },
      ...Array.from({ length: 7 }, (_, index) => ({
        doctorId: `doctor-${index}`,
        slotId: `slot-${index}`,
        date: '2099-01-03',
        startTime: '09:00',
        endTime: '09:30',
      })),
    ]);
    prisma.doctor.findMany.mockResolvedValueOnce(doctors);

    await doctorController.listDoctors(req, res);

    expect(prisma.doctor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: expect.arrayContaining(['arvind', 'ananya']) } }),
      select: expect.any(Object),
    }));
    expect(prisma.doctor.findMany.mock.calls[0][0]).not.toHaveProperty('skip');
    expect(prisma.doctor.findMany.mock.calls[0][0]).not.toHaveProperty('take');

    const response = res.json.mock.calls[0][0];
    expect(response.totalResults).toBe(9);
    expect(response.data).toHaveLength(8);
    expect(response.data.slice(0, 2).map((doctor) => doctor.id)).toEqual(['arvind', 'ananya']);
  });


  it('returns 500 on DB error', async () => {
    prisma.doctor.findMany.mockImplementationOnce(() => { throw new Error('DB error'); });
    await doctorController.listDoctors(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal server error',
      success: false,
    });
  });
});

});

// ✅ Disconnect prisma after all tests
// ...existing code...
