const EMAILJS_SEND_URL = 'https://api.emailjs.com/api/v1.0/email/send';

const isEmailEnabled = () => process.env.EMAILJS_ENABLED === 'true';

const formatAppointmentTime = (time) => {
  if (typeof time !== 'string') return '';

  const match = time.match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  if (!match) return time;

  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;

  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
};

const sendEmail = async (templateId, templateParams) => {
  if (!isEmailEnabled()) {
    return { sent: false, reason: 'EMAIL_DISABLED' };
  }

  if (!process.env.EMAILJS_SERVICE_ID || !process.env.EMAILJS_PUBLIC_KEY || !process.env.EMAILJS_PRIVATE_KEY) {
    throw new Error('EmailJS configuration is missing');
  }

  if (!templateId) {
    throw new Error('EmailJS template ID is missing');
  }

  try {
    const response = await fetch(EMAILJS_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: templateId,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: templateParams,
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text();

      throw new Error(
        `EmailJS rejected the email request (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    return { sent: true };
  } catch (err) {
    console.error('EmailJS send failed:', err.message);
    throw err;
  }
};

const sendOtpEmail = async (email, otp, expiresInMinutes) => {
  if (!email || !otp) {
    throw new Error('Email and OTP are required');
  }

  return sendEmail(process.env.EMAILJS_OTP_TEMPLATE_ID, {
    to_email: email.trim().toLowerCase(),
    otp: String(otp),
    expires_in_minutes: String(expiresInMinutes),
  });
};

const sendAppointmentConfirmation = async (email, appointment) => {
  if (!email || !appointment) {
    throw new Error('Email and appointment details are required');
  }

  return sendEmail(process.env.EMAILJS_APPOINTMENT_TEMPLATE_ID, {
    to_email: email.trim().toLowerCase(),
    venue: appointment.venue || '',
    doctor_name: appointment.doctorName || '',
    specialization: appointment.specialization || '',
    appointment_date: appointment.date || '',
    appointment_time: formatAppointmentTime(appointment.startTime),
    consultation_mode: appointment.consultationMode || 'in_person',
    consultation_fee: appointment.consultationFee ?? '',
    patient_name: appointment.patientName || '',
    notes: appointment.notes || '',
  });
};

module.exports = { isEmailEnabled, sendEmail, sendOtpEmail, sendAppointmentConfirmation };
