const { appointmentListKey, invalidateAppointmentCaches } = require('../../src/utils/appointmentCache');

test('one Redis operation invalidates every supported list filter and affected details', async () => {
  const redis = { del: jest.fn().mockResolvedValue(1) };

  await invalidateAppointmentCaches(redis, 'user-1', ['old-1', 'new-1']);

  expect(redis.del).toHaveBeenCalledTimes(1);
  const keys = redis.del.mock.calls[0];
  expect(keys).toHaveLength(18); // 5 statuses x 3 types, two details, one legacy set.
  expect(keys).toContain(appointmentListKey('user-1', 'BOOKED', 'all'));
  expect(keys).toContain(appointmentListKey('user-1', null, 'upcoming'));
  expect(keys).toContain('appointment:user-1:old-1');
  expect(keys).toContain('appointment:user-1:new-1');
});
