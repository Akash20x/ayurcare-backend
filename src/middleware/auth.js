const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const auth = async (req, res, next) => {
  try {
    const bearerToken = req.header('Authorization')?.replace('Bearer ', '');
    const token = bearerToken || req.cookies?.accessToken;
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, name: true, phone: true, role: true }
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token.' });
  }
};

module.exports = auth;
