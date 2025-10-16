const doctorController = require('../../src/controllers/doctorController');
const validation = require('../../src/utils/validation');

jest.mock('@prisma/client', () => {
  const prismaMock = {
    doctor: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => prismaMock),
    __prismaMock: prismaMock,
  };
});
const { __prismaMock: prisma } = require('@prisma/client');

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
        consultationMode: 'online',
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

  // ---------------- listDoctors ----------------
  describe('listDoctors', () => {
  beforeEach(() => {
    req.query = { consultation_mode: '' }; // <-- minimal fix
  });

  it('returns list of doctors successfully', async () => {
    prisma.doctor.findMany.mockResolvedValueOnce([{ id: 1, name: 'Dr A' }]);
    await doctorController.listDoctors(req, res);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ id: 1, name: 'Dr A' }],
      message: 'Doctors fetched successfully',
      success: true,
    });
  }, 10000);

it('returns empty list when no doctors', async () => {
  prisma.doctor.findMany.mockResolvedValueOnce([]);
  await doctorController.listDoctors(req, res);

  expect(res.json).toHaveBeenCalledWith({
    data: [],
    message: 'Doctors fetched successfully', // <-- updated
    success: true,
  });
}, 10000);


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
