jest.mock('../../src/utils/time', () => ({ getDatabaseNow: jest.fn() }));

const { getDatabaseNow } = require('../../src/utils/time');
const { getNowInIndia } = require('../../src/utils/helper');

describe('getNowInIndia', () => {
  it('uses the Indian calendar date and clock time for slot availability', async () => {
    // 00:15 UTC is 05:45 on the same day in India.
    getDatabaseNow.mockResolvedValueOnce(new Date('2026-10-22T00:15:00.000Z'));

    const now = await getNowInIndia({});

    expect(now.todayUtc).toEqual(new Date('2026-10-22T00:00:00.000Z'));
    expect(now.currentHM).toBe('05:45');
  });

  it('advances to the next Indian calendar day when UTC is still on the previous date', async () => {
    // 20:00 UTC on 21 Oct is 01:30 IST on 22 Oct.
    getDatabaseNow.mockResolvedValueOnce(new Date('2026-10-21T20:00:00.000Z'));

    const now = await getNowInIndia({});

    expect(now.todayUtc).toEqual(new Date('2026-10-22T00:00:00.000Z'));
    expect(now.currentHM).toBe('01:30');
  });
});
