const { formatTime, parseTime } = require('../../src/utils/time');

describe('Time Utils', () => {
  test('formatTime should format time correctly', () => {
    expect(formatTime('13:00')).toBe('01:00 PM');
    expect(formatTime('00:00')).toBe('12:00 AM');
  });

  test('parseTime should parse formatted time', () => {
    expect(parseTime('01:00 PM')).toBe('13:00');
    expect(parseTime('12:00 AM')).toBe('00:00');
  });
});
