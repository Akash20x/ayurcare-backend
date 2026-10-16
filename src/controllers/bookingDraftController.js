const crypto = require('crypto');
const prisma = require('../lib/prisma');
const redis = require('../lib/redisClient');
const { validateBookingDraft, validateBookingDraftOTP } = require('../utils/validation');
const { getDatabaseNow } = require('../utils/time');
const {
  OTP_EXPIRY_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  saveDraftOTP,
  getDraftOTP,
  deleteDraftOTP,
  getDraftOTPCooldown,
  saveDraftOTPCooldown,
  saveDraftVerification,
  getDraftVerification,
  deleteDraftVerification,
} = require('../utils/otp');
const { sendOtpEmail, sendAppointmentConfirmation } = require('../services/emailService');
const { invalidateAppointmentCaches } = require('../utils/appointmentCache');

const DRAFT_EXPIRY_SECONDS = 5 * 60;
const SLOT_STATUS = { AVAILABLE: 'AVAILABLE', LOCKED: 'LOCKED', BOOKED: 'BOOKED' };
const normalizeEmail = (email) => String(email).trim().toLowerCase();
const draftKey = (userId, draftId) => `booking:draft:${userId}:${draftId}`;
const currentDraftKey = (userId) => `booking:draft:current:${userId}`;

const parseDraft = (draft) => {
  if (!draft) return null;
  return typeof draft === 'string' ? JSON.parse(draft) : draft;
};

const getDraft = async (userId, draftId) => {
  const currentDraftId = await redis.get(currentDraftKey(userId));
  if (!currentDraftId || String(currentDraftId) !== String(draftId)) return null;
  return parseDraft(await redis.get(draftKey(userId, draftId)));
};

const getCurrentDraft = async (userId) => {
  const draftId = await redis.get(currentDraftKey(userId));
  if (!draftId) return null;
  return getDraft(userId, draftId);
};

const deleteDraft = async (userId, draftId) => {
  await redis.del(draftKey(userId, draftId));
  const currentDraftId = await redis.get(currentDraftKey(userId));
  if (String(currentDraftId) === String(draftId)) await redis.del(currentDraftKey(userId));
};

const releasePreviousDraftLock = async (userId) => {
  const previousDraftId = await redis.get(currentDraftKey(userId));
  if (!previousDraftId) return;

  const previousDraft = parseDraft(await redis.get(draftKey(userId, previousDraftId)));
  if (previousDraft?.timeSlotId) {
    await prisma.timeSlot.updateMany({
      where: { id: previousDraft.timeSlotId, status: SLOT_STATUS.LOCKED, lockedBy: userId },
      data: { status: SLOT_STATUS.AVAILABLE, lockedBy: null, lockedAt: null, lockExpires: null },
    });
  }

  await redis.del(draftKey(userId, previousDraftId), currentDraftKey(userId));
};

const publicDraft = (draft) => ({
  doctorId: draft.doctorId,
  timeSlotId: draft.timeSlotId,
  contactEmail: draft.contactEmail,
  patient: draft.patient || undefined,
});

