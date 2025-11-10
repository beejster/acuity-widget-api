// server.js
// Vercel-optimized Acuity availability widget
// Shows next OPEN slot in MST (Edmonton) with smart formatting
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Vercel: 10s function timeout → guard at 8s
const FUNCTION_TIMEOUT_MS = 8000;

const cache = new NodeCache({ stdTTL: 60 });

const ACUITY_USER = process.env.ACUITY_USER_ID;
const ACUITY_KEY = process.env.ACUITY_API_KEY;

if (!ACUITY_USER || !ACUITY_KEY) {
  console.error('Missing ACUITY_USER_ID or ACUITY_API_KEY');
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`${ACUITY_USER}:${ACUITY_KEY}`).toString('base64')}`;

// MST (Edmonton) timezone
const MST_TZ = 'America/Edmonton';

// Smart time formatting: Today → Tomorrow → Full weekday (this week) → Short date
function formatTime(isoString, locale = 'en-US') {
  try {
    const d = new Date(isoString);
    const now = new Date();

    // Format time in MST
    const timeOpts = { timeZone: MST_TZ, hour: 'numeric', minute: '2-digit', hour12: true };
    const timeStr = d.toLocaleTimeString(locale, timeOpts).replace(/\s/g, ' ').trim();

    // Convert both to MST for date math
    const dMST = new Date(d.toLocaleString('en-US', { timeZone: MST_TZ }));
    const nowMST = new Date(now.toLocaleString('en-US', { timeZone: MST_TZ }));

    // Today
    if (dMST.toDateString() === nowMST.toDateString()) {
      return `Today: ${timeStr}`;
    }

    // Tomorrow
    const tomorrow = new Date(nowMST);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (dMST.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow: ${timeStr}`;
    }

    // This week (Mon–Sun)
    const weekStart = new Date(nowMST);
    weekStart.setDate(nowMST.getDate() - nowMST.getDay() + 1); // Monday
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // Sunday

    if (dMST >= weekStart && dMST <= weekEnd) {
      const fullWeekday = dMST.toLocaleDateString(locale, { weekday: 'long', timeZone: MST_TZ });
      return `${fullWeekday}: ${timeStr}`;
    }

    // Default: Wed, Nov 12 — 2:00 PM
    const shortDate = dMST.toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: MST_TZ
    });
    return `${shortDate} — ${timeStr}`;
  } catch (e) {
    return 'Invalid time';
  }
}

// GET /api/next-appointment?appointmentTypeID=8355307
app.get('/api/next-appointment', async (req, res) => {
  const timeout = setTimeout(() => {
    res.status(504).json({ error: 'Request timeout' });
  }, FUNCTION_TIMEOUT_MS);

  try {
    const { appointmentTypeID, calendarID, locale } = req.query;

    if (!appointmentTypeID && !calendarID) {
      clearTimeout(timeout);
      return res.json({ found: false, display: 'No type specified' });
    }

    const cacheKey = `avail:${appointmentTypeID || calendarID}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      clearTimeout(timeout);
      return res.json(cached);
    }

    // Start from today
    const today = new Date().toISOString().split('T')[0];
    const maxSearchDays = 30;
    let nextSlot = null;

    for (let i = 0; i < maxSearchDays && !nextSlot; i++) {
      const checkDate = new Date();
      checkDate.setDate(checkDate.getDate() + i);
      const dateStr = checkDate.toISOString().split('T')[0];

      const params = { date: dateStr };
      if (appointmentTypeID) params.appointmentTypeID = appointmentTypeID;
      if (calendarID) params.calendarID = calendarID;

      const { data } = await axios.get('https://acuityscheduling.com/api/v1/availability/times', {
        headers: { Authorization: authHeader },
        params,
        timeout: 7000
      });

      const slots = (data || []).sort((a, b) => new Date(a.time) - new Date(b.time));
      const now = new Date();

      for (const s of slots) {
        if (s.time && new Date(s.time) > now) {
          nextSlot = s.time;
          break;
        }
      }
    }

    const result = nextSlot
      ? {
          found: true,
          display: formatTime(nextSlot, locale),
          datetime: nextSlot,
          appointment: { type: appointmentTypeID || calendarID, isAvailable: true }
        }
      : { found: false, display: 'No availability in next 30 days' };

    cache.set(cacheKey, result);
    clearTimeout(timeout);
    res.json(result);
  } catch (err) {
    clearTimeout(timeout);
    console.error('API error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Vercel serverless export
module.exports = app;
