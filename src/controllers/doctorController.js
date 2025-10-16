const { PrismaClient } = require('@prisma/client');
const { validateDoctorCreate, validateTimeSlotCreate, validateSlotsFetchQuery } = require('../utils/validation');
const { getDatabaseNow, parseToMinutes, toTimeString } = require('../utils/time');
const { 
  getNowUtc,
  getEarliestAvailableSlots,
  parseDoctorQuery,
  mapAndSortDoctorsByEarliestSlot,
  sortByConsultationModePriority
} = require("../utils/helper");
const redis = require('../lib/redisClient');

const prisma = new PrismaClient();

const selectDoctorFields = {
  id: true,
  name: true,
  email: true,
  phone: true,
  specialization: true,
  consultationMode: true,
  experience: true,
  bio: true,
  imageUrl: true,
};

// Add a new doctor 
const createDoctor = async (req, res) => {
  try {
    // Validate incoming request body
    const { error } = validateDoctorCreate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    // Create new doctor in the database
    const doctor = await prisma.doctor.create({
      data: { ...req.body },
      select: selectDoctorFields,
    });

    // Invalidate all cached doctor lists in Redis
try {
  let cursor = "0";
  let deletedCount = 0;

  do {
    const [newCursor, keys] = await redis.scan(cursor, {
      match: "doctors:list*",
      count: 100,
    });

    cursor = newCursor;

    if (keys.length > 0) {
      const res = await redis.unlink(...keys);
      deletedCount += res;
    }
  } while (cursor !== "0");

} catch (err) {
  console.warn("Redis cache invalidation failed:", err.message);
}


    // Respond with created doctor data
    return res.status(201).json({
      success: true,
      message: 'Doctor created successfully',
      data: { doctor },
    });
  } catch (e) {
    // Handle unique constraint violation (email)
    if (e?.code === 'P2002') return res.status(409).json({ success: false, error: 'Doctor with this email already exists' });

    console.error('createDoctor error:', e);
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
    const cacheKey = `doctors:list:${normalizedFilters}:page:${pagination.page}:${pagination.take}:${availableNormalized || "none"}`;

    const ttl = availableNormalized ? 30 : 3600;

    // ✅ Try cache first
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      console.warn("Redis GET failed, continuing without cache:", err.message);
    }

    // ✅ Case 1: Handle "earliest" availability first
    if (availableNormalized === "earliest") {
      const nowData = await getNowUtc(prisma);

      // Step 1️⃣ - Get all available slots (future only)
      const futureSlots = await prisma.timeSlot.findMany({
        where: {
          status: "AVAILABLE",
          OR: [
            { date: { gt: nowData.todayUtc } },
            { AND: [{ date: nowData.todayUtc }, { startTime: { gt: nowData.currentHM } }] },
          ],
        },
        select: { doctorId: true, date: true, startTime: true, endTime: true, id: true },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      });

      // Step 2️⃣ - Get unique earliest slot per doctor
      const earliestByDoctor = new Map();
      futureSlots.forEach((slot) => {
        if (!earliestByDoctor.has(slot.doctorId)) earliestByDoctor.set(slot.doctorId, slot);
      });

      // Step 3️⃣ - Get doctor IDs who have slots
      const doctorIds = Array.from(earliestByDoctor.keys());
      if (doctorIds.length === 0) {
        const response = { success: true, data: [], message: "No doctors with available slots found" };
        try {
          await redis.set(cacheKey, JSON.stringify(response), { EX: ttl });
        } catch (err) {
          console.warn("Redis SET failed 1:", err.message);
        }
        return res.json(response);
      }

      // Step 4️⃣ - Apply search + filters ONLY on these doctors
      const doctors = await prisma.doctor.findMany({
        where: {
          id: { in: doctorIds },
          ...filters, // applies q, specialization, consultation_mode
        },
        select: selectDoctorFields,
        skip: pagination.skip,
        take: pagination.take,
      });

      // Step 5️⃣ - Map and sort final list by earliest slot
      let result = mapAndSortDoctorsByEarliestSlot(doctors, earliestByDoctor);

const consultation_mode = req.query.consultation_mode; // <-- ADD THIS


      // Step 6 - Sort by consultation mode priority (online/in_person first)
      result = sortByConsultationModePriority(result, consultation_mode);

      const response = {
        success: true,
        data: result,
        message: "Doctors fetched successfully (sorted by earliest availability)",
      };

      try {
        await redis.set(cacheKey, JSON.stringify(response), { EX: ttl });
      } catch (err) {
        console.warn("Redis SET failed 2:", err.message);
      }

      return res.json(response); 
    }

    // ✅ Case 2: Normal filters (no "earliest")
    const doctors = await prisma.doctor.findMany({
      where: filters,
      select: selectDoctorFields,
      skip: pagination.skip,
      take: pagination.take,
      orderBy: pagination.orderBy,
    });

    const consultation_mode = req.query.consultation_mode; // <-- ADD THIS

        // ✅ Sort by consultation mode priority
    const doctorsRes = sortByConsultationModePriority(doctors, consultation_mode);

    const response = {
      success: true,
      data: doctorsRes,
      message: "Doctors fetched successfully",
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), { EX: ttl });
    } catch (err) {
      console.warn("Redis SET failed 3:", err.message);
    }

    return res.json(response);
  } catch (err) {
    console.error("listDoctors error:", err);
    return res.status(err.status || 500).json({
      success: false,
      error: err.status ? err.message : "Internal server error",
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
      console.warn("Redis GET failed, fetching from DB:", err.message);
    }

    // Fetch doctor from DB if not cached
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: selectDoctorFields,
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: "Doctor not found",
      });
    }

    const response = {
      success: true,
      data: doctor,
      message: "Doctor fetched successfully",
    };

    // Store fetched doctor in Redis cache
    try {
      await redis.set(cacheKey, JSON.stringify(response), "EX", TTL);
    } catch (err) {
      console.warn("Redis SET failed:", err.message);
    }

    return res.json(response);
  } catch (e) {
    console.error("getDoctorById error:", e);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};

