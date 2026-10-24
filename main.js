'use strict';

/*
 * Tram Depot Car Allocation Board
 * -------------------------------
 * One Node 20 plain-http entry file: static SPA + JSON API + JSON-document store.
 * Start with: node main.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* A local .env is honoured when present; the real process environment wins. */
function loadDotEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnvFile();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '', 10) || 3000;
const PROJECT_DIR = __dirname;
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const DB_PATH = path.resolve(PROJECT_DIR, process.env.DB_PATH || path.join('data', 'db.json'));

const DEMO_EMAIL = 'cenius@cenius.ai';
const DEMO_PASSWORD = 'cenius';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 200;

const SEVERITIES = ['minor', 'major', 'critical'];
const SEVERITY_RANK = { minor: 1, major: 2, critical: 3 };
const CAR_STATUSES = ['in-service', 'standby', 'maintenance'];

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;

/* ------------------------------------------------------------------ *
 * Errors and small utilities
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields || null;
  }
}

function localToday() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* ------------------------------------------------------------------ *
 * Password hashing (scrypt) and session tokens
 * ------------------------------------------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, digest] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  if (expected.length === 0) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sessions = new Map(); // sid -> { staffId, expiresAt }
const loginAttempts = new Map(); // client key -> { count, resetAt }

function createSession(staffId) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { staffId, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

function readSid(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'sid') return decodeURIComponent(rest.join('='));
  }
  return null;
}

function staffForRequest(req, db) {
  const sid = readSid(req);
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return db.staff.find((member) => member.id === session.staffId) || null;
}

function sidCookie(sid, maxAgeSeconds) {
  return [
    `sid=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function throttleLogin(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

/* ------------------------------------------------------------------ *
 * Store: one JSON document, loaded once, flushed atomically
 * ------------------------------------------------------------------ */

const TABLES = [
  'staff',
  'routes',
  'shifts',
  'sidingPositions',
  'tramCars',
  'allocations',
  'notices',
];

