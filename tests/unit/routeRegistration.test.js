const mockAuth = jest.fn();
const mockAdminAuth = jest.fn();

jest.mock('../../src/middleware/auth', () => mockAuth);
jest.mock('../../src/middleware/adminAuth', () => mockAdminAuth);

const mockAuthController = {
  register: jest.fn(), login: jest.fn(), loginWithGoogle: jest.fn(),
  generateOTPForUser: jest.fn(), verifyOTP: jest.fn(), getSession: jest.fn(),
  logout: jest.fn(), refresh: jest.fn(),
};
const mockDoctorController = {
  createDoctor: jest.fn(), updateDoctor: jest.fn(), listDoctors: jest.fn(),
  getDoctorById: jest.fn(), createTimeSlot: jest.fn(), createBatchTimeSlot: jest.fn(),
  getAvailableSlots: jest.fn(), lockTimeSlot: jest.fn(), getSlotById: jest.fn(),
};
const mockAppointmentController = {
  confirmBooking: jest.fn(), listAppointments: jest.fn(), getAppointmentById: jest.fn(),
  updateAppointmentStatus: jest.fn(), rescheduleAppointment: jest.fn(), cancelAppointment: jest.fn(),
  confirmReschedule: jest.fn(),
};
const mockBookingDraftController = {
  createBookingDraft: jest.fn(), getBookingDraft: jest.fn(), getBookingConfirmation: jest.fn(),
  requestDraftOTP: jest.fn(), verifyDraftOTP: jest.fn(), confirmBookingDraft: jest.fn(),
};
const mockAdminController = {
  getStats: jest.fn(), getTodayAppointments: jest.fn(), getPatients: jest.fn(),
  getPatientAppointments: jest.fn(), getUpcomingSlots: jest.fn(), getDoctorUpcomingAppointments: jest.fn(),
};

jest.mock('../../src/controllers/authController', () => mockAuthController);
jest.mock('../../src/controllers/doctorController', () => mockDoctorController);
jest.mock('../../src/controllers/appointmentController', () => mockAppointmentController);
jest.mock('../../src/controllers/bookingDraftController', () => mockBookingDraftController);
jest.mock('../../src/controllers/adminController', () => mockAdminController);

const authRouter = require('../../src/routes/auth');
const doctorsRouter = require('../../src/routes/doctors');
const appointmentsRouter = require('../../src/routes/appointments');
const bookingDraftsRouter = require('../../src/routes/bookingDrafts');
const adminRouter = require('../../src/routes/admin');

const route = (router, method, path) => router.stack.find(
  (layer) => layer.route?.path === path && layer.route.methods[method]
);
const handlers = (router, method, path) => route(router, method, path).route.stack.map((layer) => layer.handle);

