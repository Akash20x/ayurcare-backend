const {
  sendOtpEmail,
  sendAppointmentConfirmation,
} = require('../../src/services/emailService');

const EMAILJS_SEND_URL = 'https://api.emailjs.com/api/v1.0/email/send';
const originalEnv = process.env;
const originalFetch = global.fetch;

describe('emailService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      EMAILJS_ENABLED: 'true',
      EMAILJS_SERVICE_ID: 'service_test',
      EMAILJS_PUBLIC_KEY: 'public_test',
      EMAILJS_PRIVATE_KEY: 'private_test',
      EMAILJS_OTP_TEMPLATE_ID: 'template_otp',
      EMAILJS_APPOINTMENT_TEMPLATE_ID: 'template_appointment',
    };
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('sends an OTP through the configured EmailJS template', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(sendOtpEmail('Patient@Example.com ', '123456', 5)).resolves.toEqual({ sent: true });

    expect(global.fetch).toHaveBeenCalledWith(EMAILJS_SEND_URL, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        service_id: 'service_test',
        template_id: 'template_otp',
        user_id: 'public_test',
        accessToken: 'private_test',
        template_params: {
          to_email: 'patient@example.com',
          otp: '123456',
          expires_in_minutes: '5',
        },
      }),
    }));
  });

  it('sends the appointment-confirmation template', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await sendAppointmentConfirmation('patient@example.com', {
      venue: 'Ayurveda Wellness Clinic, Jaipur',
      doctorName: 'Dr. Sharma',
      specialization: 'Ayurveda',
      date: '2026-10-01',
      startTime: '10:00',
      consultationFee: 500,
      patientName: 'Aarav',
    });

    const request = global.fetch.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
      template_id: 'template_appointment',
      template_params: expect.objectContaining({
        doctor_name: 'Dr. Sharma',
        venue: 'Ayurveda Wellness Clinic, Jaipur',
        appointment_time: '10:00 AM',
        consultation_fee: 500,
        patient_name: 'Aarav',
      }),
    }));
    expect(JSON.parse(request.body).template_params).not.toHaveProperty('appointment_id');
  });

  it('formats afternoon appointment times for the confirmation email', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await sendAppointmentConfirmation('patient@example.com', {
      venue: 'Ayurveda Wellness Clinic, Jaipur',
      startTime: '17:00',
    });

    const request = global.fetch.mock.calls[0][1];
    expect(JSON.parse(request.body).template_params.appointment_time).toBe('5:00 PM');
  });

  it('does not call EmailJS while email delivery is disabled', async () => {
    process.env.EMAILJS_ENABLED = 'false';

    await expect(sendOtpEmail('patient@example.com', '123456', 5))
      .resolves.toEqual({ sent: false, reason: 'EMAIL_DISABLED' });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns a controlled error when EmailJS rejects delivery', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('Invalid template'),
    });

    await expect(sendOtpEmail('patient@example.com', '123456', 5))
      .rejects.toThrow('EmailJS rejected the email request');
  });
});
