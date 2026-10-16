const prisma = require('../lib/prisma');
const { getDatabaseNow } = require('../utils/time');

const APPOINTMENT_STATUSES = ['BOOKED', 'COMPLETED', 'CANCELLED', 'RESCHEDULED'];
const patientListSelect = { id: true, name: true, email: true, phone: true, createdAt: true };
const patientProfileSelect = { name: true, email: true };
const todayAppointmentSelect = {
  id: true,
  status: true,
  contactEmail: true,
  patientName: true,
  patientPhone: true,
  doctor: { select: { name: true } },
  timeSlot: { select: { startTime: true } },
};
const patientHistoryAppointmentSelect = {
  id: true,
  status: true,
  doctor: { select: { name: true } },
  timeSlot: { select: { date: true, startTime: true } },
};
const doctorProfileSelect = { id: true, name: true, specialization: true };
const doctorUpcomingAppointmentSelect = {
  id: true,
  patientName: true,
  contactEmail: true,
  patientPhone: true,
  timeSlot: { select: { date: true, startTime: true, endTime: true } },
};

const getPagination = (query) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 10)),
});

const getCurrentTime = async () => {
  const now = await getDatabaseNow(prisma);
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .reduce((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = part.value;
      return parts;
    }, {});

  return {
    today: new Date(
      Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day))
    ),
    time: `${dateParts.hour}:${dateParts.minute}`,
  };
};

const sendPagedResponse = async (model, where, select, orderBy, req, res) => {
  const { page, limit } = getPagination(req.query);
  const [data, total] = await Promise.all([
    model.findMany({ where, select, orderBy, skip: (page - 1) * limit, take: limit }),
    model.count({ where }),
  ]);
  return res.json({ success: true, data, page, limit, total, hasMore: page * limit < total });
};

const getStats = async (_req, res) => {
  try {
    const [totalUsers, totalAppointments, totalDoctors] = await Promise.all([
      prisma.user.count(),
      prisma.appointment.count(),
      prisma.doctor.count(),
    ]);
    return res.json({ success: true, data: { totalUsers, totalAppointments, totalDoctors } });
  } catch (err) {
    console.error('getStats error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load admin statistics' });
  }
};

const getTodayAppointments = async (req, res) => {
  try {
    const { today } = await getCurrentTime();
    const status = String(req.query.status || 'BOOKED').toUpperCase();
    const where = { timeSlot: { is: { date: today } } };
    if (status !== 'ALL' && APPOINTMENT_STATUSES.includes(status)) where.status = status;
    return sendPagedResponse(
      prisma.appointment,
      where,
      todayAppointmentSelect,
      [{ timeSlot: { date: 'asc' } }, { timeSlot: { startTime: 'asc' } }],
      req,
      res
    );
  } catch (err) {
    console.error('getTodayAppointments error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load today’s appointments' });
  }
};

const getPatients = async (req, res) => {
  try {
    return sendPagedResponse(
      prisma.user,
      { role: 'USER' },
      patientListSelect,
      { createdAt: 'desc' },
      req,
      res
    );
  } catch (err) {
    console.error('getPatients error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load patients' });
  }
};

const getPatientAppointments = async (req, res) => {
  try {
    const patient = await prisma.user.findFirst({
      where: { id: req.params.patientId, role: 'USER' },
      select: patientProfileSelect,
    });
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    const appointments = await prisma.appointment.findMany({
      where: { userId: req.params.patientId },
      select: patientHistoryAppointmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: { patient, appointments } });
  } catch (err) {
    console.error('getPatientAppointments error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load patient appointments' });
  }
};

const getUpcomingSlots = async (req, res) => {
  try {
    const { today, time } = await getCurrentTime();
    const where = {
      status: 'AVAILABLE',
      OR: [{ date: { gt: today } }, { AND: [{ date: today }, { startTime: { gt: time } }] }],
    };
    if (typeof req.query.doctorId === 'string' && req.query.doctorId)
      where.doctorId = req.query.doctorId;
    const select = {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      doctor: { select: { name: true, specialization: true, clinicName: true, city: true } },
    };
    return sendPagedResponse(
      prisma.timeSlot,
      where,
      select,
      [{ date: 'asc' }, { startTime: 'asc' }],
      req,
      res
    );
  } catch (err) {
    console.error('getUpcomingSlots error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load upcoming slots' });
  }
};

const getDoctorUpcomingAppointments = async (req, res) => {
  try {
    const { today, time } = await getCurrentTime();
    const doctor = await prisma.doctor.findUnique({
      where: { id: req.params.doctorId },
      select: doctorProfileSelect,
    });

    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
        status: 'BOOKED',
        timeSlot: {
          is: {
            OR: [{ date: { gt: today } }, { AND: [{ date: today }, { startTime: { gt: time } }] }],
          },
        },
      },
      select: doctorUpcomingAppointmentSelect,
      orderBy: [{ timeSlot: { date: 'asc' } }, { timeSlot: { startTime: 'asc' } }],
      take: 10,
    });

    return res.json({ success: true, data: { doctor, appointments } });
  } catch (err) {
    console.error('getDoctorUpcomingAppointments error:', err);
    return res
      .status(500)
      .json({ success: false, error: 'Unable to load upcoming doctor appointments' });
  }
};

module.exports = {
  getStats,
  getTodayAppointments,
  getPatients,
  getPatientAppointments,
  getUpcomingSlots,
  getDoctorUpcomingAppointments,
};