const createBookingDraft = async (req, res) => {
  try {
    const { error, value } = validateBookingDraft(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { doctorId, notes, patient } = value;
    const timeSlotId = value.timeSlotId || value.slotId;
    const bookingForSomeoneElse = value.bookingForSomeoneElse;
    const contactEmail = normalizeEmail(value.contactEmail);
    const nowUtc = await getDatabaseNow(prisma);
    const expiresAt = new Date(nowUtc.getTime() + DRAFT_EXPIRY_SECONDS * 1000);

    const [doctor, slot] = await Promise.all([
      prisma.doctor.findUnique({
        where: { id: doctorId },
        select: {
          id: true,
          name: true,
          specialization: true,
          consultationMode: true,
          consultationFee: true,
        },
      }),
      prisma.timeSlot.findUnique({
        where: { id: timeSlotId },
        select: {
          id: true,
          doctorId: true,
          status: true,
          lockedBy: true,
          date: true,
          startTime: true,
        },
      }),
    ]);

    if (!doctor || doctor.consultationMode !== 'in_person') {
      return res.status(404).json({
        success: false,
        error: 'Doctor not available for in-person consultation',
        code: 'DOCTOR_NOT_FOUND',
      });
    }
    if (!slot || slot.doctorId !== doctorId) {
      return res.status(404).json({
        success: false,
        error: 'Time slot not found for this doctor',
        code: 'SLOT_NOT_FOUND',
      });
    }
    if (slot.status === SLOT_STATUS.BOOKED) {
      return res
        .status(409)
        .json({ success: false, error: 'Time slot already booked', code: 'SLOT_ALREADY_BOOKED' });
    }

    const todayUtc = new Date(
      Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate())
    );
    if (
      slot.date < todayUtc ||
      (slot.date.getTime() === todayUtc.getTime() &&
        slot.startTime <=
          `${String(nowUtc.getUTCHours()).padStart(2, '0')}:${String(nowUtc.getUTCMinutes()).padStart(2, '0')}`)
    ) {
      return res.status(409).json({
        success: false,
        error: 'Cannot book a past or started time slot',
        code: 'SLOT_UNAVAILABLE',
      });
    }

    const activeLocks = await prisma.timeSlot.count({
      where: { lockedBy: userId, status: SLOT_STATUS.LOCKED, lockExpires: { gt: nowUtc } },
    });
    const alreadyLockedByUser = slot.status === SLOT_STATUS.LOCKED && slot.lockedBy === userId;
    if (activeLocks >= 3 && !alreadyLockedByUser) {
      return res
        .status(429)
        .json({ success: false, error: 'Lock limit reached. Complete or release existing locks.' });
    }

    await releasePreviousDraftLock(userId);

    const lockResult = await prisma.timeSlot.updateMany({
      where: {
        id: timeSlotId,
        doctorId,
        OR: [
          { status: SLOT_STATUS.AVAILABLE },
          { status: SLOT_STATUS.LOCKED, lockExpires: { lte: nowUtc } },
          { status: SLOT_STATUS.LOCKED, lockedBy: userId },
        ],
      },
      data: {
        status: SLOT_STATUS.LOCKED,
        lockedBy: userId,
        lockedAt: nowUtc,
        lockExpires: expiresAt,
      },
    });
    if (lockResult.count !== 1) {
      return res.status(409).json({
        success: false,
        error: 'Unable to lock slot. It may be locked or booked.',
        code: 'LOCK_CONFLICT',
      });
    }

    const draft = {
      draftId: crypto.randomUUID(),
      doctorId,
      timeSlotId,
      contactEmail,
      notes: notes || null,
      bookingForSomeoneElse,
      patient: patient
        ? {
            name: patient.name,
            ...(patient.age !== undefined ? { age: patient.age } : {}),
            ...(patient.gender ? { gender: patient.gender.toLowerCase() } : {}),
            ...(patient.phone ? { phone: patient.phone } : {}),
          }
        : null,
      expiresAt: expiresAt.toISOString(),
    };

    try {
      await redis.set(draftKey(userId, draft.draftId), JSON.stringify(draft), {
        ex: DRAFT_EXPIRY_SECONDS,
      });
      await redis.set(currentDraftKey(userId), draft.draftId, { ex: DRAFT_EXPIRY_SECONDS });
    } catch (cacheErr) {
      await prisma.timeSlot.updateMany({
        where: {
          id: timeSlotId,
          status: SLOT_STATUS.LOCKED,
          lockedBy: userId,
          lockExpires: expiresAt,
        },
        data: { status: SLOT_STATUS.AVAILABLE, lockedBy: null, lockedAt: null, lockExpires: null },
      });
      throw cacheErr;
    }

    return res
      .status(201)
      .json({ success: true, message: 'Booking draft created', data: publicDraft(draft) });
  } catch (err) {
    console.error('createBookingDraft error:', err);
    return res.status(500).json({ success: false, error: 'Unable to create booking draft' });
  }
};

const getBookingDraft = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const draft = await getCurrentDraft(userId);
    if (!draft)
      return res.status(404).json({
        success: false,
        error: 'Booking draft expired or not found',
        code: 'DRAFT_NOT_FOUND',
      });
    return res.json({ success: true, data: publicDraft(draft) });
  } catch (err) {
    console.error('getBookingDraft error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load booking draft' });
  }
};

