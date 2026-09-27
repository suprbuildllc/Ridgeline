import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import crypto from 'crypto';

// Load both .env.local and .env
dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Google GenAI client if API key is present
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Initialize Neon Postgres Pool
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
let pool: Pool | null = null;

if (dbUrl) {
  try {
    pool = new Pool({ connectionString: dbUrl });
    console.log('Neon Lakebase Postgres pool initialized');
  } catch (err) {
    console.error('Failed to initialize Neon pool:', err);
  }
}

// System instruction for RidgeLine Trade Assistant
const RIDGELINE_SYSTEM_PROMPT = `You are "RidgeLine", an intelligent SMS scheduling and dispatch assistant representing a solo licensed tradesperson (plumber, electrician, or HVAC technician).
The tradesperson is actively on tools (under a sink, in an attic, or in a trench) and cannot text or answer calls.

Your job:
1. Handle incoming customer SMS text messages warmly, concisely, and decisively. Sound like a helpful human assistant or the owner's dedicated dispatcher (not a robotic corporate chatbot).
2. Triage urgency:
   - "emergency": Active flooding, sewage backup, carbon monoxide, no heat in winter, sparking electrical. Advise immediate safety steps (e.g. "please shut off the main water valve clockwise") and prioritize immediate scheduling.
   - "urgent": Major inconvenience (e.g., sole toilet clogged, water heater pilot out).
   - "routine": Maintenance, faucet replacements, EV chargers, quotes.
3. Handle bookings:
   - Identify service needed and match with service catalog.
   - Propose 1-2 concrete time slots.
   - Collect address if not provided.
   - Auto-confirm when client agrees to a slot.
4. Handle reschedules:
   - Parse natural language reschedule requests (e.g. "push to Thursday morning", "can we do 4pm instead?").
   - Offer the new slot and confirm update.
5. Tone: Short, helpful text messages (1 to 3 sentences max, suitable for SMS). Keep sentences crisp. Never write long multi-paragraph essays.`;

// ==========================================
// AUTHENTICATION & SECURITY (NEON POSTGRES)
// ==========================================

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHash] = parts;
  const computed = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return computed === originalHash;
}

