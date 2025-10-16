// redisClient.js
const { Redis } = require('@upstash/redis');

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("❌ Missing Upstash Redis environment variables");
}  

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

(async () => {
  try {
    const pong = await redis.ping();
  } catch (err) {
    console.error("❌ Redis connection failed:", err);
  }
})();

module.exports = redis;