const getBookingConfirmation = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const draft = await getCurrentDraft(userId);
    if (!draft)
      return res.status(404).json({
        success: false,
        error: 'Booking draft expired or not found',
        code: 'DRAFT_NOT_FOUND',
      });
    if (!(await getDraftVerification(userId, draft.draftId))) {
      return res
        .status(403)
        .json({ success: false, error: 'OTP verification required', code: 'OTP_REQUIRED' });
    }

    const [doctor, timeSlot] = await Promise.all([
      prisma.doctor.findUnique({
        where: { id: draft.doctorId },
        select: {
          name: true,
          specialization: true,
          consultationFee: true,
          clinicName: true,
          city: true,
        },
      }),
      prisma.timeSlot.findFirst({
        where: { id: draft.timeSlotId, doctorId: draft.doctorId },
        select: { date: true, startTime: true, endTime: true },
      }),
    ]);

    if (!doctor || !timeSlot) {
      return res.status(409).json({
        success: false,
        error: 'Booking details are no longer available',
        code: 'BOOKING_UNAVAILABLE',
      });
    }

    const venue = [doctor.clinicName, doctor.city].filter(Boolean).join(', ') || null;

    return res.json({
      success: true,
      data: {
        doctor: {
          name: doctor.name,
          specialization: doctor.specialization,
          consultationFee: doctor.consultationFee,
          venue,
        },
        appointment: {
          date: timeSlot.date.toISOString().slice(0, 10),
          startTime: timeSlot.startTime,
          endTime: timeSlot.endTime,
        },
        patient: {
          name: draft.patient?.name || null,
          age: draft.patient?.age ?? null,
          gender: draft.patient?.gender || null,
          phone: draft.patient?.phone || null,
          email: draft.contactEmail,
        },
      },
    });
  } catch (err) {
    console.error('getBookingConfirmation error:', err);
    return res.status(500).json({ success: false, error: 'Unable to load booking confirmation' });
  }
};

const requestDraftOTP = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const draft = await getCurrentDraft(userId);
    if (!draft)
      return res.status(404).json({
        success: false,
        error: 'Booking draft expired or not found',
        code: 'DRAFT_NOT_FOUND',
      });

    const cooldown = await getDraftOTPCooldown(userId, draft.draftId);
    if (cooldown)
      return res.status(429).json({
        success: false,
        error: `Please wait ${OTP_RESEND_COOLDOWN_SECONDS} seconds before requesting another OTP`,
      });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await saveDraftOTP(userId, draft.draftId, otp);
    try {
      const emailResult = await sendOtpEmail(draft.contactEmail, otp, OTP_EXPIRY_SECONDS / 60);
      await saveDraftOTPCooldown(userId, draft.draftId);
      return res.json({
        success: true,
        message: emailResult.sent ? 'OTP sent successfully' : 'OTP generated successfully',
        data: {
          expiresInMinutes: OTP_EXPIRY_SECONDS / 60,
          emailDelivery: emailResult.sent ? 'sent' : 'disabled',
        },
      });
    } catch (emailErr) {
      await deleteDraftOTP(userId, draft.draftId);
      console.error('Send draft OTP email error:', emailErr.message);
      return res.status(500).json({ success: false, error: 'Failed to send OTP email' });
    }
  } catch (err) {
    console.error('requestDraftOTP error:', err);
    return res.status(500).json({ success: false, error: 'Unable to request OTP' });
  }
};

const verifyDraftOTP = async (req, res) => {
  try {
    const { error, value } = validateBookingDraftOTP({ draftId: 'current', otp: req.body?.otp });
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const draft = await getCurrentDraft(userId);
    if (!draft)
      return res.status(404).json({
        success: false,
        error: 'Booking draft expired or not found',
        code: 'DRAFT_NOT_FOUND',
      });

    const isMasterOTP =
      process.env.MASTER_OTP && String(process.env.MASTER_OTP).trim() === String(value.otp).trim();
    if (!isMasterOTP) {
      const storedOTP = await getDraftOTP(userId, draft.draftId);
      if (!storedOTP)
        return res.status(400).json({ success: false, error: 'OTP expired or not found' });
      if (String(storedOTP).trim() !== String(value.otp).trim())
        return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }

    await deleteDraftOTP(userId, draft.draftId);
    await saveDraftVerification(userId, draft.draftId);
    return res.json({
      success: true,
      message: 'OTP verified successfully',
      data: { verifiedUntil: new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString() },
    });
  } catch (err) {
    console.error('verifyDraftOTP error:', err);
    return res.status(500).json({ success: false, error: 'Unable to verify OTP' });
  }
};