// Create multiple 30-minute time slots for a doctor within a specified timeframe
const createTimeSlot = async (req, res) => {
  try {
    const { doctorId } = req.params; 
    if (!doctorId) return res.status(400).json({ success: false, error: "doctorId is required in path" });

    // Check if doctor exists
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { id: true } });
    if (!doctor) return res.status(404).json({ success: false, error: "Doctor not found" });

    // Validate request body
    const { error } = validateTimeSlotCreate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { date, startTime, endTime } = req.body;

    const startMinutes = parseToMinutes(startTime);
    const endMinutes = parseToMinutes(endTime);

    // Validate timeframe
    if (endMinutes <= startMinutes) {
      return res.status(400).json({ success: false, error: "endTime must be greater than startTime" });
    }
    if ((endMinutes - startMinutes) % 30 !== 0) {
      return res.status(400).json({ success: false, error: "Timeframe must be a multiple of 30 minutes" });
    }

    // Parse date
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, error: "Invalid date" });
    }

    // ✅ Prevent past dates & past times
    const now = new Date();
    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);

    if (parsedDate < todayUTC) {
      return res.status(400).json({ success: false, error: "Cannot create time slots for past dates" });
    }

    if (parsedDate.getTime() === todayUTC.getTime()) {
      // Today → ensure start time is in the future
      const nowMinutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (startMinutes <= nowMinutesUTC) {
        return res.status(400).json({ success: false, error: "Cannot create time slots in the past for today" });
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
      return res.status(409).json({ success: false, error: "Requested timeframe overlaps with existing slots", data: conflicts });
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
      orderBy: { startTime: "asc" },
    });

    // Invalidate relevant Redis caches
