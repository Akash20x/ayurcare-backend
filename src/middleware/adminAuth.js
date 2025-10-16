// adminAuth.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const adminAuth = async (req, res, next) => {
  try {
    // req.user should already be set by auth middleware
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Fetch the user's role from DB
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true } // assuming you have a 'role' field
    });

    if (!user || user.role.toLowerCase() !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden. Admins only.' });
    }

    next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};

module.exports = adminAuth;