function saveStore(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function loadStore() {
  if (!fs.existsSync(DB_PATH)) {
    const seeded = seedDatabase();
    saveStore(seeded);
    console.log(`[tram-depot] seeded a fresh store at ${DB_PATH}`);
    return seeded;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Store at ${DB_PATH} is unreadable or not valid JSON: ${error.message}`);
  }
  for (const table of TABLES) {
    if (!Array.isArray(parsed[table])) {
      throw new Error(`Store at ${DB_PATH} is corrupt: "${table}" is missing or not an array`);
    }
  }

  // Warm containers can carry a store created before the demo roster existed,
  // or on a day that has never had a roster written for it.
  ensureDemoStaff(parsed);
  ensureTodayRoster(parsed);
  return parsed;
}

function ensureDemoStaff(db) {
  const exists = db.staff.some((member) => member.email === DEMO_EMAIL);
  if (exists) return false;
  db.staff.push({
    id: crypto.randomUUID(),
    name: 'Cenius Demo',
    email: DEMO_EMAIL,
    passwordHash: hashPassword(DEMO_PASSWORD),
    role: 'dispatcher',
    createdAt: new Date().toISOString(),
  });
  saveStore(db);
  return true;
}

/*
 * The roster the depot runs on every day. It is used to seed a fresh store and
 * to top up a store that has no allocations for today, so the board always
 * opens on real work rather than an empty screen.
 */
const DAILY_ROSTER = [
  { routeId: 'route-12', shiftId: 'shift-early', carId: 'car-101', note: 'Peak board, three-car working' },
  { routeId: 'route-4', shiftId: 'shift-early', carId: 'car-103', note: 'Covering the university timetable' },
  { routeId: 'route-22', shiftId: 'shift-early', carId: 'car-105', note: '' },
  { routeId: 'route-7', shiftId: 'shift-early', carId: 'car-107', note: 'Airport run, luggage racks fitted' },
  { routeId: 'route-12', shiftId: 'shift-late', carId: 'car-102', note: '' },
  { routeId: 'route-15', shiftId: 'shift-late', carId: 'car-104', note: 'Stadium event crowd working' },
  { routeId: 'route-31', shiftId: 'shift-late', carId: 'car-106', note: 'School specials' },
];

function ensureTodayRoster(db) {
  const today = localToday();
  const dispatcher = db.staff.find((member) => member.email === DEMO_EMAIL) || db.staff[0];
  if (!dispatcher) return false;

  const timestamp = new Date().toISOString();
  let added = 0;
  for (const spec of DAILY_ROSTER) {
    const route = db.routes.find((candidate) => candidate.id === spec.routeId);
    const shift = db.shifts.find((candidate) => candidate.id === spec.shiftId);
    const car = db.tramCars.find((candidate) => candidate.id === spec.carId);
    if (!route || !shift || !car) continue;
    const alreadyRostered = db.allocations.some(
      (allocation) =>
        allocation.serviceDate === today &&
        allocation.carId === car.id &&
        allocation.shiftId === shift.id,
    );
    if (alreadyRostered) continue;
    db.allocations.push({
      id: crypto.randomUUID(),
      serviceDate: today,
      routeId: route.id,
      shiftId: shift.id,
      carId: car.id,
      note: spec.note,
      createdByStaffId: dispatcher.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    added += 1;
  }
  if (added > 0) saveStore(db);
  return added > 0;
}

/* ------------------------------------------------------------------ *
 * Seed data for a believable depot on first boot
 * ------------------------------------------------------------------ */

function seedDatabase() {
  const createdAt = new Date().toISOString();
  const today = localToday();

  const staff = [
    {
      id: crypto.randomUUID(),
      name: 'Cenius Demo',
      email: DEMO_EMAIL,
      passwordHash: hashPassword(DEMO_PASSWORD),
      role: 'dispatcher',
      createdAt,
    },
    {
      id: crypto.randomUUID(),
      name: 'Marta Kowalski',
      email: 'marta.kowalski@tramdepot.example',
      passwordHash: hashPassword(crypto.randomBytes(18).toString('hex')),
      role: 'inspector',
      createdAt,
    },
    {
      id: crypto.randomUUID(),
      name: 'Tobias Berg',
      email: 'tobias.berg@tramdepot.example',
      passwordHash: hashPassword(crypto.randomBytes(18).toString('hex')),
      role: 'dispatcher',
      createdAt,
    },
    {
      id: crypto.randomUUID(),
      name: 'Aisha Rahman',
      email: 'aisha.rahman@tramdepot.example',
      passwordHash: hashPassword(crypto.randomBytes(18).toString('hex')),
      role: 'inspector',
      createdAt,
    },
  ];
  const dispatcher = staff[0].id;
  const inspector = staff[1].id;

  const routes = [
    { id: 'route-12', code: '12', name: 'City Centre – Harbour', terminusA: 'Central Square', terminusB: 'Harbour Quay', active: true },
    { id: 'route-4', code: '4', name: 'University – Northgate', terminusA: 'University Gates', terminusB: 'Northgate Loop', active: true },
    { id: 'route-22', code: '22', name: 'Riverside Loop', terminusA: 'Riverside Market', terminusB: 'Riverside Market', active: true },
    { id: 'route-7', code: '7', name: 'Airport Express', terminusA: 'Central Square', terminusB: 'Airport Terminal 2', active: true },
    { id: 'route-15', code: '15', name: 'Stadium – Old Town', terminusA: 'Stadium North', terminusB: 'Old Town Gate', active: true },
    { id: 'route-31', code: '31', name: 'Westfield – Cemetery Gates', terminusA: 'Westfield Common', terminusB: 'Cemetery Gates', active: false },
  ];

  const shifts = [
    { id: 'shift-early', code: 'EARLY', label: 'Early', startTime: '05:00', endTime: '13:00' },
    { id: 'shift-late', code: 'LATE', label: 'Late', startTime: '13:00', endTime: '21:00' },
    { id: 'shift-night', code: 'NIGHT', label: 'Night', startTime: '21:00', endTime: '05:00' },
  ];

  const sidingPositions = ['A', 'B', 'C'].flatMap((track) =>
    [1, 2, 3, 4].map((index) => ({
      id: `slot-${track}${index}`,
      track,
      slot: `${track}${index}`,
      notes:
        index === 1
          ? 'Roadside, next to the inspection pit'
          : index === 4
            ? 'Under the wash gantry'
            : 'Siding road',
    })),
  );

  const tramCars = [
    { id: 'car-101', fleetNumber: '101', class: 'Tatra T3', status: 'in-service', pantographMm: 14, sidingPositionId: 'slot-A1' },
    { id: 'car-102', fleetNumber: '102', class: 'Tatra T3', status: 'standby', pantographMm: 9, sidingPositionId: 'slot-A2' },
    { id: 'car-103', fleetNumber: '103', class: 'Tatra T3R.P', status: 'maintenance', pantographMm: 52, sidingPositionId: 'slot-B1' },
    { id: 'car-104', fleetNumber: '104', class: 'Tatra T3R.P', status: 'in-service', pantographMm: 27, sidingPositionId: 'slot-B2' },
    { id: 'car-105', fleetNumber: '105', class: 'Škoda 15T', status: 'in-service', pantographMm: 21, sidingPositionId: null },
    { id: 'car-106', fleetNumber: '106', class: 'Škoda 15T', status: 'standby', pantographMm: 33, sidingPositionId: null },
    { id: 'car-107', fleetNumber: '107', class: 'Tatra T3', status: 'in-service', pantographMm: 6, sidingPositionId: null },
    { id: 'car-108', fleetNumber: '108', class: 'Tatra T3R.P', status: 'maintenance', pantographMm: 43, sidingPositionId: null },
    { id: 'car-109', fleetNumber: '109', class: 'Škoda 15T', status: 'in-service', pantographMm: 18, sidingPositionId: 'slot-C1' },
    { id: 'car-110', fleetNumber: '110', class: 'Tatra T3', status: 'standby', pantographMm: 11, sidingPositionId: null },
  ].map((car) => ({ ...car, createdAt }));

  const allocations = DAILY_ROSTER.map((spec) => ({
    id: crypto.randomUUID(),
    ...spec,
    serviceDate: today,
    createdByStaffId: dispatcher,
    createdAt,
    updatedAt: createdAt,
  }));

  const noticeSpec = [
    { carId: 'car-108', severity: 'major', wearMm: 43, note: 'Carbon strip worn at the outer edge; re-check after the next diagram.' },
    { carId: 'car-105', severity: 'minor', wearMm: 21, note: 'Even wear across the strip, still inside tolerance.' },
    { carId: 'car-103', severity: 'critical', wearMm: 52, note: 'Deep grooving near the horn. Car held in the depot pending a strip change.' },
  ];
  const notices = noticeSpec.map((spec) => ({
    id: crypto.randomUUID(),
    ...spec,
    raisedByStaffId: inspector,
    createdAt,
  }));

  return {
    schemaVersion: 1,
    createdAt,
    staff,
    routes,
    shifts,
    sidingPositions,
    tramCars,
    allocations,
    notices,
  };
}

/* ------------------------------------------------------------------ *
 * Domain helpers
 * ------------------------------------------------------------------ */

function byFleetNumber(a, b) {
  return a.fleetNumber.localeCompare(b.fleetNumber, 'en', { numeric: true });
}

function sidingSlotFor(db, car) {
  const slot = db.sidingPositions.find((position) => position.id === car.sidingPositionId);
  return slot ? slot.slot : null;
}

function worstSeverityForCar(db, carId) {
  let worst = null;
  for (const notice of db.notices) {
    if (notice.carId !== carId) continue;
    if (!worst || SEVERITY_RANK[notice.severity] > SEVERITY_RANK[worst]) {
      worst = notice.severity;
    }
  }
  return worst;
}

function carSummary(db, car) {
  return {
    id: car.id,
    fleetNumber: car.fleetNumber,
    class: car.class,
    status: car.status,
    pantographMm: car.pantographMm,
    sidingSlot: sidingSlotFor(db, car),
  };
}

function shiftSummary(shift) {
  return {
    id: shift.id,
    code: shift.code,
    label: shift.label,
    startTime: shift.startTime,
    endTime: shift.endTime,
  };
}

function noticeView(db, notice) {
  const car = db.tramCars.find((candidate) => candidate.id === notice.carId);
  const author = db.staff.find((member) => member.id === notice.raisedByStaffId);
  return {
    id: notice.id,
    carId: notice.carId,
    carFleetNumber: car ? car.fleetNumber : 'unknown',
    severity: notice.severity,
    wearMm: notice.wearMm,
    note: notice.note,
    raisedBy: author ? author.name : 'unknown',
    createdAt: notice.createdAt,
  };
}

function allocationView(db, allocation) {
  const route = db.routes.find((candidate) => candidate.id === allocation.routeId);
  const car = db.tramCars.find((candidate) => candidate.id === allocation.carId);
  const shift = db.shifts.find((candidate) => candidate.id === allocation.shiftId);
  return {
    id: allocation.id,
    serviceDate: allocation.serviceDate,
    routeId: allocation.routeId,
    routeCode: route ? route.code : '—',
    routeName: route ? route.name : 'Unassigned route',
    shiftId: allocation.shiftId,
    shiftLabel: shift ? shift.label : '—',
    carId: allocation.carId,
    carFleetNumber: car ? car.fleetNumber : '—',
    sidingSlot: car ? sidingSlotFor(db, car) : null,
    worstNoticeSeverity: car ? worstSeverityForCar(db, car.id) : null,
    note: allocation.note,
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function validateNote(note, fields, key = 'note') {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') {
    fields[key] = 'Note must be text';
    return '';
  }
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    fields[key] = `Note must be ${MAX_NOTE_LENGTH} characters or fewer`;
  }
  return trimmed;
}

function validateServiceDate(value, fields) {
  if (value === undefined || value === null || value === '') {
    fields.serviceDate = 'Service date is required';
    return null;
  }
  if (!isRealDate(value)) {
    fields.serviceDate = 'Service date must be a real date in YYYY-MM-DD format';
    return null;
  }
  return value;
}

function readAllocationInput(db, body, fields, existingId) {
  const serviceDate = validateServiceDate(body.serviceDate, fields);
  const routeId = text(body.routeId);
  const shiftId = text(body.shiftId);
  const carId = text(body.carId);
  const note = validateNote(body.note, fields);

  const route = db.routes.find((candidate) => candidate.id === routeId);
  const shift = db.shifts.find((candidate) => candidate.id === shiftId);
  const car = db.tramCars.find((candidate) => candidate.id === carId);

  if (!routeId) fields.routeId = 'Route is required';
  else if (!route) fields.routeId = 'Choose a route from the list';
  if (!shiftId) fields.shiftId = 'Shift is required';
  else if (!shift) fields.shiftId = 'Choose a shift from the list';
  if (!carId) fields.carId = 'Tram car is required';
  else if (!car) fields.carId = 'Choose a tram car from the list';

  if (Object.keys(fields).length > 0) return null;

  const clash = db.allocations.find(
    (allocation) =>
      allocation.id !== existingId &&
      allocation.carId === car.id &&
      allocation.routeId === route.id &&
      allocation.shiftId === shift.id &&
      allocation.serviceDate === serviceDate,
  );
  if (clash) {
    fields.carId = `Car ${car.fleetNumber} is already allocated to Route ${route.code} on the ${shift.label} shift for ${serviceDate}`;
    return null;
  }

  return { serviceDate, route, shift, car, note };
}

/* ------------------------------------------------------------------ *
 * API handlers: auth
 * ------------------------------------------------------------------ */

function getDemoAccount() {
  return { status: 200, body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } };
}

function postLogin({ body, db, req }) {
  const fields = {};
  const email = text(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email) fields.email = 'Email is required';
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fields.email = 'Enter a valid email address';
  }
  if (!password) fields.password = 'Password is required';
  if (Object.keys(fields).length > 0) {
    return { status: 400, body: { error: 'Check the highlighted fields', fields } };
  }

  const clientKey = req.socket.remoteAddress || 'unknown';
  if (!throttleLogin(clientKey)) {
    return {
      status: 429,
      headers: { 'Retry-After': '300' },
      body: { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
    };
  }

  const staff = db.staff.find((member) => member.email === email);
  const passwordOk = staff ? verifyPassword(password, staff.passwordHash) : false;
  if (!staff || !passwordOk) {
    return { status: 401, body: { error: 'Email or password is incorrect' } };
  }

  const sid = createSession(staff.id);
  return {
    status: 200,
    headers: { 'Set-Cookie': sidCookie(sid, Math.floor(SESSION_TTL_MS / 1000)) },
    body: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
  };
}

function postLogout({ req }) {
  const sid = readSid(req);
  if (sid) sessions.delete(sid);
  return { status: 204, headers: { 'Set-Cookie': sidCookie('', 0) } };
}

function getSession({ staff }) {
  return {
    status: 200,
    body: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
  };
}

/* ------------------------------------------------------------------ *
 * API handlers: dashboard
 * ------------------------------------------------------------------ */

function getDashboard({ db, url }) {
  const fields = {};
  const serviceDate = validateServiceDate(url.searchParams.get('serviceDate') || localToday(), fields);
  if (!serviceDate) {
    return { status: 400, body: { error: fields.serviceDate, fields } };
  }

  const shiftIdParam = url.searchParams.get('shiftId');
  let shift = null;
  if (shiftIdParam) {
    shift = db.shifts.find((candidate) => candidate.id === shiftIdParam);
    if (!shift) {
      return {
        status: 400,
        body: { error: 'Unknown shift', fields: { shiftId: 'That shift does not exist' } },
      };
    }
  }

  const rows = db.allocations.filter(
    (allocation) =>
      allocation.serviceDate === serviceDate &&
      (shift ? allocation.shiftId === shift.id : true),
  );

  const allocatedCarIds = new Set(rows.map((allocation) => allocation.carId));

  return {
    status: 200,
    body: {
      date: serviceDate,
      shift: shift ? shiftSummary(shift) : null,
      allocations: rows.map((allocation) => allocationView(db, allocation)),
      counters: {
        allocated: allocatedCarIds.size,
        unallocated: Math.max(0, db.tramCars.length - allocatedCarIds.size),
        openNotices: db.notices.length,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * API handlers: allocations
 * ------------------------------------------------------------------ */

function postAllocation({ db, body, staff, persist }) {
  const fields = {};
  const input = readAllocationInput(db, body, fields, null);
  if (!input) return { status: 400, body: { error: 'Check the highlighted fields', fields } };

  const timestamp = new Date().toISOString();
  const allocation = {
    id: crypto.randomUUID(),
    serviceDate: input.serviceDate,
    routeId: input.route.id,
    shiftId: input.shift.id,
    carId: input.car.id,
    note: input.note,
    createdByStaffId: staff.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.allocations.push(allocation);
  persist();
  return { status: 201, body: { allocation: allocationView(db, allocation) } };
}

function patchAllocation({ db, body, params, persist }) {
  const allocation = db.allocations.find((candidate) => candidate.id === params.id);
  if (!allocation) throw new ApiError(404, 'Allocation not found');

  const merged = {
    serviceDate: body.serviceDate !== undefined ? body.serviceDate : allocation.serviceDate,
    routeId: body.routeId !== undefined ? body.routeId : allocation.routeId,
    shiftId: body.shiftId !== undefined ? body.shiftId : allocation.shiftId,
    carId: body.carId !== undefined ? body.carId : allocation.carId,
    note: body.note !== undefined ? body.note : allocation.note,
  };

  const fields = {};
  const input = readAllocationInput(db, merged, fields, allocation.id);
  if (!input) return { status: 400, body: { error: 'Check the highlighted fields', fields } };

  allocation.serviceDate = input.serviceDate;
  allocation.routeId = input.route.id;
  allocation.shiftId = input.shift.id;
  allocation.carId = input.car.id;
  allocation.note = input.note;
  allocation.updatedAt = new Date().toISOString();
  persist();
  return { status: 200, body: { allocation: allocationView(db, allocation) } };
}

function deleteAllocation({ db, params, persist }) {
  const index = db.allocations.findIndex((candidate) => candidate.id === params.id);
  if (index === -1) throw new ApiError(404, 'Allocation not found');
  db.allocations.splice(index, 1);
  persist();
  return { status: 204 };
}

/* ------------------------------------------------------------------ *
 * API handlers: tram cars and siding slots
 * ------------------------------------------------------------------ */

function getCars({ db }) {
  const cars = [...db.tramCars].sort(byFleetNumber).map((car) => carSummary(db, car));
  return { status: 200, body: { cars } };
}

function patchCar({ db, body, params, persist }) {
  const car = db.tramCars.find((candidate) => candidate.id === params.id);
  if (!car) throw new ApiError(404, 'Tram car not found');

  const fields = {};
  const wantsSlot = body.sidingPositionId !== undefined;
  let nextSlot = car.sidingPositionId;

  if (wantsSlot) {
    const raw = body.sidingPositionId;
    if (raw === null || raw === '') {
      nextSlot = null;
    } else if (typeof raw !== 'string') {
      fields.sidingPositionId = 'Siding slot must be a slot id or null';
    } else {
      const slot = db.sidingPositions.find((candidate) => candidate.id === raw);
      if (!slot) {
        fields.sidingPositionId = 'That siding slot does not exist';
      } else {
        const occupant = db.tramCars.find(
          (candidate) => candidate.sidingPositionId === slot.id && candidate.id !== car.id,
        );
        if (occupant) {
          throw new ApiError(409, `Slot ${slot.slot} is occupied by car ${occupant.fleetNumber}`);
        }
        nextSlot = slot.id;
      }
    }
  }

  if (body.status !== undefined) {
    const status = text(body.status);
    if (!CAR_STATUSES.includes(status)) {
      fields.status = `Status must be one of ${CAR_STATUSES.join(', ')}`;
    } else {
      car.status = status;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { status: 400, body: { error: 'Check the highlighted fields', fields } };
  }

  if (wantsSlot) car.sidingPositionId = nextSlot;
  persist();
  return { status: 200, body: { car: carSummary(db, car) } };
}

function getSidings({ db }) {
  const tracks = [...new Set(db.sidingPositions.map((slot) => slot.track))].sort();
  const body = tracks.map((track) => ({
    track,
    slots: db.sidingPositions
      .filter((slot) => slot.track === track)
      .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }))
      .map((slot) => {
        const car = db.tramCars.find((candidate) => candidate.sidingPositionId === slot.id) || null;
        return {
          id: slot.id,
          slot: slot.slot,
          notes: slot.notes,
          car: car
            ? {
                id: car.id,
                fleetNumber: car.fleetNumber,
                class: car.class,
                status: car.status,
                pantographMm: car.pantographMm,
              }
            : null,
        };
      }),
  }));
  return { status: 200, body: { tracks: body } };
}

/* ------------------------------------------------------------------ *
 * API handlers: pantograph notices
 * ------------------------------------------------------------------ */

function getNotices({ db }) {
  const notices = [...db.notices]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((notice) => noticeView(db, notice));
  return { status: 200, body: { notices } };
}

function postNotice({ db, body, staff, persist }) {
  const fields = {};
  const carId = text(body.carId);
  const car = db.tramCars.find((candidate) => candidate.id === carId);
  if (!carId) fields.carId = 'Select a tram car';
  else if (!car) fields.carId = 'Choose a tram car from the list';

  const severity = text(body.severity);
  if (!severity) fields.severity = 'Severity is required';
  else if (!SEVERITIES.includes(severity)) {
    fields.severity = `Severity must be one of ${SEVERITIES.join(', ')}`;
  }

  const rawWear = body.wearMm;
  const wearMm =
    typeof rawWear === 'number'
      ? rawWear
      : typeof rawWear === 'string' && rawWear.trim() !== ''
        ? Number(rawWear)
        : Number.NaN;
  if (!Number.isFinite(wearMm)) {
    fields.wearMm = 'Wear reading is required (0-60 mm)';
  } else if (wearMm < 0 || wearMm > 60) {
    fields.wearMm = 'Wear reading must be between 0 and 60 mm';
  }

  const note = validateNote(body.note, fields);

  if (Object.keys(fields).length > 0) {
    return { status: 400, body: { error: 'Check the highlighted fields', fields } };
  }

  const rounded = Math.round(wearMm * 10) / 10;
  const notice = {
    id: crypto.randomUUID(),
    carId: car.id,
    severity,
    wearMm: rounded,
    note,
    raisedByStaffId: staff.id,
    createdAt: new Date().toISOString(),
  };
  db.notices.push(notice);
  // The inspection is the single write path for wear: the latest reading wins.
  car.pantographMm = rounded;
  persist();

  return {
    status: 201,
    body: { notice: noticeView(db, notice), car: carSummary(db, car) },
  };
}

/* ------------------------------------------------------------------ *
 * API handlers: reference data
 * ------------------------------------------------------------------ */

function getReference({ db }) {
  return {
    status: 200,
    body: {
      routes: db.routes.map((route) => ({
        id: route.id,
        code: route.code,
        name: route.name,
        active: route.active,
      })),
      shifts: db.shifts.map((shift) => shiftSummary(shift)),
      cars: [...db.tramCars].sort(byFleetNumber).map((car) => ({
        id: car.id,
        fleetNumber: car.fleetNumber,
        class: car.class,
        status: car.status,
      })),
      sidings: [...db.sidingPositions]
        .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }))
        .map((slot) => ({ id: slot.id, track: slot.track, slot: slot.slot })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

function route(method, pattern, options, handler) {
  const paramNames = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return {
    method,
    paramNames,
    handler,
    matcher: new RegExp(`^${source}$`),
    auth: options.auth !== false,
    body: options.body !== false,
  };
}

const ROUTES = [
  route('GET', '/api/demo-account', { auth: false }, getDemoAccount),
  route('POST', '/api/auth/login', { auth: false }, postLogin),
  route('POST', '/api/auth/logout', {}, postLogout),
  route('GET', '/api/session', {}, getSession),
  route('GET', '/api/dashboard', {}, getDashboard),
  route('POST', '/api/allocations', {}, postAllocation),
  route('PATCH', '/api/allocations/:id', {}, patchAllocation),
  route('DELETE', '/api/allocations/:id', { body: false }, deleteAllocation),
  route('GET', '/api/cars', {}, getCars),
  route('PATCH', '/api/cars/:id', {}, patchCar),
  route('GET', '/api/sidings', {}, getSidings),
  route('GET', '/api/notices', {}, getNotices),
  route('POST', '/api/notices', {}, postNotice),
  route('GET', '/api/reference', {}, getReference),
];

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
  ].join('; '),
};

function sendJson(res, status, body, extraHeaders) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(extraHeaders || {}),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().includes('application/json')) {
      reject(new ApiError(415, 'Send JSON with Content-Type: application/json'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(new ApiError(400, 'Request body must be valid JSON'));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new ApiError(400, 'Request body must be a JSON object'));
      }
      resolve(parsed);
    });
    req.on('error', (error) => reject(error));
  });
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'Cross-origin request rejected');
  }

  // Accept the host the request arrived on, plus the host a reverse proxy reports.
  const allowedHosts = [req.headers.host, req.headers['x-forwarded-host']]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim());
  if (!allowedHosts.includes(originHost)) {
    throw new ApiError(403, 'Cross-origin request rejected');
  }
}

async function handleApi(req, res, url, pathname, db) {
  const match = ROUTES
    .map((entry) => ({ entry, result: pathname.match(entry.matcher) }))
    .find(({ entry, result }) => entry.method === req.method && result);

  if (!match) {
    return sendJson(res, 404, { error: 'Unknown API endpoint' });
  }

  const { entry, result } = match;
  const params = {};
  entry.paramNames.forEach((name, index) => {
    params[name] = decodeURIComponent(result[index + 1]);
  });

  let staff = null;
  if (entry.auth) {
    staff = staffForRequest(req, db);
    if (!staff) return sendJson(res, 401, { error: 'Not signed in' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    assertSameOrigin(req);
  }

  const wantsBody = entry.body && req.method !== 'GET' && req.method !== 'HEAD';
  const body = wantsBody ? await readJsonBody(req) : {};

  const outcome = await entry.handler({
    req,
    url,
    params,
    body,
    staff,
    db,
    persist: () => saveStore(db),
  });

  if (outcome.status === 204) {
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      ...(outcome.headers || {}),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  return sendJson(res, outcome.status, outcome.body, outcome.headers);
}

/* ------------------------------------------------------------------ *
 * Static assets and the SPA shell
 * ------------------------------------------------------------------ */

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

const SPA_ROUTES = new Set(['/', '/login', '/depot', '/notices']);

/** Resolve a request path to a real file inside public/, or null. */
function resolvePublicFile(pathname) {
  const relative = pathname.replace(/^\/+/, '');
  if (relative === '' || relative.includes('\0')) return null;
  const absolute = path.join(PUBLIC_DIR, relative);
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    if (!fs.statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }
  return absolute;
}

function sendFile(res, absolutePath, type, cache) {
  let payload;
  try {
    payload = fs.readFileSync(absolutePath);
  } catch (error) {
    console.error(`[tram-depot] cannot read ${absolutePath}: ${error.message}`);
    return sendJson(res, 500, { error: 'Static asset missing' });
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  const file = resolvePublicFile(pathname);
  if (file) {
    const extension = path.extname(file).toLowerCase();
    const type = CONTENT_TYPES.get(extension) || 'application/octet-stream';
    const cache = extension === '.woff2' || extension === '.svg'
      ? 'public, max-age=604800'
      : 'public, max-age=300';
    return sendFile(res, file, type, cache);
  }

  if (SPA_ROUTES.has(pathname)) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', 'no-store');
  }

  const shell = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
  res.writeHead(404, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': shell.length,
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(shell);
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

function createServer(db) {
  return http.createServer((req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Malformed URL' });
    }

    res.on('finish', () => {
      console.log(`[tram-depot] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });

    const run = async () => {
      if (pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return handleApi(req, res, url, pathname, db);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(req, res, pathname);
      }
      return sendJson(res, 405, { error: 'Method not allowed' });
    };

    run().catch((error) => {
      if (error instanceof ApiError) {
        return sendJson(res, error.status, {
          error: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        });
      }
      console.error(`[tram-depot] ${req.method} ${pathname} failed:`, error);
      return sendJson(res, 500, { error: 'Something went wrong on the depot server' });
    });
  });
}

function start() {
  let db;
  try {
    db = loadStore();
  } catch (error) {
    console.error(`[tram-depot] cannot start: ${error.message}`);
    process.exit(1);
  }

  const server = createServer(db);
  server.on('error', (error) => {
    console.error(`[tram-depot] server error: ${error.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[tram-depot] listening on http://${HOST}:${PORT}`);
    console.log(`[tram-depot] store: ${DB_PATH}`);
    console.log(`[tram-depot] demo account — email: ${DEMO_EMAIL}  password: ${DEMO_PASSWORD}`);
  });

  const shutdown = (signal) => {
    console.log(`[tram-depot] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start();
}

module.exports = { createServer, seedDatabase, loadStore, hashPassword, verifyPassword, DB_PATH };
