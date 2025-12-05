
import express from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/authMiddleware.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

// @route   GET api/auth/me
// @desc    Validate token (Bearer or Cookie) and Establish Secure Session
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    // req.user is populated by middleware.

    // 1. Upsert User in Local DB
    let existingUser = await User.findOne({
      _id: req.user.id,
      tenantId: req.tenantId,
    });

    if (!existingUser) {
      const newUser = new User({
        _id: req.user.id,
        tenantId: req.tenantId,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        password: 'integrated_account',
      });
      await newUser.save();
      existingUser = newUser;
    }

    // 2. UPGRADE TO COOKIE SESSION
    // If the request came via Bearer Token (Handshake), we now issue a Cookie
    // so the frontend can switch to HttpOnly mode for future requests.

    // Re-sign token to ensure it has the correct expiration for the session
    const tokenPayload = {
      userId: existingUser._id,
      tenantId: existingUser.tenantId,
      role: existingUser.role,
      name: existingUser.name,
      email: existingUser.email,
      // Inherit tenant info if available in request, or load from config
      companyName: req.tenantInfo?.companyName,
      document: req.tenantInfo?.document,
      tenantName: req.tenantInfo?.tenantName
    };

    const sessionToken = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: '1d',
    });

    // Set HttpOnly Cookie
    res.cookie('token', sessionToken, {
      httpOnly: true, // Prevent XSS
      secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
      sameSite: 'lax', // CSRF protection
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    // Return user AND token (for memory storage in frontend to access SaaS API)
    res.status(200).json({
        user: existingUser,
        token: sessionToken 
    });
  } catch (err) {
    console.error('Auth/Me Error:', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   POST api/auth/logout
// @desc    Clear auth cookie
// @access  Public
router.post('/logout', (req, res) => {
  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
  });
  res.status(200).json({ message: 'Logged out' });
});

router.post('/login', (req, res) =>
  res
    .status(410)
    .json({ message: 'Login local desativado. Use o portal SaaS.' })
);
router.get('/system-status', (req, res) => res.json({ userCount: 1 }));

export default router;
