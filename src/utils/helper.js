const { getDatabaseNow } = require("./time");

const parseDoctorQuery = (query) => {
  const { page, consultation_mode, available, sortBy, specialization, q } = query;
  const filters = { consultationMode: 'in_person' };
  const errors = [];

  // ✅ Page validation
  const pageNum = page ? parseInt(page, 10) : 1;
  if (isNaN(pageNum) || pageNum <= 0) {
    errors.push({ status: 400, message: "Invalid page number. Must be a positive integer." });
  }

  // ✅ Fixed per-page
  const take = 8;
  const pagination = {
    page: pageNum,
    take,
    skip: (pageNum - 1) * take,
  };

  // The public catalogue supports in-person consultations only.
  if (consultation_mode && consultation_mode !== 'in_person') {
    errors.push({ status: 400, message: 'Only in_person consultation_mode is supported.' });
  }


  // ✅ Available filter
  let availableNormalized = null;
  if (available) {
    switch (available) {
      case "earliest":
        availableNormalized = "earliest";
        break;
      case "true":
        filters.available = true;
        break;
      case "false":
        filters.available = false;
        break;
      default:
        errors.push({ status: 400, message: "Invalid available value. Use earliest, true, or false." });
    }
  }

  // ✅ Specialization filter (MongoDB: case-sensitive contains)
  if (specialization) {
    filters.specialization = { contains: String(specialization) };
  }

  // ✅ Search query filter (MongoDB: case-sensitive contains)
  if (q) {
    const term = String(q);
  
    filters.OR = [
      {
        name: {
          contains: term,
          mode: "insensitive",
        },
      },
      {
        specialization: {
          contains: term,
          mode: "insensitive",
        },
      },
      {
        bio: {
          contains: term,
          mode: "insensitive",
        },
      },
    ];
  }

  const allowedSorts = {
    name: { name: "asc" },
    createdAt: { createdAt: "desc" }
  };
  const sortKey = sortBy && allowedSorts[sortBy] ? sortBy : "createdAt";
  pagination.orderBy = allowedSorts[sortKey];

  if (errors.length) throw errors[0];
  return { filters, pagination, availableNormalized };
};


// Slot dates are calendar dates and slot times are India-local wall-clock times.
// Keep this aligned with the admin upcoming-slots query so both surfaces agree
// on whether a same-day slot is still bookable.
const getNowInIndia = async (prisma) => {
  const nowUtc = await getDatabaseNow(prisma);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(nowUtc)
    .reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});

  return {
    nowUtc,
    // Dates are stored as UTC midnight, while representing an Indian calendar date.
    todayUtc: new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))),
    currentHM: `${parts.hour}:${parts.minute}`,
  };
};

const getEarliestAvailableSlots = async (prisma, doctorIds, nowData) => {
  const { todayUtc, currentHM } = nowData;

  const futureSlots = await prisma.timeSlot.findMany({
    where: {
      doctorId: { in: doctorIds },
      status: "AVAILABLE",
      OR: [
        { date: { gt: todayUtc } },
        { AND: [{ date: todayUtc }, { startTime: { gt: currentHM } }] },
      ],
    },
    select: { id: true, doctorId: true, date: true, startTime: true, endTime: true },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  const earliestByDoctor = new Map();
  futureSlots.forEach(slot => {
    if (!earliestByDoctor.has(slot.doctorId)) earliestByDoctor.set(slot.doctorId, slot);
  });

  return earliestByDoctor;
};

const getEarliestFutureSlots = async (prisma, nowData) => {
  const today = { $date: nowData.todayUtc.toISOString() };
  try {
    const rows = await prisma.timeSlot.aggregateRaw({
      pipeline: [
        {
          $match: {
            status: 'AVAILABLE',
            $or: [
              { date: { $gt: today } },
              { date: today, startTime: { $gt: nowData.currentHM } },
            ],
          },
        },
        { $project: { _id: 1, doctorId: 1, date: 1, startTime: 1, endTime: 1 } },
        { $sort: { date: 1, startTime: 1, _id: 1 } },
        { $group: { _id: '$doctorId', slot: { $first: '$$ROOT' } } },
        {
          $project: {
            _id: 0,
            doctorId: { $toString: '$_id' },
            slotId: { $toString: '$slot._id' },
            date: { $dateToString: { format: '%Y-%m-%d', date: '$slot.date', timezone: 'UTC' } },
            startTime: '$slot.startTime',
            endTime: '$slot.endTime',
          },
        },
      ],
    });

    return new Map(rows.map((row) => [row.doctorId, {
      id: row.slotId,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
    }]));
  } catch (error) {
    console.warn('Earliest-slot aggregation failed; using the Prisma query:', error.message);
    const slots = await prisma.timeSlot.findMany({
      where: {
        status: 'AVAILABLE',
        OR: [
          { date: { gt: nowData.todayUtc } },
          { AND: [{ date: nowData.todayUtc }, { startTime: { gt: nowData.currentHM } }] },
        ],
      },
      select: { id: true, doctorId: true, date: true, startTime: true, endTime: true },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });

    const earliestByDoctor = new Map();
    for (const slot of slots) {
      if (!earliestByDoctor.has(slot.doctorId)) earliestByDoctor.set(slot.doctorId, slot);
    }
    return earliestByDoctor;
  }
};

const mapAndSortDoctorsByEarliestSlot = (doctors, earliestByDoctor) => {
  return doctors
    .map((doc) => {
      const slot = earliestByDoctor.get(doc.id);
      return {
        ...doc,
        earliestAvailableSlot: slot
          ? {
              slotId: slot.id,
              date: new Date(slot.date).toISOString().slice(0, 10),
              startTime: slot.startTime,
              endTime: slot.endTime,
            }
          : null,
      };
    })
    .sort((a, b) => {
      const sa = a.earliestAvailableSlot;
      const sb = b.earliestAvailableSlot;

      if (!sa && !sb) return 0;
      if (!sa) return 1;
      if (!sb) return -1;

      const da = new Date(sa.date).getTime();
      const db = new Date(sb.date).getTime();
      if (da !== db) return da - db;

      return sa.startTime.localeCompare(sb.startTime);
    });
};

module.exports = {
  parseDoctorQuery,
  getNowInIndia,
  getEarliestAvailableSlots,
  getEarliestFutureSlots,
  mapAndSortDoctorsByEarliestSlot
};
