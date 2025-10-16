const getDatabaseNow = async (prisma) => {
  try {
    const rows = await prisma.$queryRaw`SELECT NOW() as now`;
    const row = Array.isArray(rows) ? rows[0] : rows;
    const value = row?.now instanceof Date ? row.now : new Date(row?.now ?? Date.now());
    return value;
  } catch (_) {
    return new Date();
  }
};

// Converts "HH:mm" → "hh:mm AM/PM"
const formatTime = (time) => {
  const [hour, minute] = time.split(':').map(Number);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  return `${h.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} ${ampm}`;
};

// Converts "hh:mm AM/PM" → "HH:mm"
const parseTime = (formattedTime) => {
  let [time, modifier] = formattedTime.split(' ');
  let [hour, minute] = time.split(':').map(Number);
  if (modifier === 'PM' && hour !== 12) hour += 12;
  if (modifier === 'AM' && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const getUtcDateTime = (date, time) => {
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hh || 0, mm || 0));
};

// convert HH:MM to minutes
const parseToMinutes = (t) => {
  const [h, m] = t.split(":").map(Number); 
  return h * 60 + m;
};

// convert minutes to HH:MM
const toTimeString = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

module.exports = { getDatabaseNow, formatTime, parseTime, getUtcDateTime, parseToMinutes, toTimeString };
