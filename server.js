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

    // Force everything into MST for accurate date math
    const optionsMST = { timeZone: MST_TZ };
    const dMST = new Date(d.toLocaleString('en-US', optionsMST));
    const nowMST = new Date(now.toLocaleString('en-US', optionsMST));

    // Time string in MST (e.g., "2:30 PM")
    const timeStr = d.toLocaleTimeString(locale, {
      timeZone: MST_TZ,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).replace(/\s+/g, ' ').trim();

    // === Calculate days difference in MST ===
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysDiff = Math.floor((dMST - nowMST) / msPerDay);

    // 0–6 days from today → show full weekday only
    if (daysDiff >= 0 && daysDiff <= 6) {
      if (daysDiff === 0) return `Today at ${timeStr}`;
      if (daysDiff === 1) return `Tomorrow at ${timeStr}`;

      const fullWeekday = dMST.toLocaleDateString(locale, {
        weekday: 'long',
        timeZone: MST_TZ
      });
      return `${fullWeekday} at ${timeStr}`;
    }

    // 7+ days away → month + day only (no weekday)
    const farDate = dMST.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: MST_TZ
    });
    return `${farDate} at ${timeStr}`;

  } catch (e) {
    console.error('formatTime error:', e);
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
