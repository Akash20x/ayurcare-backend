const Joi = require('joi');

const validateRegistration = (data) => {
  const schema = Joi.object({
    name: Joi.string().min(2).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    adminSecret: Joi.string().optional() // optional admin secret
  });
  return schema.validate(data);
};

const validateLogin = (data) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  });
  return schema.validate(data);
};

const validateEmail = (data) => {
  const schema = Joi.object({
    email: Joi.string().email().required()
  });
  return schema.validate(data);
};

const validateOTP = (data) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    otp: Joi.string().length(6).pattern(/^[0-9]+$/).required()
  });
  return schema.validate(data);
};

const validateSlotLock = (data) => {
  const schema = Joi.object({
    timeSlotId: Joi.string().required(),
    doctorId: Joi.string().required()
  });
  return schema.validate(data);
};

const validateAppointment = (data) => {
  const schema = Joi.object({
    doctorId: Joi.string().required(),
    timeSlotId: Joi.string().required(),
    notes: Joi.string().max(500).optional()
  });
  return schema.validate(data);
};

const validateAppointmentStatusUpdate = (data) => {
  const schema = Joi.object({
    status: Joi.string().valid('BOOKED', 'COMPLETED', 'CANCELLED').required()
  });
  return schema.validate(data);
};

const validateAppointmentReschedule = (data) => {
  const schema = Joi.object({
    newTimeSlotId: Joi.string().required()
  });
  return schema.validate(data);
};

const validateRescheduleConfirm = (data) => {
  const schema = Joi.object({
    appointmentId: Joi.string().required(),
    newSlotId: Joi.string().required(),
    oldSlotId: Joi.string().required(),
    doctorId: Joi.string().required()
  });
  return schema.validate(data);
};

const validateDoctorCreate = (data) => {
  const schema = Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    phone: Joi.string().max(20).allow(null, ''),
    specialization: Joi.string().min(2).max(100).required(),
    consultationMode: Joi.string().valid('online', 'in_person', 'both').required(),
    experience: Joi.number().integer().min(0).max(80).required(),
    bio: Joi.string().max(2000).allow(null, ''),
    imageUrl: Joi.string().uri().allow(null, '')
  });
  return schema.validate(data);
};

const validateTimeSlotCreate = (data) => {
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const schema = Joi.object({
    date: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .required()
      .messages({ 'string.pattern.base': 'date must be in YYYY-MM-DD format' }),
    startTime: Joi.string()
      .pattern(timePattern)
      .required()
      .messages({ 'string.pattern.base': 'startTime must be in HH:MM (24h) format' }),
    endTime: Joi.string()
      .pattern(timePattern)
      .required()
      .messages({ 'string.pattern.base': 'endTime must be in HH:MM (24h) format' })
  });
  return schema.validate(data);
};

const validateSlotsFetchQuery = (data) => {
  const schema = Joi.object({
    date: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .messages({ 'string.pattern.base': 'date must be in YYYY-MM-DD format' }),

    start: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .messages({ 'string.pattern.base': 'start must be in YYYY-MM-DD format' }),

    end: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .messages({ 'string.pattern.base': 'end must be in YYYY-MM-DD format' })
  }).xor('date', 'start'); 
  // 👆 ensures user must provide either `date` OR (`start` + `end`)
  return schema.validate(data);
};


module.exports = {
  validateRegistration,
  validateLogin,
  validateEmail,
  validateOTP,
  validateSlotLock,
  validateAppointment,
  validateAppointmentStatusUpdate,
  validateAppointmentReschedule,
  validateRescheduleConfirm,
  validateDoctorCreate,
  validateTimeSlotCreate,
  validateSlotsFetchQuery
};

