// server.js
// npm install express axios node-cache body-parser cors dotenv
require('dotenv').config(); // Load .env for local dev only

const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Allow widget on any domain

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // Or your domain: 'https://your-site.com'
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') res.sendStatus(200);
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

// Fixed to MST (Edmonton) — handles DST automatically
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

  const timeStr = `${obj.hour}:${String(obj.minute).padStart(2, '0')} ${obj.period || ''}`.trim();

  // Same day check in MST
  const dMST = new Date(d.toLocaleString('en-US', { timeZone: MST_TZ }));
  const nowMST = new Date(now.toLocaleString('en-US', { timeZone: MST_TZ }));
  const sameDay = dMST.toDateString() === nowMST.toDateString();

  if (sameDay) {
    return `Today: ${timeStr}`;
  }
  return `${obj.weekday}, ${obj.month} ${obj.day} — ${timeStr}`;
}

// GET /api/next-appointment?calendarID=123&locale=en-GB
// OR ?appointmentType=8355307 (for combined city view)
app.get('/api/next-appointment', async (req, res) => {
  try {
    const calendarID = req.query.calendarID;
    const appointmentType = req.query.appointmentType;
    const locale = req.query.locale || 'en-US';
    const cacheKey = `next:${calendarID || ''}:${appointmentType || ''}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const today = new Date();
    const minDate = today.toISOString().split('T')[0];

    const params = {
      minDate,
      maxAppointments: 50,
      sort: 'datetime.asc'
    };
    if (calendarID) params.calendarID = calendarID;
    if (appointmentType) params.appointmentTypeID = appointmentType;

    const resp = await axios.get('https://acuityscheduling.com/api/v1/appointments', {
      headers: { Authorization: acuityAuthHeader() },
      params
    });

    const appts = (resp.data || []).filter(a => !a.canceled && !a.noShow);

    let next = null;
    const now = new Date();
    for (const a of appts) {
      if (!a.datetime) continue;
      const dt = new Date(a.datetime);
      if (dt > now) {
        next = { raw: a, datetime: a.datetime };
        break;
      }
    }

    const payload = next ? {
      found: true,
      display: prettyDateTime(next.datetime, locale),
      datetime: next.datetime,
      appointment: { id: next.raw.id, type: next.raw.appointmentTypeName || next.raw.appointmentTypeID || null }
    } : { found: false, display: 'No upcoming appointments' };

    cache.set(cacheKey, payload, CACHE_TTL_SECONDS);
    res.json(payload);
  } catch (err) {
    console.error('Error fetching Acuity appointments', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// Webhook: invalidate cache on changes
app.post('/webhook/acuity', (req, res) => {
  cache.flushAll();
  res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Next-appointment API listening on ${PORT}`));