describe('route registration', () => {
  it('registers auth endpoints with the correct public and authenticated middleware', () => {
    expect(handlers(authRouter, 'post', '/register')).toEqual([mockAuthController.register]);
    expect(handlers(authRouter, 'post', '/login')).toEqual([mockAuthController.login]);
    expect(handlers(authRouter, 'post', '/google')).toEqual([mockAuthController.loginWithGoogle]);
    expect(handlers(authRouter, 'post', '/generate-otp')).toEqual([mockAuth, mockAuthController.generateOTPForUser]);
    expect(handlers(authRouter, 'post', '/verify-otp')).toEqual([mockAuth, mockAuthController.verifyOTP]);
    expect(handlers(authRouter, 'post', '/logout')).toEqual([mockAuthController.logout]);
    expect(handlers(authRouter, 'post', '/refresh')).toEqual([mockAuthController.refresh]);
    expect(handlers(authRouter, 'get', '/session')).toEqual([mockAuthController.getSession]);
  });

  it('registers public doctor reads and protects doctor mutations', () => {
    expect(handlers(doctorsRouter, 'get', '/')).toEqual([mockDoctorController.listDoctors]);
    expect(handlers(doctorsRouter, 'get', '/:id')).toEqual([mockDoctorController.getDoctorById]);
    expect(handlers(doctorsRouter, 'post', '/')).toEqual([mockAuth, mockAdminAuth, mockDoctorController.createDoctor]);
    expect(handlers(doctorsRouter, 'put', '/:id')).toEqual([mockAuth, mockAdminAuth, mockDoctorController.updateDoctor]);
    expect(handlers(doctorsRouter, 'post', '/:doctorId/slots')).toEqual([mockAuth, mockAdminAuth, mockDoctorController.createTimeSlot]);
    expect(handlers(doctorsRouter, 'post', '/:doctorId/slots/batch')).toEqual([mockAuth, mockAdminAuth, mockDoctorController.createBatchTimeSlot]);
    expect(handlers(doctorsRouter, 'get', '/:doctorId/slots')).toEqual([mockDoctorController.getAvailableSlots]);
    expect(handlers(doctorsRouter, 'post', '/:doctorId/slots/:slotId/lock')).toEqual([mockAuth, mockDoctorController.lockTimeSlot]);
    expect(handlers(doctorsRouter, 'get', '/:doctorId/slots/:slotId')).toEqual([mockDoctorController.getSlotById]);
  });

  it('protects every appointment endpoint and limits status changes to admins', () => {
    expect(handlers(appointmentsRouter, 'post', '/confirm')).toEqual([mockAuth, mockAppointmentController.confirmBooking]);
    expect(handlers(appointmentsRouter, 'get', '/')).toEqual([mockAuth, mockAppointmentController.listAppointments]);
    expect(handlers(appointmentsRouter, 'get', '/:id')).toEqual([mockAuth, mockAppointmentController.getAppointmentById]);
    expect(handlers(appointmentsRouter, 'put', '/:id/status')).toEqual([mockAuth, mockAdminAuth, mockAppointmentController.updateAppointmentStatus]);
    expect(handlers(appointmentsRouter, 'put', '/:id/reschedule')).toEqual([mockAuth, mockAppointmentController.rescheduleAppointment]);
    expect(handlers(appointmentsRouter, 'post', '/reschedule/confirm')).toEqual([mockAuth, mockAppointmentController.confirmReschedule]);
    expect(handlers(appointmentsRouter, 'put', '/:id/cancel')).toEqual([mockAuth, mockAppointmentController.cancelAppointment]);
  });

  it('applies authentication to every booking-draft endpoint', () => {
    expect(bookingDraftsRouter.stack[0].handle).toBe(mockAuth);
    expect(handlers(bookingDraftsRouter, 'post', '/')).toEqual([mockBookingDraftController.createBookingDraft]);
    expect(handlers(bookingDraftsRouter, 'get', '/current')).toEqual([mockBookingDraftController.getBookingDraft]);
    expect(handlers(bookingDraftsRouter, 'get', '/current/confirmation')).toEqual([mockBookingDraftController.getBookingConfirmation]);
    expect(handlers(bookingDraftsRouter, 'post', '/current/otp')).toEqual([mockBookingDraftController.requestDraftOTP]);
    expect(handlers(bookingDraftsRouter, 'post', '/current/verify-otp')).toEqual([mockBookingDraftController.verifyDraftOTP]);
    expect(handlers(bookingDraftsRouter, 'post', '/current/confirm')).toEqual([mockBookingDraftController.confirmBookingDraft]);
  });

  it('applies authentication and admin authorization to every admin endpoint', () => {
    expect(adminRouter.stack[0].handle).toBe(mockAuth);
    expect(adminRouter.stack[1].handle).toBe(mockAdminAuth);
    expect(handlers(adminRouter, 'get', '/stats')).toEqual([mockAdminController.getStats]);
    expect(handlers(adminRouter, 'get', '/appointments/today')).toEqual([mockAdminController.getTodayAppointments]);
    expect(handlers(adminRouter, 'get', '/patients')).toEqual([mockAdminController.getPatients]);
    expect(handlers(adminRouter, 'get', '/patients/:patientId/appointments')).toEqual([mockAdminController.getPatientAppointments]);
    expect(handlers(adminRouter, 'get', '/slots/upcoming')).toEqual([mockAdminController.getUpcomingSlots]);
    expect(handlers(adminRouter, 'get', '/doctors/:doctorId/appointments/upcoming')).toEqual([mockAdminController.getDoctorUpcomingAppointments]);
  });
});
