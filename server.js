// server.js
// npm install express axios node-cache body-parser cors dotenv
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Bulletproof CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CACHE_TTL_SECONDS = 60;
const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS });

const ACUITY_USER = process.env.ACUITY_USER_ID;
const ACUITY_KEY = process.env.ACUITY_API_KEY;

if (!ACUITY_USER || !ACUITY_KEY) {
  console.error('ACUITY_USER_ID and ACUITY_API_KEY must be set in environment');
  process.exit(1);
}

function acuityAuthHeader() {
  const token = Buffer.from(`${ACUITY_USER}:${ACUITY_KEY}`).toString('base64');
  return `Basic ${token}`;
}

// MST (Edmonton) formatting
const MST_TZ = 'America/Edmonton';
function prettyDateTime(isoString, locale = 'en-US') {
  const d = new Date(isoString);
  const now = new Date();

  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: MST_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true
  });

  const parts = formatter.formatToParts(d);
  const obj = parts.reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

// Add "Tomorrow" + full weekday (within current week)
  const timeStr = `${obj.hour}:${String(obj.minute).padStart(2, '0')} ${obj.period || ''}`.trim();

  // Convert to MST for accurate date math
  const dMST = new Date(d.toLocaleString('en-US', { timeZone: MST_TZ }));
  const nowMST = new Date(now.toLocaleString('en-US', { timeZone: MST_TZ }));

  // Same day
  const sameDay = dMST.toDateString() === nowMST.toDateString();

  // Tomorrow
  const tomorrowMST = new Date(nowMST);
  tomorrowMST.setDate(tomorrowMST.getDate() + 1);
  const isTomorrow = dMST.toDateString() === tomorrowMST.toDateString();

  // Current week: Monday to Sunday
  const weekStart = new Date(nowMST);
  weekStart.setDate(nowMST.getDate() - nowMST.getDay() + 1); // Monday
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6); // Sunday

  const isThisWeek = dMST >= weekStart && dMST <= weekEnd;

  // Full weekday name
  const fullWeekday = dMST.toLocaleDateString('en-US', { weekday: 'long', timeZone: MST_TZ });

  if (sameDay) {
    return `Today: ${timeStr}`;
  }
  if (isTomorrow) {
    return `Tomorrow: ${timeStr}`;
  }
  if (isThisWeek) {
    return `${fullWeekday}: ${timeStr}`;
  }
  return `${obj.weekday}, ${obj.month} ${obj.day} — ${timeStr}`;

// GET /api/next-appointment?appointmentTypeID=8355307
app.get('/api/next-appointment', async (req, res) => {
  try {
    const appointmentTypeID = req.query.appointmentTypeID;
    const calendarID = req.query.calendarID;
    const locale = req.query.locale || 'en-US';

    if (!appointmentTypeID && !calendarID) {
      return res.json({
        found: false,
        display: 'No appointment type or calendar specified'
      });
    }

    const cacheKey = `avail:${appointmentTypeID || calendarID}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Start from today, scan forward up to 30 days
    const today = new Date();
    const maxSearchDate = new Date(today);
    maxSearchDate.setDate(today.getDate() + 30); // 30-day window

    let nextSlot = null;
    let currentDate = new Date(today);

    while (currentDate <= maxSearchDate && !nextSlot) {
      const dateStr = currentDate.toISOString().split('T')[0];

      const params = {
        date: dateStr,
        appointmentTypeID: appointmentTypeID || '',
        calendarID: calendarID || ''
      };

      const resp = await axios.get('https://acuityscheduling.com/api/v1/availability/times', {
        headers: { Authorization: acuityAuthHeader() },
        params
      });

      const slots = (resp.data || []).sort((a, b) => new Date(a.time) - new Date(b.time));

      const now = new Date();
      for (const slot of slots) {
        if (!slot.time) continue;
        const dt = new Date(slot.time);
        if (dt > now) {
          nextSlot = { datetime: slot.time };
          break;
        }
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const payload = nextSlot ? {
      found: true,
      display: prettyDateTime(nextSlot.datetime, locale),
      datetime: nextSlot.datetime,
      appointment: {
        type: appointmentTypeID || calendarID,
        isAvailable: true
      }
    } : {
      found: false,
      display: 'No availability in next 30 days'
    };

    cache.set(cacheKey, payload, CACHE_TTL_SECONDS);
    res.json(payload);

  } catch (err) {
    console.error('Availability error:', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Webhook
app.post('/webhook/acuity', (req, res) => {
  cache.flushAll();
  res.status(200).send('ok');
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