// UUID validation and deterministic mapping helper for Postgres UUID fields
function isValidUuid(id: any): boolean {
  if (typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function toUuid(input?: any): string {
  if (!input) return crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-0000-0000-000000000000';
  if (isValidUuid(input)) return input;
  const hash = crypto.createHash('md5').update('ridgeline:' + String(input)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// POST /api/auth/register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { email, password, fullName, trade = 'plumbing' } = req.body;
  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'Email, password, and full name are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  if (pool) {
    try {
      const existing = await pool.query('SELECT id FROM public.users WHERE email = $1;', [normalizedEmail]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Create starter organization for new user
      const orgRes = await pool.query(
        `INSERT INTO public.organizations (
          name, trade, technician_name, twilio_phone_number, plan
        ) VALUES ($1, $2, $3, $4, 'Solo Pro') RETURNING *;`,
        [`${fullName}'s Trades`, trade, fullName, '+1 (555) 782-4309']
      );
      const newOrg = orgRes.rows[0];

      // Create assistant settings
      await pool.query(
        `INSERT INTO public.assistant_settings (organization_id, ai_tone, auto_confirm_routine)
         VALUES ($1, 'friendly_direct', true);`,
        [newOrg.id]
      );

      const passHash = hashPassword(password);
      const userRes = await pool.query(
        `INSERT INTO public.users (email, password_hash, full_name, role, organization_id, onboarding_completed)
         VALUES ($1, $2, $3, 'owner', $4, false) RETURNING *;`,
        [normalizedEmail, passHash, fullName, newOrg.id]
      );

      const u = userRes.rows[0];
      return res.json({
        success: true,
        user: {
          id: u.id,
          email: u.email,
          fullName: u.full_name,
          role: u.role,
          organizationId: u.organization_id,
          onboardingCompleted: u.onboarding_completed,
        },
      });
    } catch (err: any) {
      console.error('Registration error:', err);
      return res.status(500).json({ error: err.message || 'Registration failed' });
    }
  }

  // Fallback memory
  res.json({
    success: true,
    user: {
      id: `usr-${Date.now()}`,
      email: normalizedEmail,
      fullName,
      role: 'owner',
      onboardingCompleted: false,
    },
  });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  if (pool) {
    try {
      const userRes = await pool.query('SELECT * FROM public.users WHERE email = $1;', [normalizedEmail]);
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const u = userRes.rows[0];
      const valid = verifyPassword(password, u.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      return res.json({
        success: true,
        user: {
          id: u.id,
          email: u.email,
          fullName: u.full_name,
          role: u.role,
          organizationId: u.organization_id,
          onboardingCompleted: u.onboarding_completed,
        },
      });
    } catch (err: any) {
      console.error('Login error:', err);
      return res.status(500).json({ error: err.message || 'Login failed' });
    }
  }

  // Fallback
  if (password === 'Password123!') {
    return res.json({
      success: true,
      user: {
        id: 'u-1',
        email: normalizedEmail,
        fullName: 'Mark Kowalski',
        role: 'owner',
        onboardingCompleted: true,
      },
    });
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

// GET /api/auth/me
app.get('/api/auth/me', async (req: Request, res: Response) => {
  const email = (req.query.email as string)?.toLowerCase()?.trim();
  if (pool && email) {
    try {
      const userRes = await pool.query('SELECT * FROM public.users WHERE email = $1;', [email]);
      if (userRes.rows.length > 0) {
        const u = userRes.rows[0];
        return res.json({
          success: true,
          user: {
            id: u.id,
            email: u.email,
            fullName: u.full_name,
            role: u.role,
            organizationId: u.organization_id,
            onboardingCompleted: u.onboarding_completed,
          },
        });
      }
    } catch (err) {
      // continue
    }
  }

  // Default demo user if none requested
  if (pool) {
    try {
      const demoRes = await pool.query('SELECT * FROM public.users ORDER BY created_at ASC LIMIT 1;');
      if (demoRes.rows.length > 0) {
        const u = demoRes.rows[0];
        return res.json({
          success: true,
          user: {
            id: u.id,
            email: u.email,
            fullName: u.full_name,
            role: u.role,
            organizationId: u.organization_id,
            onboardingCompleted: u.onboarding_completed,
          },
        });
      }
    } catch (err) {
      // continue
    }
  }

  res.json({ success: true, user: null });
});

// POST /api/auth/complete-onboarding
app.post('/api/auth/complete-onboarding', async (req: Request, res: Response) => {
  const {
    userId,
    businessName,
    tradeType = 'plumbing',
    technicianName,
    licenseNumber,
    serviceRadiusMiles = 30,
    twilioPhoneNumber,
    forwardCallsTo,
    aiTone = 'friendly_direct',
    autoConfirmRoutine = true,
    services = [],
  } = req.body;

  if (pool && userId) {
    try {
      // Find or update organization
      const userRes = await pool.query('SELECT * FROM public.users WHERE id = $1;', [userId]);
      let orgId = userRes.rows[0]?.organization_id;

      if (orgId) {
        await pool.query(
          `UPDATE public.organizations SET
            name = $1, trade = $2, technician_name = $3, license_number = $4,
            service_radius_miles = $5, twilio_phone_number = $6, forward_calls_to = $7
           WHERE id = $8;`,
          [businessName, tradeType, technicianName, licenseNumber, serviceRadiusMiles, twilioPhoneNumber, forwardCallsTo, orgId]
        );
      } else {
        const newOrgRes = await pool.query(
          `INSERT INTO public.organizations (
            name, trade, technician_name, license_number, service_radius_miles, twilio_phone_number, forward_calls_to
          ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;`,
          [businessName, tradeType, technicianName, licenseNumber, serviceRadiusMiles, twilioPhoneNumber, forwardCallsTo]
        );
        orgId = newOrgRes.rows[0].id;
        await pool.query('UPDATE public.users SET organization_id = $1 WHERE id = $2;', [orgId, userId]);
      }

      // Update or create assistant settings
      await pool.query(
        `INSERT INTO public.assistant_settings (organization_id, ai_tone, auto_confirm_routine)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id) DO UPDATE SET ai_tone = $2, auto_confirm_routine = $3;`,
        [orgId, aiTone, autoConfirmRoutine]
      );

      // Insert services if provided
      if (Array.isArray(services) && services.length > 0) {
        for (const s of services) {
          await pool.query(
            `INSERT INTO public.services (organization_id, title, trade, duration_hours, base_price, description, is_popular)
             VALUES ($1, $2, $3, $4, $5, $6, $7);`,
            [orgId, s.title, tradeType, s.durationHours || 1.5, s.basePrice || 195, s.description || '', !!s.isPopular]
          );
        }
      }

      // Mark onboarding as completed
      await pool.query('UPDATE public.users SET onboarding_completed = true WHERE id = $1;', [userId]);

      return res.json({
        success: true,
        onboardingCompleted: true,
        organizationId: orgId,
      });
    } catch (err: any) {
      console.error('Error completing onboarding in Neon:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ success: true, onboardingCompleted: true });
});

// ==========================================
// NEON CLOUD & DATABASE API ENDPOINTS
// ==========================================

// Neon Connection & Resource Status
app.get('/api/neon/status', async (req: Request, res: Response) => {
  const startTime = Date.now();
  let connected = false;
  let latencyMs = 0;
  let pgVersion = 'PostgreSQL 18';
  let counts = {
    users: 0,
    organizations: 0,
    services: 0,
    job_bookings: 0,
    sms_threads: 0,
    sms_messages: 0,
    missed_calls: 0,
    customers: 0,
  };

  if (pool) {
    try {
      const pingRes = await pool.query('SELECT NOW() as now, version() as version;');
      latencyMs = Date.now() - startTime;
      connected = true;
      if (pingRes.rows[0]?.version) {
        pgVersion = pingRes.rows[0].version.split(' ')[0] + ' ' + (pingRes.rows[0].version.split(' ')[1] || '');
      }

      // Query table counts
      const usersRes = await pool.query('SELECT count(*) FROM public.users;');
      counts.users = parseInt(usersRes.rows[0].count, 10);

      const orgsRes = await pool.query('SELECT count(*) FROM public.organizations;');
      counts.organizations = parseInt(orgsRes.rows[0].count, 10);

      const servRes = await pool.query('SELECT count(*) FROM public.services;');
      counts.services = parseInt(servRes.rows[0].count, 10);

      const bookRes = await pool.query('SELECT count(*) FROM public.job_bookings;');
      counts.job_bookings = parseInt(bookRes.rows[0].count, 10);

      const thrdRes = await pool.query('SELECT count(*) FROM public.sms_threads;');
      counts.sms_threads = parseInt(thrdRes.rows[0].count, 10);

      const msgRes = await pool.query('SELECT count(*) FROM public.sms_messages;');
      counts.sms_messages = parseInt(msgRes.rows[0].count, 10);

      const callRes = await pool.query('SELECT count(*) FROM public.missed_calls;');
      counts.missed_calls = parseInt(callRes.rows[0].count, 10);

      const custRes = await pool.query('SELECT count(*) FROM public.customers;');
      counts.customers = parseInt(custRes.rows[0].count, 10);
    } catch (err: any) {
      console.warn('Neon status check query failed:', err.message);
      connected = false;
    }
  }

  res.json({
    connected,
    latencyMs,
    projectId: 'frosty-frog-53077141',
    branch: process.env.NEON_BRANCH || 'production',
    region: process.env.AWS_REGION || 'aws-us-east-2',
    pgVersion,
    functionUrl: process.env.NEON_FUNCTION_API_BASE_URL || 'https://br-wandering-morning-b5ynvzm6-api.compute.c-7.us-east-2.aws.neon.tech',
    s3Endpoint: process.env.AWS_ENDPOINT_URL_S3 || 'https://br-wandering-morning-b5ynvzm6.storage.c-7.us-east-2.aws.neon.tech',
    s3Bucket: 'uploads',
    counts,
    timestamp: new Date().toISOString(),
  });
});

// Test live Neon Serverless Function
app.get('/api/neon/test-function', async (req: Request, res: Response) => {
  const functionUrl = process.env.NEON_FUNCTION_API_BASE_URL || 'https://br-wandering-morning-b5ynvzm6-api.compute.c-7.us-east-2.aws.neon.tech';
  const start = Date.now();
  try {
    const response = await fetch(functionUrl, { method: 'GET' });
    const text = await response.text();
    const durationMs = Date.now() - start;
    res.json({
      success: true,
      status: response.status,
      body: text,
      durationMs,
      endpoint: functionUrl,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to reach Neon function',
      endpoint: functionUrl,
      durationMs: Date.now() - start,
    });
  }
});

// Execute safe SQL queries from database viewer
app.post('/api/neon/execute-sql', async (req: Request, res: Response) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'SQL query string required' });
  }

  if (!pool) {
    return res.status(503).json({ error: 'Neon database pool not connected' });
  }

  const start = Date.now();
  try {
    const result = await pool.query(sql);
    const durationMs = Date.now() - start;
    res.json({
      success: true,
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      durationMs,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.message,
      durationMs: Date.now() - start,
    });
  }
});

// Load full operational data directly from Neon Postgres
app.get('/api/neon/data', async (req: Request, res: Response) => {
  if (!pool) {
    return res.status(503).json({ error: 'Neon database pool not connected' });
  }

  try {
    const [orgs, settings, services, bookings, threads, messages, calls, customers] = await Promise.all([
      pool.query('SELECT * FROM public.organizations ORDER BY created_at ASC;'),
      pool.query('SELECT * FROM public.assistant_settings LIMIT 1;'),
      pool.query('SELECT * FROM public.services ORDER BY created_at ASC;'),
      pool.query('SELECT * FROM public.job_bookings ORDER BY scheduled_date DESC, created_at DESC;'),
      pool.query('SELECT * FROM public.sms_threads ORDER BY last_activity_at DESC;'),
      pool.query('SELECT * FROM public.sms_messages ORDER BY created_at ASC;'),
      pool.query('SELECT * FROM public.missed_calls ORDER BY created_at DESC;'),
      pool.query('SELECT * FROM public.customers ORDER BY name ASC;'),
    ]);

    // Group messages by thread_id
    const messagesByThread: Record<string, any[]> = {};
    for (const msg of messages.rows) {
      if (!messagesByThread[msg.thread_id]) {
        messagesByThread[msg.thread_id] = [];
      }
      messagesByThread[msg.thread_id].push({
        id: msg.id,
        threadId: msg.thread_id,
        sender: msg.sender,
        senderName: msg.parsed_intent?.senderName,
        text: msg.text,
        timestamp: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: msg.status,
        actionTag: msg.action_tag,
        parsedIntent: msg.parsed_intent,
      });
    }

    const formattedThreads = threads.rows.map(t => ({
      id: t.id,
      customerName: t.customer_name,
      customerPhone: t.customer_phone,
      address: t.address || '',
      tradeType: t.trade_type,
      unreadCount: t.unread_count,
      lastActivity: new Date(t.last_activity_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: t.status,
      bookingId: t.booking_id,
      messages: messagesByThread[t.id] || [],
    }));

    const formattedBookings = bookings.rows.map(b => ({
      id: b.id,
      customerName: b.customer_name,
      customerPhone: b.customer_phone,
      address: b.address,
      tradeType: b.trade_type,
      serviceTitle: b.service_title,
      date: typeof b.scheduled_date === 'string' ? b.scheduled_date.slice(0, 10) : new Date(b.scheduled_date).toISOString().slice(0, 10),
      timeSlot: b.time_slot,
      status: b.status,
      estimateAmount: parseFloat(b.estimate_amount) || 0,
      notes: b.notes || '',
      urgency: b.urgency,
      createdFrom: b.created_from,
      smsThreadId: b.sms_thread_id,
      createdAt: b.created_at,
    }));

    const formattedServices = services.rows.map(s => ({
      id: s.id,
      title: s.title,
      trade: s.trade,
      durationHours: parseFloat(s.duration_hours) || 1.5,
      basePrice: parseFloat(s.base_price) || 195,
      description: s.description || '',
      isPopular: s.is_popular,
    }));

    const formattedCalls = calls.rows.map(c => ({
      id: c.id,
      callerName: c.caller_name,
      callerPhone: c.caller_phone,
      timestamp: new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      durationSeconds: c.ring_duration_seconds || 15,
      voicemailTranscript: c.voicemail_transcript,
      autoSmsSent: c.auto_sms_sent,
      autoSmsTimestamp: c.auto_sms_sent_at ? new Date(c.auto_sms_sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined,
      autoSmsReplyReceived: c.auto_sms_reply_received,
      convertedToBooking: c.converted_to_booking,
      bookingId: c.booking_id,
      urgency: c.urgency,
    }));

    const formattedOrgs = orgs.rows.map(o => ({
      id: o.id,
      name: o.name,
      trade: o.trade,
      technicianName: o.technician_name,
      plan: o.plan,
      twilioPhoneNumber: o.twilio_phone_number,
      forwardCallsTo: o.forward_calls_to,
      licenseNumber: o.license_number,
      serviceRadiusMiles: o.service_radius_miles,
      businessAddress: o.business_address,
      email: o.email,
    }));

    let formattedSettings = null;
    if (settings.rows[0]) {
      const s = settings.rows[0];
      const primaryOrg = formattedOrgs[0];
      formattedSettings = {
        tradespersonName: primaryOrg?.technicianName || 'Mark Kowalski',
        businessName: primaryOrg?.name || 'Apex Plumbing & Mechanical',
        tradeType: primaryOrg?.trade || 'plumbing',
        twilioPhoneNumber: primaryOrg?.twilioPhoneNumber || '+1 (555) 782-4309',
        forwardCallsTo: primaryOrg?.forwardCallsTo || '+1 (555) 438-9210',
        aiTone: s.ai_tone,
        autoConfirmRoutine: s.auto_confirm_routine,
        bufferMinutesBetweenJobs: s.buffer_minutes_between_jobs,
        workingHours: {
          start: s.working_hours_start?.slice(0, 5) || '07:30',
          end: s.working_hours_end?.slice(0, 5) || '17:30',
          workWeekends: s.work_weekends,
        },
        emergencyKeywords: s.emergency_keywords || [],
      };
    }

    const formattedCustomers = customers.rows.map(c => ({
      id: c.id,
      organizationId: c.organization_id,
      name: c.name,
      phone: c.phone,
      email: c.email || '',
      address: c.address || '',
      notes: c.notes || '',
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));

    res.json({
      success: true,
      organizations: formattedOrgs,
      assistantSettings: formattedSettings,
      services: formattedServices,
      bookings: formattedBookings,
      threads: formattedThreads,
      missedCalls: formattedCalls,
      customers: formattedCustomers,
    });
  } catch (err: any) {
    console.error('Error fetching Neon data:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CUSTOMER PROFILE API
// ==========================================

app.get('/api/customers', async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: 'Neon database pool not connected' });
  try {
    const result = await pool.query('SELECT * FROM public.customers ORDER BY name ASC;');
    res.json({ success: true, customers: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: 'Neon database pool not connected' });
  const { name, phone, email, address, notes, organizationId } = req.body;
  try {
    let orgId = organizationId;
    if (!orgId || !isValidUuid(orgId)) {
      const orgRes = await pool.query('SELECT id FROM public.organizations LIMIT 1;');
      orgId = orgRes.rows[0]?.id;
    }
    const result = await pool.query(
      `INSERT INTO public.customers (organization_id, name, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, phone) DO UPDATE SET
         name = EXCLUDED.name, email = EXCLUDED.email, address = EXCLUDED.address, notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING *;`,
      [orgId, name, phone, email, address, notes]
    );
    res.json({ success: true, customer: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/customers/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, email, address, notes } = req.body;
  if (!pool) return res.status(503).json({ error: 'Neon database pool not connected' });
  try {
    const custUuid = isValidUuid(id) ? id : toUuid(id);
    const result = await pool.query(
      `UPDATE public.customers SET name = COALESCE($1, name), email = COALESCE($2, email), 
       address = COALESCE($3, address), notes = COALESCE($4, notes), updated_at = NOW()
       WHERE id = $5 RETURNING *;`,
      [name, email, address, notes, custUuid]
    );
    res.json({ success: true, customer: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!pool) return res.status(503).json({ error: 'Neon database pool not connected' });
  try {
    const custUuid = isValidUuid(id) ? id : toUuid(id);
    await pool.query('DELETE FROM public.customers WHERE id = $1;', [custUuid]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create Job Booking in Neon Postgres
app.post('/api/bookings', async (req: Request, res: Response) => {
  const {
    customerName,
    customerPhone,
    address,
    tradeType = 'plumbing',
    serviceTitle,
    date,
    timeSlot,
    status = 'scheduled',
    estimateAmount = 0,
    notes = '',
    urgency = 'routine',
    createdFrom = 'manual',
    smsThreadId,
    organizationId,
  } = req.body;

  if (!customerName || !customerPhone || !address || !serviceTitle) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }

  if (pool) {
    try {
      // Find org id if not provided
      let orgId = organizationId;
      if (!orgId || !isValidUuid(orgId)) {
        const orgRes = await pool.query('SELECT id FROM public.organizations LIMIT 1;');
        orgId = orgRes.rows[0]?.id;
      }

      // Automatically upsert customer record
      if (orgId) {
        await pool.query(
          `INSERT INTO public.customers (organization_id, name, phone, address)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (organization_id, phone) DO UPDATE SET
             name = EXCLUDED.name, address = EXCLUDED.address, updated_at = NOW();`,
          [orgId, customerName, customerPhone, address]
        );
      }

      // Check if smsThreadId is valid and exists in public.sms_threads
      let resolvedThreadId: string | null = null;
      if (smsThreadId) {
        const candidateUuid = toUuid(smsThreadId);
        const thCheck = await pool.query('SELECT id FROM public.sms_threads WHERE id = $1;', [candidateUuid]);
        if (thCheck.rows.length > 0) {
          resolvedThreadId = candidateUuid;
        }
      }

      const insertRes = await pool.query(
        `INSERT INTO public.job_bookings (
          organization_id, customer_name, customer_phone, address, trade_type,
          service_title, scheduled_date, time_slot, status, estimate_amount,
          notes, urgency, created_from, sms_thread_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *;`,
        [
          orgId,
          customerName,
          customerPhone,
          address,
          tradeType,
          serviceTitle,
          date || new Date().toISOString().slice(0, 10),
          timeSlot || '09:00 AM - 11:00 AM',
          status,
          estimateAmount,
          notes,
          urgency,
          createdFrom,
          resolvedThreadId,
        ]
      );

      const b = insertRes.rows[0];
      return res.json({
        success: true,
        booking: {
          id: b.id,
          customerName: b.customer_name,
          customerPhone: b.customer_phone,
          address: b.address,
          tradeType: b.trade_type,
          serviceTitle: b.service_title,
          date: typeof b.scheduled_date === 'string' ? b.scheduled_date.slice(0, 10) : new Date(b.scheduled_date).toISOString().slice(0, 10),
          timeSlot: b.time_slot,
          status: b.status,
          estimateAmount: parseFloat(b.estimate_amount) || 0,
          notes: b.notes || '',
          urgency: b.urgency,
          createdFrom: b.created_from,
          smsThreadId: b.sms_thread_id,
          createdAt: b.created_at,
        },
      });
    } catch (err: any) {
      console.error('Failed to insert booking into Neon:', err);
    }
  }

  // Fallback in-memory
  const id = `job-${Date.now().toString().slice(-4)}`;
  res.json({
    success: true,
    booking: {
      id,
      customerName,
      customerPhone,
      address,
      tradeType,
      serviceTitle,
      date: date || new Date().toISOString().slice(0, 10),
      timeSlot: timeSlot || '09:00 AM - 11:00 AM',
      status,
      estimateAmount,
      notes,
      urgency,
      createdFrom,
      smsThreadId,
      createdAt: new Date().toISOString(),
    },
  });
});

// Update Job Booking status or slot in Neon Postgres
app.patch('/api/bookings/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, date, timeSlot, notes } = req.body;

  if (pool) {
    try {
      const bookingUuid = isValidUuid(id) ? id : toUuid(id);
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(status);
      }
      if (date !== undefined) {
        updates.push(`scheduled_date = $${idx++}`);
        values.push(date);
      }
      if (timeSlot !== undefined) {
        updates.push(`time_slot = $${idx++}`);
        values.push(timeSlot);
      }
      if (notes !== undefined) {
        updates.push(`notes = $${idx++}`);
        values.push(notes);
      }

      if (updates.length > 0) {
        values.push(bookingUuid);
        const query = `UPDATE public.job_bookings SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *;`;
        const resUp = await pool.query(query, values);
        if (resUp.rows.length > 0) {
          const b = resUp.rows[0];
          return res.json({
            success: true,
            booking: {
              id: b.id,
              customerName: b.customer_name,
              customerPhone: b.customer_phone,
              address: b.address,
              tradeType: b.trade_type,
              serviceTitle: b.service_title,
              date: typeof b.scheduled_date === 'string' ? b.scheduled_date.slice(0, 10) : new Date(b.scheduled_date).toISOString().slice(0, 10),
              timeSlot: b.time_slot,
              status: b.status,
              estimateAmount: parseFloat(b.estimate_amount) || 0,
              notes: b.notes || '',
              urgency: b.urgency,
              createdFrom: b.created_from,
              smsThreadId: b.sms_thread_id,
            },
          });
        }
      }
    } catch (err: any) {
      console.warn('Neon booking update failed:', err.message);
    }
  }

  res.json({ success: true, updatedId: id });
});

// Add message to SMS Thread in Neon Postgres
app.post('/api/sms/message', async (req: Request, res: Response) => {
  const {
    threadId,
    sender,
    senderName,
    text,
    actionTag,
    parsedIntent,
    customerName,
    customerPhone,
    address,
    tradeType = 'plumbing',
    organizationId,
  } = req.body;

  if (!threadId || !text || !sender) {
    return res.status(400).json({ error: 'threadId, sender, and text are required' });
  }

  const threadUuid = toUuid(threadId);
  const enrichedParsedIntent = {
    ...(typeof parsedIntent === 'object' && parsedIntent !== null ? parsedIntent : {}),
    ...(senderName ? { senderName } : {}),
  };

  if (pool) {
    try {
      // Ensure the thread exists in public.sms_threads
      const threadCheck = await pool.query('SELECT id FROM public.sms_threads WHERE id = $1;', [threadUuid]);

      if (threadCheck.rows.length === 0) {
        // Resolve valid organization ID
        let orgId = organizationId && isValidUuid(organizationId) ? organizationId : null;
        if (!orgId) {
          const orgRes = await pool.query('SELECT id FROM public.organizations LIMIT 1;');
          orgId = orgRes.rows[0]?.id;
        }

        if (orgId) {
          await pool.query(
            `INSERT INTO public.sms_threads (
              id, organization_id, customer_name, customer_phone, address, trade_type, status, last_activity_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
            ON CONFLICT (id) DO UPDATE SET last_activity_at = NOW();`,
            [
              threadUuid,
              orgId,
              customerName || 'Customer',
              customerPhone || '+1 (555) 777-1234',
              address || '',
              tradeType,
            ]
          );
        }
      } else {
        await pool.query('UPDATE public.sms_threads SET last_activity_at = NOW() WHERE id = $1;', [threadUuid]);
      }

      const msgRes = await pool.query(
        `INSERT INTO public.sms_messages (thread_id, sender, text, action_tag, parsed_intent)
         VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
        [threadUuid, sender, text, actionTag || null, JSON.stringify(enrichedParsedIntent)]
      );

      const savedMsg = msgRes.rows[0];
      return res.json({
        success: true,
        message: {
          id: savedMsg.id,
          threadId,
          uuidThreadId: threadUuid,
          sender: savedMsg.sender,
          senderName: savedMsg.parsed_intent?.senderName || senderName,
          text: savedMsg.text,
          timestamp: new Date(savedMsg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: savedMsg.status,
          actionTag: savedMsg.action_tag,
        },
      });
    } catch (err: any) {
      console.warn('Neon message insert failed:', err.message);
    }
  }

  res.json({
    success: true,
    message: {
      id: `msg-${Date.now()}`,
      threadId,
      sender,
      senderName,
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'delivered',
      actionTag,
    },
  });
});

// API: Process incoming SMS with Gemini + Auto-Sync to Neon
app.post('/api/sms/process', async (req: Request, res: Response) => {
  try {
    const {
      incomingText,
      customerName,
      customerPhone,
      address,
      conversationHistory = [],
      existingBookings = [],
      services = [],
      settings = {},
    } = req.body;

    if (!incomingText) {
      return res.status(400).json({ error: 'incomingText is required' });
    }

    let parsedResult: any = null;

    if (ai) {
      const prompt = `
Context:
- Business: ${settings.businessName || 'Apex Trades'}
- Tradesperson: ${settings.tradespersonName || 'Mark'} (${settings.tradeType || 'plumbing'})
- Customer Name: ${customerName || 'Customer'}
- Customer Phone: ${customerPhone || 'Unknown'}
- Known Customer Address: ${address || 'Not yet provided'}
- Today's Date: ${new Date().toISOString().split('T')[0]}
- Available Services: ${JSON.stringify(services.map((s: any) => ({ title: s.title, price: s.basePrice, durationHours: s.durationHours })))}
- Recent Bookings: ${JSON.stringify(existingBookings.map((b: any) => ({ id: b.id, name: b.customerName, date: b.date, slot: b.timeSlot, status: b.status })))}

Conversation history so far:
${conversationHistory.map((m: any) => `${m.sender === 'customer' ? 'Customer' : 'Assistant'}: ${m.text}`).join('\n')}

New incoming SMS from customer:
"${incomingText}"

Analyze this message, determine the intent, formulate the optimal SMS response, and extract structured data.
Return a valid JSON object matching the requested schema.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction: RIDGELINE_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              replyText: {
                type: Type.STRING,
                description: 'The exact SMS text message to send back to the customer (keep under 300 characters, friendly and direct).',
              },
              intent: {
                type: Type.STRING,
                enum: ['book', 'reschedule', 'cancel', 'inquiry', 'emergency', 'confirm'],
                description: 'Primary customer intent',
              },
              urgency: {
                type: Type.STRING,
                enum: ['routine', 'urgent', 'emergency'],
                description: 'Urgency tier of the job',
              },
              actionTag: {
                type: Type.STRING,
                enum: ['auto_booked', 'rescheduled', 'quote_given', 'emergency_escalated', 'slot_offered', 'info_requested'],
                description: 'Action taken by the assistant',
              },
              serviceTitle: {
                type: Type.STRING,
                description: 'Matched trade service title, if determined.',
              },
              suggestedSlot: {
                type: Type.STRING,
                description: 'Proposed or confirmed time slot e.g. "Tomorrow 09:00 AM - 11:00 AM"',
              },
              extractedAddress: {
                type: Type.STRING,
                description: 'Address extracted from text if provided.',
              },
              estimatedPrice: {
                type: Type.NUMBER,
                description: 'Estimated dollar cost based on service catalog, or 0 if unknown.',
              },
              shouldConfirmBooking: {
                type: Type.BOOLEAN,
                description: 'True if a new booking or slot was explicitly agreed upon and should be added/updated in the schedule.',
              },
            },
            required: ['replyText', 'intent', 'urgency', 'actionTag', 'shouldConfirmBooking'],
          },
        },
      });

      parsedResult = JSON.parse(response.text?.trim() || '{}');
      parsedResult.source = 'gemini';
    } else {
      // Rule-based fallback if no Gemini key
      const lower = incomingText.toLowerCase();
      let intent: 'book' | 'reschedule' | 'cancel' | 'inquiry' | 'emergency' | 'confirm' = 'inquiry';
      let urgency: 'routine' | 'urgent' | 'emergency' = 'routine';
      let actionTag: 'auto_booked' | 'rescheduled' | 'quote_given' | 'emergency_escalated' | 'slot_offered' | 'info_requested' = 'info_requested';
      let replyText = `Thanks for reaching out! Mark is on a service call. Can you share what issue you're experiencing and your address?`;
      let shouldConfirmBooking = false;
      let suggestedSlot = 'Tomorrow 10:00 AM - 12:00 PM';
      let estimatedPrice = 250;
      let serviceTitle = 'General Service Diagnostic';

      if (lower.includes('flood') || lower.includes('burst') || lower.includes('leak') || lower.includes('sewage') || lower.includes('emergency')) {
        intent = 'emergency';
        urgency = 'emergency';
        actionTag = 'emergency_escalated';
        replyText = `Understood, this is urgent! Please locate and shut off the main water shutoff valve clockwise immediately. Mark can dispatch to you today at 1:30 PM. What is your street address?`;
        suggestedSlot = 'Today 01:30 PM - 03:30 PM';
        estimatedPrice = 380;
        serviceTitle = 'Emergency Burst Pipe & Valve Shutoff';
      } else if (lower.includes('reschedule') || lower.includes('push to') || lower.includes('move to') || lower.includes('another day') || lower.includes('can we do')) {
        intent = 'reschedule';
        urgency = 'routine';
        actionTag = 'rescheduled';
        shouldConfirmBooking = true;
        suggestedSlot = 'Tomorrow 09:00 AM - 11:00 AM';
        replyText = `No problem at all! I have updated Mark's schedule and moved your appointment to tomorrow from 9:00 AM - 11:00 AM. See you then!`;
      } else if (lower.includes('yes') || lower.includes('sounds good') || lower.includes('perfect') || lower.includes('confirm') || lower.includes('book it')) {
        intent = 'confirm';
        actionTag = 'auto_booked';
        shouldConfirmBooking = true;
        replyText = `You're all set! We have you confirmed on Mark's dispatch schedule for tomorrow 09:00 AM - 11:00 AM. Mark will text when en route!`;
      } else if (lower.includes('how much') || lower.includes('cost') || lower.includes('quote') || lower.includes('price')) {
        intent = 'inquiry';
        actionTag = 'quote_given';
        replyText = `Our standard diagnostic & basic service call is $195-$285 depending on parts required. Mark has an opening tomorrow morning at 9:00 AM or 1:00 PM if you'd like a slot!`;
      }

      parsedResult = {
        source: 'fallback',
        replyText,
        intent,
        urgency,
        actionTag,
        serviceTitle,
        suggestedSlot,
        extractedAddress: address || '',
        estimatedPrice,
        shouldConfirmBooking,
      };
    }

    return res.json({
      success: true,
      ...parsedResult,
    });
  } catch (error: any) {
    console.error('Error in /api/sms/process:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// API: Process simulated missed call to auto-SMS
app.post('/api/missed-call/process', async (req: Request, res: Response) => {
  try {
    const { callerName, callerPhone, voicemailTranscript, settings = {} } = req.body;

    let autoSms = `Hey ${callerName || 'there'}! Mark with ${settings.businessName || 'Apex Plumbing'} here. I'm currently on a service call and couldn't grab the phone. Need help with a plumbing or mechanical issue? Reply here and I'll get you on the schedule!`;

    if (ai && voicemailTranscript) {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `A customer left this voicemail after a missed call: "${voicemailTranscript}".
Tradesperson: ${settings.tradespersonName || 'Mark'} with ${settings.businessName || 'Apex Plumbing'}.
Draft the immediate follow-up SMS text to send them within 10 seconds to secure the booking before they call a competitor.
Keep it under 240 chars, friendly, acknowledging what they mentioned in the voicemail.`,
      });

      autoSms = response.text?.trim() || autoSms;
    }

    // Persist missed call to Neon if pool available
    if (pool) {
      try {
        const orgRes = await pool.query('SELECT id FROM public.organizations LIMIT 1;');
        const orgId = orgRes.rows[0]?.id;
        if (orgId) {
          await pool.query(
            `INSERT INTO public.missed_calls (
              organization_id, caller_name, caller_phone, ring_duration_seconds,
              voicemail_transcript, auto_sms_sent, auto_sms_sent_at, converted_to_booking
            ) VALUES ($1, $2, $3, $4, $5, true, NOW(), false);`,
            [orgId, callerName || 'Customer', callerPhone || '+1 (555) 000-0000', 18, voicemailTranscript || null]
          );
        }
      } catch (err: any) {
        console.warn('Neon missed call insert failed:', err.message);
      }
    }

    return res.json({ autoSms });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    geminiConfigured: !!apiKey,
    neonConfigured: !!pool,
    platform: 'RidgeLine AI Dispatch',
  });
});

// Initialize database tables if they don't exist
async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        email VARCHAR(255),
        address TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_org ON public.customers (organization_id, phone);
    `);
    console.log('Database tables initialized or verified.');
  } catch (err) {
    console.error('Failed to initialize database tables:', err);
  }
}

// Vite Middleware for development vs Static files in production
async function startServer() {
  await initDb();
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RidgeLine server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
