const { PrismaClient } = require('@prisma/client');
const { 
  validateAppointment, 
  validateAppointmentStatusUpdate, 
  validateAppointmentReschedule, 
  validateRescheduleConfirm 
} = require('../utils/validation');
const { getDatabaseNow, getUtcDateTime } = require('../utils/time');
const redis = require('../lib/redisClient');

const prisma = new PrismaClient();

// Slot status constants
const SLOT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  LOCKED: 'LOCKED',
  BOOKED: 'BOOKED',
};

// Appointment status constants
const APPOINTMENT_STATUS = {
  BOOKED: 'BOOKED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  RESCHEDULED: 'RESCHEDULED',
}

// Confirm booking for a locked slot
const confirmBooking = async (req, res) => {
  try {
    // Validate input
    const { error, value } = validateAppointment(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { doctorId, timeSlotId, notes } = value;
    const userId = req.user?.id;
    const nowUtc = await getDatabaseNow(prisma);

    // Fetch slot and check existence
    const slot = await prisma.timeSlot.findUnique({
      where: { id: timeSlotId },
      select: { id: true, doctorId: true, status: true, lockedBy: true, lockExpires: true, date: true, startTime: true },
    });
    if (!slot || slot.doctorId !== doctorId) {
      return res.status(404).json({ success: false, error: 'Time slot not found for this doctor', code: 'SLOT_NOT_FOUND' });
    }
    if (slot.status === SLOT_STATUS.BOOKED) {
      return res.status(409).json({ success: false, error: 'Time slot already booked', code: 'SLOT_ALREADY_BOOKED' });
    }

    // Check OTP validity
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { otpVerifiedUntil: true } });
    if (!user?.otpVerifiedUntil || user.otpVerifiedUntil <= nowUtc) {
      return res.status(403).json({ success: false, error: 'OTP verification required', code: 'OTP_REQUIRED' });
    }

    // Check slot lock
    const isLockValid = slot.status === SLOT_STATUS.LOCKED && slot.lockedBy === userId && slot.lockExpires && slot.lockExpires > nowUtc;
    if (!isLockValid) {
      return res.status(409).json({ success: false, error: 'Slot is not locked by you or lock has expired', code: 'LOCK_INVALID' });
    }

    // Transaction to confirm booking
    const appointment = await prisma.$transaction(async (tx) => {
      const todayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));

      // Prevent booking past slots
      if (slot.date < todayUtc) throw { code: 'SLOT_IN_PAST', message: 'Cannot book a past date slot' };

      // Prevent booking a slot that already started today
      if (slot.date.getTime() === todayUtc.getTime()) {
        const hh = String(nowUtc.getUTCHours()).padStart(2, '0');
        const mm = String(nowUtc.getUTCMinutes()).padStart(2, '0');
        if (slot.startTime <= `${hh}:${mm}`) throw { code: 'SLOT_ALREADY_STARTED', message: 'Cannot book a slot that already started' };
      }

      // Update slot atomically
      const updateResult = await tx.timeSlot.updateMany({
        where: { id: timeSlotId, doctorId, status: SLOT_STATUS.LOCKED, lockedBy: userId, lockExpires: { gt: nowUtc } },
        data: { status: SLOT_STATUS.BOOKED, lockedBy: null, lockedAt: null, lockExpires: null },
      });
      if (updateResult.count !== 1) throw { code: 'CONFLICT_SLOT_STATE', message: 'Slot state changed, try again' };

      // Prevent double booking
      const existingBooking = await tx.appointment.findFirst({ where: { timeSlotId, status: SLOT_STATUS.BOOKED } });
      if (existingBooking) throw { code: 'SLOT_ALREADY_BOOKED', message: 'This slot already has an active booking' };

      // Create appointment
      const newAppointment = await tx.appointment.create({
        data: { userId, doctorId, timeSlotId, status: SLOT_STATUS.BOOKED, notes: notes || null },
        select: { id: true, userId: true, doctorId: true, timeSlotId: true, status: true, createdAt: true },
      });

      // Clear OTP after booking
      await tx.user.update({ where: { id: userId }, data: { otpVerifiedUntil: null } });

      return newAppointment;
    });

    // Redis cache invalidation
   try {
  const cacheSetKey = `user:${userId}:appointments:keys`;
  const cachedKeys = await redis.smembers(cacheSetKey);

  if (cachedKeys.length > 0) {
    // Delete all cached appointment keys + set key + appointment key
    await Promise.all([
      ...cachedKeys.map(key => redis.del(key)),
      redis.del(cacheSetKey),
      redis.del(`appointment:${userId}:${appointment.id}`)
    ]);
  }
} catch (cacheErr) {
  console.error('Redis cache invalidation error:', cacheErr);
}


    return res.status(201).json({ success: true, message: 'Appointment booked successfully', data: appointment });

  } catch (err) {
    console.error('confirmBooking error:', err);

    if (err?.code) {
      const statusMap = {
        SLOT_NOT_FOUND: 404,
        SLOT_ALREADY_BOOKED: 409,
        OTP_REQUIRED: 403,
        LOCK_INVALID: 409,
        SLOT_IN_PAST: 409,
        SLOT_ALREADY_STARTED: 409,
        CONFLICT_SLOT_STATE: 409,
      };
      return res.status(statusMap[err.code] || 400).json({ success: false, error: err.message });
    }

    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


// List current user's appointments with slot and doctor info
const listAppointments = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const CACHE_TTL = 14400;

    // Normalize query
    const statusFilter = (req.query.status || '').toString().trim().toUpperCase();
    const typeFilter = (req.query.type || '').toString().trim().toLowerCase();

    const allowedStatuses = [
      APPOINTMENT_STATUS.BOOKED,
      APPOINTMENT_STATUS.COMPLETED,
      APPOINTMENT_STATUS.CANCELLED,
      APPOINTMENT_STATUS.RESCHEDULED,
    ];
    const allowedTypes = ['upcoming', 'past', 'all'];

    const status = allowedStatuses.includes(statusFilter) ? statusFilter : null;
    const type = allowedTypes.includes(typeFilter) ? typeFilter : 'all';

    const cacheKey = `user:${userId}:appointments:${status || 'any'}:${type}`;
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        return res.json({
          success: true,
          message: 'Appointments fetched from cache',
          data: parsed,
        });
      } catch {
        await redis.del(cacheKey);
      }
    }

    const where = { userId };
    if (status) where.status = status;

    const nowUtc = await getDatabaseNow(prisma);
    const todayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
    const currentHM = `${String(nowUtc.getUTCHours()).padStart(2, '0')}:${String(nowUtc.getUTCMinutes()).padStart(2, '0')}`;

    if (!status) {
      // Only include cancelled automatically if status is undefined
      if (type === 'upcoming') {
        // Include BOOKED future + CANCELLED future
        where.OR = [
          {
            AND: [
              { status: APPOINTMENT_STATUS.BOOKED },
              { timeSlot: { is: { OR: [{ date: { gt: todayUtc } }, { AND: [{ date: { equals: todayUtc } }, { startTime: { gt: currentHM } }] }] } } }
            ]
          },
          {
            AND: [
              { status: APPOINTMENT_STATUS.CANCELLED },
              { timeSlot: { is: { OR: [{ date: { gt: todayUtc } }, { AND: [{ date: { equals: todayUtc } }, { startTime: { gt: currentHM } }] }] } } }
            ]
          },
           {
            AND: [
              { status: APPOINTMENT_STATUS.RESCHEDULED },
              { timeSlot: { is: { OR: [{ date: { gt: todayUtc } }, { AND: [{ date: { equals: todayUtc } }, { startTime: { gt: currentHM } }] }] } } }
            ]
          }
        ];
      } else if (type === 'all') {
        // All appointments including CANCELLED
        // no extra filter needed; cancelled are included naturally
      }
    }

    // Past filtering stays the same
    if (type === 'past') {
      where.OR = [
        { status: APPOINTMENT_STATUS.COMPLETED },
        {
          AND: [
            { status: APPOINTMENT_STATUS.BOOKED },
            { timeSlot: { is: { OR: [{ date: { lt: todayUtc } }, { AND: [{ date: { equals: todayUtc } }, { startTime: { lte: currentHM } }] }] } } }
          ]
        },
        {
          AND: [
            { status: APPOINTMENT_STATUS.CANCELLED },
            { timeSlot: { is: { OR: [{ date: { lt: todayUtc } }, { AND: [{ date: { equals: todayUtc } }, { startTime: { lte: currentHM } }] }] } } }
          ]
        }
      ];
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        notes: true,
        createdAt: true,
        doctor: { select: { id: true, name: true, specialization: true, imageUrl: true } },
        timeSlot: { select: { id: true, date: true, startTime: true, endTime: true } },
      }
    });

    await redis.set(cacheKey, JSON.stringify(appointments), { ex: CACHE_TTL });

    return res.json({
      success: true,
      message: 'Appointments fetched successfully',
      data: appointments,
    });

  } catch (e) {
    console.error('listAppointments error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


// Get single appointment details for the logged-in user
const getAppointmentById = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    // Unauthorized check
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // Cache key for this user + appointment
    const cacheKey = `appointment:${userId}:${id}`;

    // Try fetching from Redis cache first
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        return res.json({
          success: true,
          data: parsed,
          message: "Appointment fetched from cache",
        });
      } catch (err) {
        console.error("Corrupt cache for", cacheKey, err);
        await redis.del(cacheKey); // clear bad data
      }
    }

    // Fetch appointment from DB with required fields
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true, // Needed to check ownership
        status: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        doctor: {
          select: {
            id: true,
            name: true,
            specialization: true,
            imageUrl: true,
            bio: true,
          },
        },
        timeSlot: {
          select: { id: true, date: true, startTime: true, endTime: true },
        },
      },
    });

    // Return 404 if appointment not found or not owned by this user
    if (!appointment || appointment.userId !== userId) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Store result in Redis cache for 6 hours
    await redis.set(cacheKey, JSON.stringify(appointment));
    await redis.expire(cacheKey, 21600); // 6 hours

    // Return appointment
    return res.json({
      success: true,
      data: appointment,
      message: "Appointment fetched successfully",
    });
  } catch (e) {
    // Handle unexpected errors
    console.error("getAppointmentById error:", e);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};


