const WEEKDAY_GROUPS = {
  MON_WED_FRI: [1, 3, 5],
  TUE_THU: [2, 4],
  TUE_THU_SAT: [2, 4, 6],
  SAT_SUN: [6, 0],
  MON_TO_FRI: [1, 2, 3, 4, 5],
  MON_TUE_WED: [1, 2, 3],
  THU_FRI_SAT: [4, 5, 6],
};

const parseDateUtc = (dateStr) => new Date(`${dateStr}T00:00:00.000Z`);

const getTodayUtc = () => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
};

const validateTimeframeRange = (startTime, endTime, parseToMinutes) => {
  const startMinutes = parseToMinutes(startTime);
  const endMinutes = parseToMinutes(endTime);

  if (endMinutes <= startMinutes) {
    return { error: 'endTime must be greater than startTime' };
  }
  if ((endMinutes - startMinutes) % 30 !== 0) {
    return { error: 'Timeframe must be a multiple of 30 minutes' };
  }

  return { startMinutes, endMinutes };
};

const buildTimeSegments = (startMinutes, endMinutes, toTimeString) => {
  const segments = [];
  for (let cursor = startMinutes; cursor < endMinutes; cursor += 30) {
    segments.push({ startTime: toTimeString(cursor), endTime: toTimeString(cursor + 30) });
  }
  return segments;
};

const getMatchingDatesInRange = (startDate, endDate, weekdayNums) => {
  const dates = [];
  const cursor = new Date(startDate);

  while (cursor <= endDate) {
    if (weekdayNums.includes(cursor.getUTCDay())) {
      dates.push(new Date(cursor));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
};

const filterSchedulableDates = (dates, startMinutes) => {
  const now = new Date();
  const todayUTC = getTodayUtc();
  const nowMinutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes();

  return dates.filter((parsedDate) => {
    if (parsedDate < todayUTC) return false;
    if (parsedDate.getTime() === todayUTC.getTime() && startMinutes <= nowMinutesUTC) return false;
    return true;
  });
};

const formatDateYmd = (date) => date.toISOString().split('T')[0];

const addDaysUtc = (date, days) => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

const resolveBatchDateRange = (startDate, endDate) => {
  const todayUTC = getTodayUtc();
  const parsedStartDate = startDate ? parseDateUtc(startDate) : todayUTC;
  const parsedEndDate = endDate ? parseDateUtc(endDate) : addDaysUtc(parsedStartDate, 28);

  return {
    startDate: formatDateYmd(parsedStartDate),
    endDate: formatDateYmd(parsedEndDate),
    parsedStartDate,
    parsedEndDate,
  };
};

const invalidateDoctorSlotCaches = async (redis, doctorId) => {
  let cursor = '0';

  do {
    const [newCursor, keys] = await redis.scan(cursor, {
      match: 'doctors:list*',
      count: 100,
    });

    cursor = newCursor ?? '0';

    if (keys.length > 0) {
      await redis.unlink(...keys);
    }
  } while (cursor !== '0');

  await redis.unlink(`doctor:${doctorId}`);
};

module.exports = {
  WEEKDAY_GROUPS,
  parseDateUtc,
  getTodayUtc,
  validateTimeframeRange,
  buildTimeSegments,
  getMatchingDatesInRange,
  filterSchedulableDates,
  formatDateYmd,
  resolveBatchDateRange,
  invalidateDoctorSlotCaches,
};
