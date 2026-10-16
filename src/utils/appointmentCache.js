const STATUSES = ['any', 'BOOKED', 'COMPLETED', 'CANCELLED', 'RESCHEDULED'];
const TYPES = ['all', 'upcoming', 'past'];

/**
 * Builds the Redis key for a user's filtered appointment list.
 * List responses are cached separately for every status and time filter.
 */
const appointmentListKey = (userId, status, type) =>
  `user:${userId}:appointments:${status || 'any'}:${type}`;

/**
 * Clears all appointment-list cache variants for a user and, when supplied,
 * the cache entries for specific appointments. Call this after any appointment
 * mutation so subsequent reads return current data.
 */
const invalidateAppointmentCaches = (redis, userId, appointmentIds = []) => {
  const listKeys = STATUSES.flatMap((status) =>
    TYPES.map((type) => appointmentListKey(userId, status, type))
  );
  const detailKeys = appointmentIds.map((id) => `appointment:${userId}:${id}`);

  return redis.del(...listKeys, ...detailKeys, `user:${userId}:appointments:keys`);
};

module.exports = { appointmentListKey, invalidateAppointmentCaches };
