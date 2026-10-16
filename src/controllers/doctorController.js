const prisma = require('../lib/prisma');
const {
  validateDoctorCreate,
  validateDoctorUpdate,
  validateTimeSlotCreate,
  validateBatchTimeSlotCreate,
  validateSlotsFetchQuery,
} = require('../utils/validation');
const { getDatabaseNow, parseToMinutes, toTimeString } = require('../utils/time');
const {
  WEEKDAY_GROUPS,
  getTodayUtc,
  validateTimeframeRange,
  buildTimeSegments,
  getMatchingDatesInRange,
  filterSchedulableDates,
  formatDateYmd,
  resolveBatchDateRange,
  releaseExpiredLocks,
  invalidateDoctorSlotCaches,
} = require('../utils/timeSlotHelpers');
const {
  getNowUtc,
  getEarliestAvailableSlots,
  getEarliestFutureSlots,
  parseDoctorQuery,
  mapAndSortDoctorsByEarliestSlot,
} = require('../utils/helper');
const redis = require('../lib/redisClient');

const selectDoctorDetails = {
  id: true,
  name: true,
  email: true,
  phone: true,
  specialization: true,
  consultationMode: true,
  consultationFee: true,
  languages: true,
  clinicName: true,
  city: true,
  experience: true,
  bio: true,
  imageUrl: true,
};

// The public directory also supplies the public profile pages. Keep the fields
// those pages render, but never expose a doctor's contact details or unused
// image URL in a list response.
const selectDoctorListFields = {
  id: true,
  name: true,
  specialization: true,
  consultationMode: true,
  consultationFee: true,
  languages: true,
  clinicName: true,
  city: true,
  experience: true,
  bio: true,
};

const invalidateDoctorCaches = async (doctorId) => {
  try {
    await invalidateDoctorSlotCaches(redis, doctorId);
  } catch (err) {
    console.warn('Redis cache invalidation failed:', err.message);
  }
};