// Update appointment status (booked -> completed/cancelled)
const updateAppointmentStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { status } = req.body;

    // Validate request body
    const { error } = validateAppointmentStatusUpdate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    // Fetch appointment
    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true }
    });

    if (!appt || appt.userId !== userId) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Allowed statuses
    const allowedStatuses = ['BOOKED','COMPLETED', 'CANCELLED'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status'
      });
    }

    // No-op check
    if (appt.status === status) {
      return res.json({
        success: true,
        message: 'Status unchanged',
        data: { id: appt.id, status: appt.status }
      });
    }

    // Update appointment
    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: { status },
      select: { id: true, status: true }
    });

// ✅ Invalidate Redis cache for this user's appointments
    const cacheSetKey = `user:${userId}:appointments:keys`;
    const cachedKeys = await redis.smembers(cacheSetKey);
    if (cachedKeys.length) {
      await Promise.all(cachedKeys.map(key => redis.del(key)));
    }
    // Clear the set itself
    await redis.del(cacheSetKey);

    return res.json({
      success: true,
      message: 'Status updated successfully',
      data: updated
    });
  } catch (e) {
    console.error('updateAppointmentStatus error:', e);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};


// Reschedule Request + Lock New Slot
const rescheduleAppointment = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // Validate request body
    const { error } = validateAppointmentReschedule(req.body || {});
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const { newTimeSlotId } = req.body;

    // Fetch appointment and current slot
    const appt = await prisma.appointment.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        doctorId: true,
        timeSlotId: true,
        timeSlot: { select: { id: true, date: true, startTime: true } },
      },
    });

    if (!appt) return res.status(404).json({ success: false, error: 'Appointment not found' });

    if (appt.status !== 'BOOKED')
      return res.status(409).json({ success: false, error: 'Only booked appointments can be rescheduled' });

    if (!appt.timeSlot || !appt.timeSlotId)
      return res.status(409).json({ success: false, error: 'Appointment has no active slot to reschedule' });

    if (appt.timeSlotId === newTimeSlotId)
      return res.status(400).json({ success: false, error: 'New time slot must be different from current slot' });

    const nowUtc = await getDatabaseNow(prisma);

    // Prevent rescheduling within 24 hours of the original slot
    const apptStartUtc = getUtcDateTime(appt.timeSlot.date, appt.timeSlot.startTime);
    if (apptStartUtc.getTime() - nowUtc.getTime() <= 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, error: 'Rescheduling not allowed within 24 hours' });
    }

    // Fetch new slot for validation
    const newSlot = await prisma.timeSlot.findFirst({
      where: { id: newTimeSlotId, doctorId: appt.doctorId },
      select: { id: true, date: true, startTime: true, status: true, lockExpires: true },
    });

    if (!newSlot) return res.status(404).json({ success: false, error: 'New time slot not found' });

    const newStartUtc = getUtcDateTime(newSlot.date, newSlot.startTime);
    if (newStartUtc <= nowUtc)
      return res.status(400).json({ success: false, error: 'Cannot reschedule to a past or ongoing slot' });

    // Locking logic using new status + lockExpires
    const lockResult = await prisma.timeSlot.updateMany({
      where: {
        id: newTimeSlotId,
        doctorId: appt.doctorId,
        OR: [
          { status: 'AVAILABLE' }, // free slot
          { status: 'LOCKED', lockExpires: { lt: nowUtc } }, // previously locked but expired
          { lockedBy: userId }, // current user already locked
        ],
      },
      data: {
        status: 'LOCKED',
        lockedBy: userId,
        lockedAt: nowUtc,
        lockExpires: new Date(nowUtc.getTime() + 5 * 60 * 1000), // 5 min lock
      },
    });

    if (lockResult.count !== 1)
      return res.status(409).json({ success: false, error: 'New slot is locked or booked' });

    return res.json({
      success: true,
      message: 'New time slot locked for reschedule',
      data: {
        lock: {
          timeSlotId: newTimeSlotId,
          doctorId: appt.doctorId,
          lockedBy: userId,
          lockedAt: nowUtc,
          lockExpires: new Date(nowUtc.getTime() + 5 * 60 * 1000),
          date: newSlot.date,
          startTime: newSlot.startTime,
        },
        oldSlotId: appt.timeSlotId,
      },
    });

  } catch (e) {
    console.error('rescheduleAppointment error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


// Cancel appointment. >24h releases slot; <=24h keeps slot booked.
const cancelAppointment = async (req, res) => {
  const userId = req.user?.id; // Get current user ID
  const { id } = req.params; // Appointment ID from URL

  try {
    // Fetch appointment with its slot
    const appt = await prisma.appointment.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        timeSlotId: true,
        timeSlot: { select: { id: true, date: true, startTime: true, status: true } },
      },
    });

    // Return 404 if appointment not found
    if (!appt) return res.status(404).json({ success: false, error: 'Appointment not found' });

    // Only booked appointments can be cancelled
    if (appt.status !== 'BOOKED') {
      return res.status(409).json({ success: false, error: 'Only booked appointments can be cancelled' });
    }

    const nowUtc = await getDatabaseNow(prisma); // Current UTC time
    let isMoreThan24h = true; // Flag to determine if slot can be released

    // Check if appointment slot is more than 24h away
    if (appt.timeSlot) {
      const apptStartUtc = getUtcDateTime(appt.timeSlot.date, appt.timeSlot.startTime);
      isMoreThan24h = apptStartUtc.getTime() - nowUtc.getTime() > 24 * 60 * 60 * 1000;
    }

    // Transaction: cancel appointment and optionally release slot
    const updatedAppointment = await prisma.$transaction(async (tx) => {
      // Release slot if >24h and currently booked
      if (appt.timeSlot && isMoreThan24h && appt.timeSlot.status === 'BOOKED') {
        await tx.timeSlot.update({
          where: { id: appt.timeSlotId },
          data: { status: 'AVAILABLE', lockedAt: null, lockedBy: null },
        });
      }

      // Update appointment status to CANCELLED
      return tx.appointment.update({
        where: { id: appt.id },
        data: { status: 'CANCELLED' },
        select: { id: true, status: true, timeSlotId: true },
      });
    });

   // Invalidate all cached appointment data for this user
try {
  const cacheSetKey = `user:${userId}:appointments:keys`;
  const cachedKeys = await redis.smembers(cacheSetKey);

  if (cachedKeys.length > 0) {
    await Promise.all([
      ...cachedKeys.map(key => redis.del(key)),
      redis.del(cacheSetKey),
      redis.del(`appointment:${userId}:${id}`)
    ]);
  } else {
    // Still delete the appointment key + set key if they exist
    await Promise.all([
      redis.del(cacheSetKey),
      redis.del(`appointment:${userId}:${id}`)
    ]);
  }
} catch (cacheErr) {
  console.error("Redis cache invalidation error:", cacheErr);
}


    // Return success with slot release info
    return res.json({
      success: true,
      message: 'Appointment cancelled',
      data: {
        appointment: updatedAppointment,
        slotReleased: isMoreThan24h,
      },
    });
  } catch (e) {
    console.error('cancelAppointment error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


// Confirm reschedule - finalize new slot, confirm booking and release old slot
const confirmReschedule = async (req, res) => {
  const userId = req.user?.id;
  const { appointmentId, newSlotId, oldSlotId, doctorId } = req.body;

  try {
    // 1️⃣ Validate input
    const { error } = validateRescheduleConfirm(req.body);
    if (error)
      return res.status(400).json({ success: false, error: error.details[0].message });

    // 2️⃣ Fetch appointment and validate ownership, status, doctor, and old slot
    const appt = await prisma.appointment.findFirst({
      where: { id: appointmentId, userId },
      select: {
        id: true,
        userId: true,
        doctorId: true,
        status: true,
        timeSlotId: true,
        notes: true
      },
    });

    if (!appt)
      return res.status(404).json({ success: false, error: "Appointment not found" });

    if (appt.status !== "BOOKED")
      return res.status(409).json({
        success: false,
        error: "Only booked appointments can be rescheduled",
      });

    if (appt.doctorId !== doctorId)
      return res.status(400).json({ success: false, error: "Doctor mismatch" });

    if (appt.timeSlotId !== oldSlotId)
      return res.status(400).json({ success: false, error: "Old slot mismatch" });

    if (oldSlotId === newSlotId)
      return res.status(400).json({
        success: false,
        error: "New slot must differ from old slot",
      });

    const nowUtc = await getDatabaseNow(prisma);

    // 3️⃣ Transaction: update old appointment, create new appointment, book new slot
    const newAppointment = await prisma.$transaction(async (tx) => {
      // --- Fetch and validate new slot ---
      const newSlot = await tx.timeSlot.findFirst({
        where: { id: newSlotId, doctorId },
        select: {
          id: true,
          status: true,
          lockedBy: true,
          lockExpires: true,
          date: true,
          startTime: true,
          endTime: true,
        },
      });

      if (!newSlot) throw { code: "NEW_SLOT_NOT_FOUND" };

      if (
        newSlot.status !== "LOCKED" ||
        newSlot.lockedBy !== userId ||
        (newSlot.lockExpires && newSlot.lockExpires < nowUtc)
      ) {
        throw { code: "NEW_SLOT_NOT_LOCKED_BY_USER" };
      }

      // Ensure the new slot is not in the past
      const slotStartUtc = getUtcDateTime(newSlot.date, newSlot.startTime);
      if (slotStartUtc <= nowUtc) throw { code: "SLOT_ALREADY_STARTED_OR_PAST" };

      // --- Book the new slot ---
      const bookedCount = await tx.timeSlot.updateMany({
        where: {
          id: newSlotId,
          status: "LOCKED",
          lockedBy: userId,
          lockExpires: { gt: nowUtc },
        },
        data: { status: "BOOKED", lockedBy: null, lockExpires: null, lockedAt: null },
      });

      if (bookedCount.count !== 1) throw { code: "CONFLICT_NEW_SLOT" };

      // --- Mark old appointment as RESCHEDULED ---
      await tx.appointment.update({
        where: { id: appt.id },
        data: { status: "RESCHEDULED" },
      });

      // --- Free up old slot ---
      await tx.timeSlot.update({
        where: { id: oldSlotId },
        data: {
          status: "AVAILABLE",
          lockedBy: null,
          lockExpires: null,
        },
      });
      // --- Create new appointment record ---
      const createdAppt = await tx.appointment.create({
        data: {
          userId: appt.userId,
          doctorId: appt.doctorId,
          timeSlotId: newSlotId,
          status: "BOOKED",
          notes: appt.notes,
        },
        select: {
          id: true,
          userId: true,
          doctorId: true,
          timeSlotId: true,
          status: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
          timeSlot: {
            select: {
              date: true,
              startTime: true,
              endTime: true,
              status: true,
            },
          },
          doctor: {
            select: {
              id: true,
              name: true,
              specialization: true,
            },
          },
        },
      });

      // --- Safety: remove any conflicting appointments pointing to this slot ---
      await tx.appointment.updateMany({
        where: { timeSlotId: newSlotId, NOT: { id: createdAppt.id } },
        data: { timeSlotId: null },
      });

      return createdAppt;
    });

    // 4️⃣ Invalidate Redis cache for user's appointments
const cacheSetKey = `user:${userId}:appointments:keys`;
const cachedKeys = await redis.smembers(cacheSetKey);

if (cachedKeys.length > 0) {
  await redis.del(...cachedKeys); // ✅ Bulk delete instead of Promise.all
}
await redis.del(cacheSetKey); // Delete the set itself

// Invalidate single appointment cache (old + new)
await redis.del(
  `appointment:${userId}:${appointmentId}`,
  `appointment:${userId}:${newAppointment.id}`
);

    return res.json({
      success: true,
      message: "Reschedule confirmed",
      data: newAppointment,
    });
  } catch (err) {
    console.error("confirmReschedule error:", err);

    // Map known errors to proper HTTP response
    const errorMap = {
      NEW_SLOT_NOT_FOUND: { status: 404, message: "New slot not found for this doctor" },
      NEW_SLOT_NOT_LOCKED_BY_USER: {
        status: 409,
        message: "New slot not locked by you or lock expired",
      },
      SLOT_ALREADY_STARTED_OR_PAST: {
        status: 400,
        message: "Cannot reschedule to past or started slot",
      },
      CONFLICT_NEW_SLOT: {
        status: 409,
        message: "New slot state changed; try again",
      },
    };

    const mappedError = err?.code && errorMap[err.code];
    if (mappedError)
      return res.status(mappedError.status).json({ success: false, error: mappedError.message });

    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};



module.exports = { 
  confirmBooking, 
  listAppointments, 
  getAppointmentById, 
  updateAppointmentStatus,
  rescheduleAppointment,
  cancelAppointment,
  confirmReschedule
};