const confirmBookingDraft = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const draft = await getCurrentDraft(userId);
    if (!draft)
      return res.status(404).json({
        success: false,
        error: 'Booking draft expired or not found',
        code: 'DRAFT_NOT_FOUND',
      });
    if (!(await getDraftVerification(userId, draft.draftId))) {
      return res
        .status(403)
        .json({ success: false, error: 'OTP verification required', code: 'OTP_REQUIRED' });
    }

    const nowUtc = await getDatabaseNow(prisma);
    const [doctor, slot] = await Promise.all([
      prisma.doctor.findUnique({
        where: { id: draft.doctorId },
        select: {
          id: true,
          name: true,
          specialization: true,
          consultationMode: true,
          consultationFee: true,
          clinicName: true,
          city: true,
        },
      }),
      prisma.timeSlot.findUnique({
        where: { id: draft.timeSlotId },
        select: { id: true, doctorId: true, date: true, startTime: true },
      }),
    ]);
    if (
      !doctor ||
      doctor.consultationMode !== 'in_person' ||
      !slot ||
      slot.doctorId !== draft.doctorId
    ) {
      return res.status(409).json({
        success: false,
        error: 'Booking details are no longer available',
        code: 'BOOKING_UNAVAILABLE',
      });
    }

    const appointment = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.timeSlot.updateMany({
        where: {
          id: draft.timeSlotId,
          doctorId: draft.doctorId,
          status: SLOT_STATUS.LOCKED,
          lockedBy: userId,
          lockExpires: { gt: nowUtc },
        },
        data: { status: SLOT_STATUS.BOOKED, lockedBy: null, lockedAt: null, lockExpires: null },
      });
      if (updateResult.count !== 1)
        throw { code: 'LOCK_INVALID', message: 'Slot is not locked by you or lock has expired' };

      const existingBooking = await tx.appointment.findFirst({
        where: { timeSlotId: draft.timeSlotId, status: SLOT_STATUS.BOOKED },
      });
      if (existingBooking)
        throw { code: 'SLOT_ALREADY_BOOKED', message: 'This slot already has an active booking' };

      return tx.appointment.create({
        data: {
          userId,
          doctorId: draft.doctorId,
          timeSlotId: draft.timeSlotId,
          status: 'BOOKED',
          notes: draft.notes || null,
          contactEmail: draft.contactEmail,
          consultationMode: 'in_person',
          consultationFee: Number.isInteger(doctor.consultationFee) ? doctor.consultationFee : 500,
          patientName: draft.patient?.name || null,
          patientAge: draft.patient?.age ?? null,
          patientGender: draft.patient?.gender || null,
          patientPhone: draft.patient?.phone || null,
        },
      });
    });

    await Promise.allSettled([
      deleteDraftVerification(userId, draft.draftId),
      deleteDraft(userId, draft.draftId),
      invalidateAppointmentCaches(redis, userId, [appointment.id]),
    ]);

    try {
      await sendAppointmentConfirmation(appointment.contactEmail, {
        venue: [doctor.clinicName, doctor.city].filter(Boolean).join(', '),
        doctorName: doctor.name,
        specialization: doctor.specialization,
        date: slot.date.toISOString().split('T')[0],
        startTime: slot.startTime,
        consultationMode: appointment.consultationMode,
        consultationFee: appointment.consultationFee,
        patientName: appointment.patientName,
        notes: appointment.notes,
      });
    } catch (emailErr) {
      console.error('Appointment confirmation email error:', emailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Appointment booked successfully',
      data: { id: appointment.id },
    });
  } catch (err) {
    console.error('confirmBookingDraft error:', err);
    const statusMap = { LOCK_INVALID: 409, SLOT_ALREADY_BOOKED: 409 };
    return res
      .status(statusMap[err?.code] || 500)
      .json({ success: false, error: err.message || 'Unable to confirm booking' });
  }
};

module.exports = {
  createBookingDraft,
  getBookingDraft,
  getBookingConfirmation,
  requestDraftOTP,
  verifyDraftOTP,
  confirmBookingDraft,
};