// Add a new doctor
const createDoctor = async (req, res) => {
  try {
    // Validate incoming request body
    const { error, value } = validateDoctorCreate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    // Create new doctor in the database
    const doctor = await prisma.doctor.create({
      data: { ...(value || req.body), consultationMode: 'in_person' },
      select: selectDoctorDetails,
    });

    await invalidateDoctorCaches(doctor.id);

    // Respond with created doctor data
    return res.status(201).json({
      success: true,
      message: 'Doctor created successfully',
      data: { doctor },
    });
  } catch (e) {
    // Handle unique constraint violation (email)
    if (e?.code === 'P2002')
      return res
        .status(409)
        .json({ success: false, error: 'Doctor with this email already exists' });

    console.error('createDoctor error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Update an existing doctor
const updateDoctor = async (req, res) => {
  try {
    const doctorId = req.params.id;

    // Validate incoming request body
    const { error, value } = validateDoctorUpdate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    // Update doctor details in the database
    const doctor = await prisma.doctor.update({
      where: { id: doctorId },
      data: { ...(value || req.body), consultationMode: 'in_person' },
      select: selectDoctorDetails,
    });

    await invalidateDoctorCaches(doctor.id);

    return res.json({
      success: true,
      message: 'Doctor updated successfully',
      data: { doctor },
    });
  } catch (e) {
    if (e?.code === 'P2025')
      return res.status(404).json({ success: false, error: 'Doctor not found' });
    if (e?.code === 'P2002')
      return res
        .status(409)
        .json({ success: false, error: 'Doctor with this email already exists' });

    console.error('updateDoctor error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// List doctors with optional filters, availability, and earliest slot sorting with pagination (8 per page)
const listDoctors = async (req, res) => {
  try {
    // ✅ Parse query
    const { filters, pagination, availableNormalized } = parseDoctorQuery(req.query);

    // ✅ Build cache key
    const normalizedFilters = JSON.stringify(filters);
    const cacheKey = `doctors:list:v3:${normalizedFilters}:page:${pagination.page}:${pagination.take}:${availableNormalized || 'none'}`;

    // Availability is time-sensitive: a lock can expire between two requests.
    // Do not serve an availability result from cache, otherwise an expired lock
    // could remain hidden until the cache entry expires.
    const shouldCache = availableNormalized !== 'earliest';
    const ttl = 3600;

    // ✅ Try cache first
    if (shouldCache) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.warn('Redis GET failed, continuing without cache:', err.message);
      }
    }

    // ✅ Case 1: Handle "earliest" availability first
    if (availableNormalized === 'earliest') {
      const nowData = await getNowUtc(prisma);
      await releaseExpiredLocks(prisma, nowData.nowUtc, {
        date: { gte: nowData.todayUtc },
      });

      // MongoDB returns one earliest future slot per doctor, not every future slot.
      const earliestByDoctor = await getEarliestFutureSlots(prisma, nowData);

      // Step 3️⃣ - Get doctor IDs who have slots
      const doctorIds = Array.from(earliestByDoctor.keys());
      if (doctorIds.length === 0) {
        const response = {
          success: true,
          data: [],
          currentPage: pagination.page,
          pageSize: pagination.take,
          totalPages: 0,
          totalResults: 0,
          message: 'No doctors with available slots found',
        };
        return res.json(response);
      }

      // Step 4️⃣ - Apply search + filters ONLY on these doctors
      const where = {
        id: { in: doctorIds },
        ...filters,
      };
      const [doctors, totalResults] = await Promise.all([
        prisma.doctor.findMany({
          where,
          select: selectDoctorListFields,
          skip: pagination.skip,
          take: pagination.take,
        }),
        prisma.doctor.count({ where }),
      ]);

      // Step 5️⃣ - Map and sort final list by earliest slot
      let result = mapAndSortDoctorsByEarliestSlot(doctors, earliestByDoctor);

      const response = {
        success: true,
        data: result,
        currentPage: pagination.page,
        pageSize: pagination.take,
        totalPages: Math.ceil(totalResults / pagination.take),
        totalResults,
        message: 'Doctors fetched successfully (sorted by earliest availability)',
      };

      return res.json(response);
    }

    // ✅ Case 2: Normal filters (no "earliest")
    const [doctors, totalResults] = await Promise.all([
      prisma.doctor.findMany({
        where: filters,
        select: selectDoctorListFields,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: pagination.orderBy,
      }),
      prisma.doctor.count({ where: filters }),
    ]);

    const response = {
      success: true,
      data: doctors,
      currentPage: pagination.page,
      pageSize: pagination.take,
      totalPages: Math.ceil(totalResults / pagination.take),
      totalResults,
      message: 'Doctors fetched successfully',
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), { ex: ttl });
    } catch (err) {
      console.warn('Redis SET failed 3:', err.message);
    }

    return res.json(response);
  } catch (err) {
    console.error('listDoctors error:', err);
    return res.status(err.status || 500).json({
      success: false,
      error: err.status ? err.message : 'Internal server error',
    });
  }
};

// Get single doctor by ID
const getDoctorById = async (req, res) => {
  try {
    const doctorId = req.params.id;
    const cacheKey = `doctor:${doctorId}`; // Unique cache key for this doctor
    const TTL = 3600; // Cache TTL: 1 hour, profile changes rarely

    // Try fetching doctor from Redis cache first
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached)); // Return cached response
      }
    } catch (err) {
      console.warn('Redis GET failed, fetching from DB:', err.message);
    }

    // Fetch doctor from DB if not cached
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: selectDoctorDetails,
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor not found',
      });
    }

    const response = {
      success: true,
      data: doctor,
      message: 'Doctor fetched successfully',
    };

    // Store fetched doctor in Redis cache
    try {
      await redis.set(cacheKey, JSON.stringify(response), { ex: TTL });
    } catch (err) {
      console.warn('Redis SET failed:', err.message);
    }

    return res.json(response);
  } catch (e) {
    console.error('getDoctorById error:', e);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Create multiple 30-minute time slots for a doctor within a specified timeframe
const createTimeSlot = async (req, res) => {
  try {
    const { doctorId } = req.params;
    if (!doctorId)
      return res.status(400).json({ success: false, error: 'doctorId is required in path' });

    // Check if doctor exists
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true },
    });
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });

    // Validate request body
    const { error } = validateTimeSlotCreate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { date, startTime, endTime } = req.body;

    const startMinutes = parseToMinutes(startTime);
    const endMinutes = parseToMinutes(endTime);

    // Validate timeframe
    if (endMinutes <= startMinutes) {
      return res
        .status(400)
        .json({ success: false, error: 'endTime must be greater than startTime' });
    }
    if ((endMinutes - startMinutes) % 30 !== 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Timeframe must be a multiple of 30 minutes' });
    }

    // Parse date
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }

    // ✅ Prevent past dates & past times
    const now = new Date();
    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);

    if (parsedDate < todayUTC) {
      return res
        .status(400)
        .json({ success: false, error: 'Cannot create time slots for past dates' });
    }

    if (parsedDate.getTime() === todayUTC.getTime()) {
      // Today → ensure start time is in the future
      const nowMinutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (startMinutes <= nowMinutesUTC) {
        return res
          .status(400)
          .json({ success: false, error: 'Cannot create time slots in the past for today' });
      }
    }

    // Check for overlapping slots
    const conflicts = await prisma.timeSlot.findMany({
      where: {
        doctorId,
        date: parsedDate,
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
      select: { id: true, startTime: true, endTime: true },
    });
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Requested timeframe overlaps with existing slots',
        data: conflicts,
      });
    }

    // Generate 30-min segments
    const segments = [];
    for (let cursor = startMinutes; cursor < endMinutes; cursor += 30) {
      segments.push({ startTime: toTimeString(cursor), endTime: toTimeString(cursor + 30) });
    }

    // Create slots in DB
    await prisma.timeSlot.createMany({
      data: segments.map((s) => ({
        doctorId,
        date: parsedDate,
        startTime: s.startTime,
        endTime: s.endTime,
      })),
    });

    // Fetch created slots
    const createdSlots = await prisma.timeSlot.findMany({
      where: { doctorId, date: parsedDate, startTime: { in: segments.map((s) => s.startTime) } },
      select: { id: true, doctorId: true, startTime: true, endTime: true, status: true },
      orderBy: { startTime: 'asc' },
    });

    // Return created slots
    return res.status(201).json({
      success: true,
      message: 'Time slots created successfully',
      data: createdSlots.map((slot) => ({
        slotId: slot.id,
        doctorId: slot.doctorId,
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
      })),
    });
  } catch (e) {
    console.error('createTimeSlot error:', e);
    if (e.code === 'P2002') {
      return res
        .status(409)
        .json({ success: false, error: 'One or more slots already exist for this timeframe' });
    }
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Create 30-minute time slots across multiple days using a weekly day-group pattern
const createBatchTimeSlot = async (req, res) => {
  try {
    const { doctorId } = req.params;
    if (!doctorId)
      return res.status(400).json({ success: false, error: 'doctorId is required in path' });

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true },
    });
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });

    const { error } = validateBatchTimeSlotCreate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { scheduleType, group, startTime, endTime } = req.body;

    const timeframe = validateTimeframeRange(startTime, endTime, parseToMinutes);
    if (timeframe.error) {
      return res.status(400).json({ success: false, error: timeframe.error });
    }

    const dateRange = resolveBatchDateRange(req.body.startDate, req.body.endDate);
    const { startDate, endDate, parsedStartDate, parsedEndDate } = dateRange;

    if (Number.isNaN(parsedStartDate.getTime()) || Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid startDate or endDate' });
    }

    const todayUTC = getTodayUtc();
    if (parsedEndDate < todayUTC) {
      return res
        .status(400)
        .json({ success: false, error: 'Cannot create time slots for past dates' });
    }

    const weekdayNums = WEEKDAY_GROUPS[group];
    const matchingDates = getMatchingDatesInRange(parsedStartDate, parsedEndDate, weekdayNums);
    if (matchingDates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No matching days found for the selected group within the given date range',
      });
    }

    const schedulableDates = filterSchedulableDates(matchingDates, timeframe.startMinutes);
    if (schedulableDates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No schedulable dates remain after excluding past dates and times',
      });
    }

    const segments = buildTimeSegments(timeframe.startMinutes, timeframe.endMinutes, toTimeString);

    const conflicts = await prisma.timeSlot.findMany({
      where: {
        doctorId,
        date: { in: schedulableDates },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
      select: { id: true, date: true, startTime: true, endTime: true },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });

    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Requested timeframe overlaps with existing slots on one or more dates',
        data: conflicts.map((slot) => ({
          slotId: slot.id,
          date: formatDateYmd(slot.date),
          startTime: slot.startTime,
          endTime: slot.endTime,
        })),
      });
    }

    const slotData = schedulableDates.flatMap((date) =>
      segments.map((segment) => ({
        doctorId,
        date,
        startTime: segment.startTime,
        endTime: segment.endTime,
      }))
    );

    await prisma.timeSlot.createMany({ data: slotData });

    const createdSlots = await prisma.timeSlot.findMany({
      where: {
        doctorId,
        date: { in: schedulableDates },
        startTime: { in: segments.map((s) => s.startTime) },
      },
      select: {
        id: true,
        doctorId: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });

    return res.status(201).json({
      success: true,
      message: 'Batch time slots created successfully',
      data: {
        scheduleType,
        group,
        startDate,
        endDate,
        startTime,
        endTime,
        datesProcessed: schedulableDates.length,
        slotsCreated: createdSlots.length,
        slots: createdSlots.map((slot) => ({
          slotId: slot.id,
          doctorId: slot.doctorId,
          date: formatDateYmd(slot.date),
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status,
        })),
      },
    });
  } catch (e) {
    console.error('createBatchTimeSlot error:', e);
    if (e.code === 'P2002') {
      return res
        .status(409)
        .json({ success: false, error: 'One or more slots already exist for this timeframe' });
    }
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Fetch available (unbooked & unlocked) slots for a doctor on a given date or date range
const getAvailableSlots = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date, start, end } = req.query;

    // required path param
    if (!doctorId) {
      return res.status(400).json({ success: false, error: 'doctorId is required in path' });
    }

    // validate query params (expects validateSlotsFetchQuery to accept {date, start, end})
    const { error } = validateSlotsFetchQuery({ date, start, end });
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    // check doctor exists
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true },
    });
    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor not found' });
    }

    // current UTC date/time from DB
    const nowUtc = await getDatabaseNow(prisma);
    const todayUtc = new Date(
      Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate())
    );
    const todayStr = todayUtc.toISOString().split('T')[0];
    const currentTimeStr = `${String(nowUtc.getUTCHours()).padStart(2, '0')}:${String(nowUtc.getUTCMinutes()).padStart(2, '0')}`;

    // determine date range
    let startDate, endDate;
    if (date) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()))
        return res.status(400).json({ success: false, error: 'Invalid date' });
      if (parsed < todayUtc)
        return res.status(400).json({ success: false, error: 'date cannot be in the past' });
      startDate = parsed;
      endDate = parsed;
    } else {
      startDate = new Date(`${start}T00:00:00.000Z`);
      endDate = new Date(`${end}T00:00:00.000Z`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid start or end date' });
      }
      if (startDate < todayUtc)
        return res.status(400).json({ success: false, error: 'start cannot be in the past' });
      if (endDate < startDate)
        return res.status(400).json({ success: false, error: 'end cannot be before start' });
    }

    await releaseExpiredLocks(prisma, nowUtc, {
      doctorId,
      date: { gte: startDate, lte: endDate },
    });

    // Expired locks were normalized above, so only physically available slots
    // are returned to every calendar consumer.
    const slots = await prisma.timeSlot.findMany({
      where: {
        doctorId,
        date: { gte: startDate, lte: endDate },
        status: 'AVAILABLE',
      },
      select: {
        id: true,
        doctorId: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });

    // Filter out slots that already started today (only remove today's past slots)
    const filtered = slots.filter((slot) => {
      const slotDateStr = slot.date.toISOString().split('T')[0];
      if (slotDateStr === todayStr) {
        return slot.startTime > currentTimeStr; // keep only future slots for today
      }
      return true; // keep all other days
    });

    // map to desired response shape (flat array)
    const data = filtered.map((slot) => ({
      slotId: slot.id,
      doctorId: slot.doctorId,
      date: slot.date.toISOString().split('T')[0], // YYYY-MM-DD
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: 'AVAILABLE',
    }));

    return res.json({
      success: true,
      message: data.length > 0 ? 'Available slots fetched successfully' : 'No available slots',
      data,
    });
  } catch (e) {
    console.error('getAvailableSlots error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Lock a doctor's time slot for 5 minutes by the authenticated user
const lockTimeSlot = async (req, res) => {
  try {
    const { doctorId, slotId } = req.params;
    const userId = req.user?.id;

    // Validate required path params
    if (!doctorId || !slotId) {
      return res.status(400).json({
        success: false,
        error: 'doctorId and slotId are required',
      });
    }

    const nowUtc = await getDatabaseNow(prisma);
    await releaseExpiredLocks(prisma, nowUtc, { id: slotId, doctorId });

    // Fetch the slot after normalizing any expired locks for this doctor.
    const slot = await prisma.timeSlot.findFirst({
      where: { id: slotId, doctorId },
      select: { id: true, status: true, lockedBy: true, lockExpires: true },
    });

    if (!slot) {
      return res.status(404).json({ success: false, error: 'Time slot not found' });
    }

    // Reject if slot is already booked
    if (slot.status === 'BOOKED') {
      return res.status(409).json({ success: false, error: 'Time slot already booked' });
    }

    // A lock is active only until its expiry time. A missing expiry on a locked
    // slot is treated as invalid state and is not claimable automatically.
    if (slot.status === 'LOCKED' && (!slot.lockExpires || slot.lockExpires > nowUtc)) {
      return res.status(409).json({ success: false, error: 'Time slot already locked' });
    }

    // Limit active locks per user (e.g., max 3)
    const activeLocks = await prisma.timeSlot.count({
      where: { lockedBy: userId, status: 'LOCKED', lockExpires: { gt: nowUtc } },
    });

    if (activeLocks >= 3) {
      return res.status(429).json({
        success: false,
        error: 'Lock limit reached. Complete or release existing locks.',
      });
    }

    // Calculate lock expiration timestamp (5 minutes)
    const lockDurationMs = 5 * 60 * 1000;
    const expiresAt = new Date(nowUtc.getTime() + lockDurationMs);

    // Atomic lock attempt
    const updateResult = await prisma.timeSlot.updateMany({
      where: {
        id: slotId,
        doctorId,
        OR: [{ status: 'AVAILABLE' }, { status: 'LOCKED', lockExpires: { lte: nowUtc } }],
      },
      data: {
        status: 'LOCKED',
        lockedBy: userId,
        lockedAt: nowUtc, // ✅ Added to store when the lock was created
        lockExpires: expiresAt,
      },
    });

    if (updateResult.count !== 1) {
      return res.status(409).json({
        success: false,
        error: 'Unable to lock slot. It may be locked or booked.',
      });
    }

    // Respond with locked slot info
    return res.status(200).json({
      success: true,
      message: 'Slot locked',
      data: {
        slotId,
        doctorId,
        lockedBy: userId,
        lockedAt: nowUtc.toISOString(), // ✅ Include lockedAt in response
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (e) {
    console.error('lockTimeSlot error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Fetch a specific time slot by doctor and slot ID, including doctor info
const getSlotById = async (req, res) => {
  try {
    const { doctorId, slotId } = req.params;

    // Validate required path parameters
    if (!doctorId || !slotId) {
      return res.status(400).json({
        success: false,
        error: 'doctorId and slotId are required in path',
      });
    }

    const nowUtc = await getDatabaseNow(prisma);
    await releaseExpiredLocks(prisma, nowUtc, { id: slotId, doctorId });

    // Fetch slot after normalizing expired locks for this doctor.
    const slot = await prisma.timeSlot.findFirst({
      where: { id: slotId, doctorId },
      select: {
        id: true,
        doctorId: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
        lockExpires: true,
        lockedBy: true,
        doctor: {
          select: {
            name: true,
            specialization: true,
            consultationMode: true,
            consultationFee: true,
            languages: true,
            clinicName: true,
            city: true,
            experience: true,
          },
        },
      },
    });

    // Handle slot not found
    if (!slot) {
      return res.status(404).json({
        success: false,
        error: 'Slot not found',
      });
    }

    // Prepare response with consistent lockExpires format
    return res.status(200).json({
      success: true,
      message: 'Slot fetched successfully',
      data: {
        slotId: slot.id,
        doctorId: slot.doctorId,
        date: slot.date.toISOString().split('T')[0],
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
        lockExpires: slot.lockExpires ? slot.lockExpires.toISOString() : null,
        lockedBy: slot.lockedBy,
        doctor: slot.doctor,
      },
    });
  } catch (e) {
    console.error('getSlotById error:', e);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

module.exports = {
  createDoctor,
  updateDoctor,
  listDoctors,
  getDoctorById,
  createTimeSlot,
  createBatchTimeSlot,
  getAvailableSlots,
  lockTimeSlot,
  getSlotById,
};
