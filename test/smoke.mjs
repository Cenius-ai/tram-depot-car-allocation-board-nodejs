import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = mkdtempSync(path.join(tmpdir(), 'tram-depot-'));
const dbPath = path.join(workDir, 'db.json');

let child = null;
let base = '';
let serverLog = '';
let cookie = '';

function todayLocal() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      /* server is still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never became healthy.\n${serverLog}`);
}

async function request(pathname, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && cookie) headers.Cookie = cookie;

  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return { status: response.status, data, headers: response.headers };
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  cookie = '';
  child = spawn(process.execPath, ['main.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  await waitForHealth(base);
}

async function stopServer() {
  if (!child) return;
  const running = child;
  child = null;
  running.kill('SIGTERM');
  await new Promise((resolve) => {
    running.on('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

before(startServer);

after(async () => {
  await stopServer();
  rmSync(workDir, { recursive: true, force: true });
});

test('first boot seeds the depot store on disk', async () => {
  assert.ok(existsSync(dbPath), 'data store should be created on first boot');
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  assert.equal(db.staff.length, 4);
  assert.equal(db.routes.length, 6);
  assert.equal(db.shifts.length, 3);
  assert.equal(db.tramCars.length, 10);
  assert.equal(db.sidingPositions.length, 12);
  assert.ok(db.allocations.length >= 7);
  assert.equal(db.notices.length, 3);
  assert.ok(db.staff.every((member) => String(member.passwordHash).startsWith('scrypt$')));
  assert.ok(!('password' in db.staff[0]), 'plaintext passwords must never be stored');
});

test('the seeded notices agree with each car pantograph reading', async () => {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  // the newest notice per car defines the car's reading
  for (const car of db.tramCars) {
    const carNotices = db.notices.filter((notice) => notice.carId === car.id);
    if (!carNotices.length) continue;
    const latest = carNotices[carNotices.length - 1];
    assert.equal(car.pantographMm, latest.wearMm, `car ${car.fleetNumber} reading mismatch`);
  }
});

test('demo account is published and signs in with an HttpOnly sid cookie', async () => {
  const demo = await request('/api/demo-account', { auth: false });
  assert.equal(demo.status, 200);
  assert.equal(demo.data.email, 'cenius@cenius.ai');
  assert.equal(demo.data.password, 'cenius');

  const login = await request('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email: demo.data.email, password: demo.data.password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.email, 'cenius@cenius.ai');
  assert.equal(login.data.role, 'dispatcher');
  assert.ok(!('passwordHash' in login.data));

  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('sid='), 'login must set the sid cookie');
  assert.match(setCookie, /HttpOnly/i);
  cookie = setCookie.split(';')[0];
});

test('a wrong password yields one non-enumerating message', async () => {
  const response = await request('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email: 'cenius@cenius.ai', password: '***REDACTED-SECRET***' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.data.error, 'Email or password is incorrect');
});

test('the session survives a refresh through GET /api/session', async () => {
  const session = await request('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.email, 'cenius@cenius.ai');

  const anonymous = await request('/api/session', { auth: false });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.error, 'Not signed in');

  const bogus = await request('/api/session', { auth: false, headers: { Cookie: 'sid=not-a-real-session' } });
  assert.equal(bogus.status, 401);
});

test('reference data feeds every form control', async () => {
  const reference = await request('/api/reference');
  assert.equal(reference.status, 200);
  assert.equal(reference.data.routes.length, 6);
  assert.equal(reference.data.shifts.length, 3);
  assert.equal(reference.data.cars.length, 10);
  assert.equal(reference.data.sidings.length, 12);
});

test('cars and sidings are readable and consistent', async () => {
  const cars = await request('/api/cars');
  assert.equal(cars.status, 200);
  assert.equal(cars.data.cars.length, 10);
  assert.deepEqual(
    cars.data.cars.map((car) => car.fleetNumber),
    ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110'],
  );

  const sidings = await request('/api/sidings');
  assert.equal(sidings.status, 200);
  assert.deepEqual(sidings.data.tracks.map((track) => track.track), ['A', 'B', 'C']);
  assert.equal(sidings.data.tracks.reduce((total, track) => total + track.slots.length, 0), 12);

  const unauthorised = await request('/api/cars', { auth: false });
  assert.equal(unauthorised.status, 401);
});

test('the dashboard aggregates the seeded Early shift board', async () => {
  const shift = (await request('/api/reference')).data.shifts.find((entry) => entry.code === 'EARLY');
  const board = await request(`/api/dashboard?serviceDate=${todayLocal()}&shiftId=${shift.id}`);
  assert.equal(board.status, 200);
  assert.equal(board.data.allocations.length, 4);
  assert.ok(board.data.allocations.every((allocation) => allocation.routeCode));
  assert.ok(board.data.allocations.every((allocation) => allocation.carFleetNumber));
  assert.equal(board.data.counters.allocated, 4);
  assert.equal(board.data.counters.unallocated, 6);
  assert.equal(board.data.counters.openNotices, 3);
  assert.ok(board.data.allocations.some((allocation) => allocation.worstNoticeSeverity === 'critical'));

  const empty = await request(`/api/dashboard?serviceDate=2020-01-02&shiftId=${shift.id}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.allocations, []);
  assert.equal(empty.data.counters.allocated, 0);

  const malformed = await request(`/api/dashboard?serviceDate=2025-13-40&shiftId=${shift.id}`);
  assert.equal(malformed.status, 400);
  assert.match(JSON.stringify(malformed.data), /serviceDate/);
});

test('allocations can be created, validated, edited and deleted', async () => {
  const reference = (await request('/api/reference')).data;
  const early = reference.shifts.find((shift) => shift.code === 'EARLY');
  const route = reference.routes.find((entry) => entry.code === '22');
  const car = reference.cars.find((entry) => entry.fleetNumber === '110');
  const payload = { serviceDate: todayLocal(), routeId: route.id, shiftId: early.id, carId: car.id, note: 'Smoke test allocation' };

  const created = await request('/api/allocations', { method: 'POST', body: payload });
  assert.equal(created.status, 201);
  assert.equal(created.data.allocation.carFleetNumber, '110');

  const board = await request(`/api/dashboard?serviceDate=${todayLocal()}&shiftId=${early.id}`);
  assert.ok(board.data.allocations.some((allocation) => allocation.id === created.data.allocation.id));

  const duplicate = await request('/api/allocations', { method: 'POST', body: payload });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.data.fields.carId, /already allocated to Route 22/);

  const badRoute = await request('/api/allocations', {
    method: 'POST',
    body: { ...payload, routeId: 'route-does-not-exist' },
  });
  assert.equal(badRoute.status, 400);
  assert.ok(badRoute.data.fields.routeId);

  const otherCar = reference.cars.find((entry) => entry.fleetNumber === '109');
  const patched = await request(`/api/allocations/${created.data.allocation.id}`, {
    method: 'PATCH',
    body: { carId: otherCar.id },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.allocation.carFleetNumber, '109');

  const removed = await request(`/api/allocations/${created.data.allocation.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);

  const after = await request(`/api/dashboard?serviceDate=${todayLocal()}&shiftId=${early.id}`);
  assert.ok(!after.data.allocations.some((allocation) => allocation.id === created.data.allocation.id));
});

test('a notice validates severity and 0-60 mm and syncs the car reading', async () => {
  const cars = (await request('/api/cars')).data.cars;
  const car = cars.find((entry) => entry.fleetNumber === '108');

  const created = await request('/api/notices', {
    method: 'POST',
    body: { carId: car.id, severity: 'major', wearMm: 47, note: 'Carbon strip re-measured at the pit.' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.notice.severity, 'major');
  assert.equal(created.data.notice.wearMm, 47);

  const list = await request('/api/notices');
  assert.equal(list.data.notices[0].carFleetNumber, '108');
  assert.equal(list.data.notices[0].wearMm, 47);

  const synced = (await request('/api/cars')).data.cars.find((entry) => entry.fleetNumber === '108');
  assert.equal(synced.pantographMm, 47);

  const tooWorn = await request('/api/notices', {
    method: 'POST',
    body: { carId: car.id, severity: 'minor', wearMm: 61 },
  });
  assert.equal(tooWorn.status, 400);
  assert.equal(tooWorn.data.fields.wearMm, 'Wear reading must be between 0 and 60 mm');

  const negative = await request('/api/notices', {
    method: 'POST',
    body: { carId: car.id, severity: 'minor', wearMm: -1 },
  });
  assert.equal(negative.status, 400);
  assert.equal(negative.data.fields.wearMm, 'Wear reading must be between 0 and 60 mm');

  const badSeverity = await request('/api/notices', {
    method: 'POST',
    body: { carId: car.id, severity: 'urgent', wearMm: 20 },
  });
  assert.equal(badSeverity.status, 400);
  assert.equal(badSeverity.data.fields.severity, 'Severity must be one of minor, major, critical');

  const unchanged = (await request('/api/cars')).data.cars.find((entry) => entry.fleetNumber === '108');
  assert.equal(unchanged.pantographMm, 47, 'a rejected notice must not touch the car reading');
});

test('siding occupancy is enforced on the server', async () => {
  const sidings = (await request('/api/sidings')).data.tracks;
  const slotA1 = sidings[0].slots.find((slot) => slot.slot === 'A1');
  const cars = (await request('/api/cars')).data.cars;
  const other = cars.find((entry) => entry.fleetNumber === '106');

  const conflict = await request(`/api/cars/${other.id}`, {
    method: 'PATCH',
    body: { sidingPositionId: slotA1.id },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, `Slot A1 is occupied by car ${slotA1.car.fleetNumber}`);

  const freeSlot = sidings[1].slots.find((slot) => !slot.car);
  const assigned = await request(`/api/cars/${other.id}`, {
    method: 'PATCH',
    body: { sidingPositionId: freeSlot.id },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.car.sidingSlot, freeSlot.slot);

  const released = await request(`/api/cars/${other.id}`, {
    method: 'PATCH',
    body: { sidingPositionId: null },
  });
  assert.equal(released.status, 200);
  assert.equal(released.data.car.sidingSlot, null);
});

test('signed-out visitors cannot write anything', async () => {
  const reference = (await request('/api/reference')).data;
  const notice = (await request('/api/notices')).data.notices[0];
  const allocation = (await request(`/api/dashboard?serviceDate=${todayLocal()}&shiftId=${reference.shifts[0].id}`)).data.allocations[0];

  const createAllocation = await request('/api/allocations', {
    method: 'POST',
    auth: false,
    body: {
      serviceDate: todayLocal(),
      routeId: reference.routes[0].id,
      shiftId: reference.shifts[0].id,
      carId: reference.cars[0].id,
    },
  });
  assert.equal(createAllocation.status, 401);

  const createNotice = await request('/api/notices', {
    method: 'POST',
    auth: false,
    body: { carId: notice.carId, severity: 'minor', wearMm: 10 },
  });
  assert.equal(createNotice.status, 401);

  const patchAllocation = await request(`/api/allocations/${allocation.id}`, {
    method: 'PATCH',
    auth: false,
    body: { note: 'hijacked' },
  });
  assert.equal(patchAllocation.status, 401);

  const deleteAllocation = await request(`/api/allocations/${allocation.id}`, { method: 'DELETE', auth: false });
  assert.equal(deleteAllocation.status, 401);
});

test('signing out clears the session', async () => {
  const logout = await request('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(logout.status, 204);
  const session = await request('/api/session', { auth: false });
  assert.equal(session.status, 401);
  cookie = '';
});

test('static assets and the SPA shell are served from the app origin', async () => {
  const home = await request('/', { auth: false });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);

  const login = await request('/login', { auth: false });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type'), /text\/html/);

  const script = await request('/app.js', { auth: false });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const styles = await request('/styles.css', { auth: false });
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /text\/css/);

  const font = await request('/fonts/hanken-400.woff2', { auth: false });
  assert.equal(font.status, 200);

  const health = await request('/health', { auth: false });
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');

  const missing = await request('/api/does-not-exist', { auth: false });
  assert.equal(missing.status, 404);
  assert.ok(missing.data.error);
});

test('writes are durable: the store file holds the new notice', async () => {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  assert.ok(db.notices.length >= 4);
  assert.ok(db.notices.some((notice) => notice.wearMm === 47));
  const car = db.tramCars.find((entry) => entry.fleetNumber === '108');
  assert.equal(car.pantographMm, 47);
});

test('a store left over from an earlier day is topped up on the next boot', async () => {
  await stopServer();

  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  db.allocations = db.allocations.map((allocation) => ({ ...allocation, serviceDate: '2020-01-02' }));
  writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await startServer();

  const demo = (await request('/api/demo-account', { auth: false })).data;
  const login = await request('/api/auth/login', { method: 'POST', auth: false, body: demo });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const early = (await request('/api/reference')).data.shifts.find((shift) => shift.code === 'EARLY');
  const board = await request(`/api/dashboard?serviceDate=${todayLocal()}&shiftId=${early.id}`);
  assert.equal(board.status, 200);
  assert.equal(board.data.allocations.length, 4, 'today must open on a populated board');
  assert.equal(board.data.counters.allocated, 4);
});
