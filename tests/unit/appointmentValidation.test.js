const { validateAppointment } = require('../../src/utils/validation');

describe('appointment validation', () => {
  const booking = {
    doctorId: 'doctor-1',
    timeSlotId: 'slot-1',
    contactEmail: 'patient@example.com',
  };

  it('accepts a self booking without patient details', () => {
    const { error } = validateAppointment(booking);
    expect(error).toBeUndefined();
  });

  it('accepts optional alternate patient details', () => {
    const { error } = validateAppointment({
      ...booking,
      patient: {
        name: 'Sita Sharma',
        age: 58,
        gender: 'female',
        phone: '9876543210',
      },
    });

    expect(error).toBeUndefined();
  });

  it('requires a verified appointment contact email', () => {
    const { error } = validateAppointment({
      doctorId: 'doctor-1',
      timeSlotId: 'slot-1',
    });

    expect(error).toBeDefined();
  });

  it('rejects incomplete patient details', () => {
    const { error } = validateAppointment({
      ...booking,
      patient: { name: 'Sita Sharma' },
    });

    expect(error).toBeDefined();
  });
});