try {
  let cursor = "0";

  do {
    const [newCursor, keys] = await redis.scan(cursor, {
      match: "doctors:list*",
      count: 100,
    });

    cursor = newCursor ?? "0";

    if (keys.length > 0) {
      await redis.unlink(...keys);
    }
  } while (cursor !== "0");

  // Delete individual doctor cache key if exists
  const doctorCacheKey = `doctor:${doctorId}`;
  await redis.unlink(doctorCacheKey);
} catch (err) {
  console.warn("Redis cache invalidation failed:", err.message);
}


    // Return created slots
    return res.status(201).json({
      success: true,
      message: "Time slots created successfully",
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
    console.error("createTimeSlot error:", e);
    if (e.code === "P2002") {
      return res.status(409).json({ success: false, error: "One or more slots already exist for this timeframe" });
    }
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};


// Fetch available (unbooked & unlocked) slots for a doctor on a given date or date range
const getAvailableSlots = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date, start, end } = req.query;

    // required path param
    if (!doctorId) {
      return res.status(400).json({ success: false, error: "doctorId is required in path" });
    }

    // validate query params (expects validateSlotsFetchQuery to accept {date, start, end})
    const { error } = validateSlotsFetchQuery({ date, start, end });
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    // check doctor exists
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { id: true } });
    if (!doctor) {
      return res.status(404).json({ success: false, error: "Doctor not found" });
    }

    // current UTC date/time from DB 
    const nowUtc = await getDatabaseNow(prisma);
    const todayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
    const todayStr = todayUtc.toISOString().split("T")[0];
    const currentTimeStr = `${String(nowUtc.getUTCHours()).padStart(2, "0")}:${String(nowUtc.getUTCMinutes()).padStart(2, "0")}`;

    // determine date range
    let startDate, endDate;
    if (date) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ success: false, error: "Invalid date" });
      if (parsed < todayUtc) return res.status(400).json({ success: false, error: "date cannot be in the past" });
      startDate = parsed;
      endDate = parsed;
    } else {
      startDate = new Date(`${start}T00:00:00.000Z`);
      endDate = new Date(`${end}T00:00:00.000Z`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid start or end date" });
      }
      if (startDate < todayUtc) return res.status(400).json({ success: false, error: "start cannot be in the past" });
      if (endDate < startDate) return res.status(400).json({ success: false, error: "end cannot be before start" });
    }

    // fetch slots in one query (status = AVAILABLE)
    const slots = await prisma.timeSlot.findMany({
      where: {
        doctorId,
        date: { gte: startDate, lte: endDate },
        status: "AVAILABLE",
      },
      select: { id: true, doctorId: true, date: true, startTime: true, endTime: true, status: true },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });

    // Filter out slots that already started today (only remove today's past slots)
    const filtered = slots.filter((slot) => {
      const slotDateStr = slot.date.toISOString().split("T")[0];
      if (slotDateStr === todayStr) {
        return slot.startTime > currentTimeStr; // keep only future slots for today
      }
      return true; // keep all other days
    });

    // map to desired response shape (flat array)
    const data = filtered.map((slot) => ({
      slotId: slot.id,
      doctorId: slot.doctorId,
      date: slot.date.toISOString().split("T")[0], // YYYY-MM-DD
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: slot.status,
    }));

    return res.json({
      success: true,
      message: data.length > 0 ? "Available slots fetched successfully" : "No available slots",
      data,
    });
  } catch (e) {
    console.error("getAvailableSlots error:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
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
        error: "doctorId and slotId are required",
      });
    }

    // Fetch the slot and ensure it belongs to the doctor
    const slot = await prisma.timeSlot.findFirst({
      where: { id: slotId, doctorId },
      select: { id: true, status: true, lockedBy: true, lockExpires: true },
    });

    if (!slot) {
      return res.status(404).json({ success: false, error: "Time slot not found" });
    }

    // Reject if slot is already booked
    if (slot.status === "BOOKED") {
      return res.status(409).json({ success: false, error: "Time slot already booked" });
    }

    if (slot.status === "LOCKED") {
      return res.status(409).json({ success: false, error: "Time slot already locked" });
    }

    const nowUtc = await getDatabaseNow(prisma);

    // Check if slot is currently locked by another user
    const isLockedByOther =
      slot.status === "LOCKED" &&
      slot.lockedBy &&
      slot.lockedBy !== userId &&
      slot.lockExpires &&
      slot.lockExpires > nowUtc;

    if (isLockedByOther) {
      return res.status(409).json({ success: false, error: "Time slot is temporarily locked" });
    }

    // Limit active locks per user (e.g., max 3)
    const activeLocks = await prisma.timeSlot.count({
      where: { lockedBy: userId, status: "LOCKED", lockExpires: { gt: nowUtc } },
    });

    if (activeLocks >= 3) {
      return res.status(429).json({
        success: false,
        error: "Lock limit reached. Complete or release existing locks.",
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
        OR: [
          { status: "AVAILABLE" },
          { lockedBy: userId },
          { lockExpires: { lt: nowUtc } },
        ],
      },
      data: {
        status: "LOCKED",
        lockedBy: userId,
        lockedAt: nowUtc,       // ✅ Added to store when the lock was created
        lockExpires: expiresAt,
      },
    });

    if (updateResult.count !== 1) {
      return res.status(409).json({
        success: false,
        error: "Unable to lock slot. It may be locked or booked.",
      });
    }

    // Invalidate relevant Redis caches
    try {
      let cursor = "0";
      do {
        const result = await redis.scan(cursor, { match: "doctors:list:*", count: 100 });
        cursor = result.cursor ?? "0";

        if (result.keys.length > 0) {
          await redis.unlink(...result.keys);
        }
      } while (cursor !== "0");

      const doctorCacheKey = `doctor:${doctorId}`;
      await redis.unlink(doctorCacheKey);
    } catch (err) {
      console.warn("Redis cache invalidation failed:", err.message);
    }

    // Respond with locked slot info
    return res.status(200).json({
      success: true,
      message: "Slot locked",
      data: {
        slotId,
        doctorId,
        lockedBy: userId,
        lockedAt: nowUtc.toISOString(),   // ✅ Include lockedAt in response
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (e) {
    console.error("lockTimeSlot error:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
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
        error: "doctorId and slotId are required in path",
      });
    }

    // Fetch slot with related doctor info
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
            experience: true,
          },
        },
      },
    });

    // Handle slot not found
    if (!slot) {
      return res.status(404).json({
        success: false,
        error: "Slot not found",
      });
    }

    // Prepare response with consistent lockExpires format
    return res.status(200).json({
      success: true,
      message: "Slot fetched successfully",
      data: {
        slotId: slot.id,
        doctorId: slot.doctorId,
        date: slot.date.toISOString().split("T")[0],
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.status,
        lockExpires: slot.lockExpires ? slot.lockExpires.toISOString() : null,
        lockedBy: slot.lockedBy,
        doctor: slot.doctor,
      },
    });
  } catch (e) {
    console.error("getSlotById error:", e);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};



module.exports = { 
  createDoctor, 
  listDoctors, 
  getDoctorById, 
  createTimeSlot, 
  getAvailableSlots,
  lockTimeSlot,
  getSlotById
 };
