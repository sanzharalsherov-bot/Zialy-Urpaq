const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const bcrypt = require('bcryptjs');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { JwtService } = require('@nestjs/jwt');
const { AuthService } = require('../dist/auth/auth.service');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const { RolesGuard } = require('../dist/auth/roles.guard');
const { LoginDto, BootstrapAdminDto, CreateUserDto, SharedStudentLoginDto } = require('../dist/auth/auth.dto');
const { LoginAttempts, normalizeName, sharedStudentSubject, JWT_ISSUER, JWT_AUDIENCE } = require('../dist/auth/auth.security');

const secret = 'auth-unit-test-secret-never-use-in-production-1';
process.env.JWT_SECRET = secret;
process.env.BOOTSTRAP_ADMIN_KEY = 'auth-unit-bootstrap-test-key';
const jwt = new JwtService({ secret, signOptions: { expiresIn: '2h', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' } });
const status = code => error => error?.getStatus?.() === code;
const makeContext = token => {
  const request = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  return { request, switchToHttp: () => ({ getRequest: () => request }), getHandler: () => () => {}, getClass: () => class {} };
};
const validateDto = (Type, value) => validate(plainToInstance(Type, value), { whitelist: true, forbidNonWhitelisted: true });

test('auth validation rejects blank/invisible names and bcrypt byte truncation, normalizes emails', async () => {
  const base = { email: ' teacher@example.test ', password: 'Д'.repeat(36), firstName: ' Айша ', lastName: '  Алиева  ', role: 'TEACHER' };
  assert.deepEqual(await validateDto(CreateUserDto, base), []);
  const value = plainToInstance(CreateUserDto, { ...base, email: ' TEACHER@example.test ' });
  assert.equal(value.email, 'teacher@example.test');
  assert.equal(value.firstName, 'Айша');
  for (const changes of [{ password: 'Д'.repeat(37) }, { password: 'a'.repeat(72) + 'b' },
    { password: ' '.repeat(12) }, { firstName: '  ' }, { firstName: '\u200b' }, { lastName: '\u0000Ali' }, { role: 'ADMIN' }]) {
    assert.ok((await validateDto(CreateUserDto, { ...base, ...changes })).length > 0, JSON.stringify(changes));
  }
  assert.ok((await validateDto(LoginDto, { email: 'teacher@example.test', password: 'Ж'.repeat(37) })).length > 0);
  assert.ok((await validateDto(SharedStudentLoginDto, { accessCode: '123456', firstName: ' ', lastName: 'Name' })).length > 0);
  assert.ok((await validateDto(BootstrapAdminDto, { ...base, bootstrapKey: 'test', studentAccessCode: '123456', password: 'short' })).length > 0);
});

test('student identity is stable for case and normalized whitespace, invisible substitutions fail', () => {
  assert.equal(sharedStudentSubject(normalizeName('  АЙША  '), normalizeName('Алиева')),
    sharedStudentSubject(normalizeName('Айша'), normalizeName('АЛИЕВА')));
  assert.equal(normalizeName('Ａli'), 'Ali');
  assert.throws(() => normalizeName('Ай\u200bша'), status(400));
});

test('failed-login reservations cannot be raced and successful logins release only their own reservation', () => {
  const attempts = new LoginAttempts();
  const release = attempts.reserve('account', 2, 1000);
  attempts.reserve('account', 2, 1000);
  assert.throws(() => attempts.reserve('account', 2, 1000), status(429));
  release(); release();
  attempts.reserve('account', 2, 1000);
  assert.throws(() => attempts.reserve('account', 2, 1000), status(429));
  assert.doesNotThrow(() => attempts.reserve('account', 2, 901001));
});

test('staff brute force is blocked per normalized account across changing source IPs', async () => {
  const passwordHash = await bcrypt.hash('Correct-password!', 4);
  let reads = 0;
  const service = new AuthService({ user: { findUnique: async () => { reads++; return { id: 'staff', isActive: true, role: 'TEACHER', passwordHash }; } } }, jwt);
  for (let index = 0; index < 10; index++) {
    await assert.rejects(() => service.login({ email: index % 2 ? ' Teacher@example.test ' : 'teacher@example.test', password: 'Wrong-password!' }, `192.0.2.${index}`), status(401));
  }
  await assert.rejects(() => service.login({ email: 'teacher@example.test', password: 'Wrong-password!' }, '192.0.2.200'), status(429));
  assert.equal(reads, 10, 'blocked request must not reach the DB or password hashing');
});

test('valid staff logins do not exhaust the failed-login quota and response excludes password hash', async () => {
  const passwordHash = await bcrypt.hash('Correct-password!', 4);
  const service = new AuthService({ user: { findUnique: async () => ({ id: 'staff', email: 'teacher@example.test', isActive: true, role: 'TEACHER', passwordHash, firstName: 'Teacher', lastName: 'One' }) } }, jwt);
  for (let index = 0; index < 12; index++) {
    const result = await service.login({ email: 'teacher@example.test', password: 'Correct-password!' }, '192.0.2.1');
    assert.ok(result.accessToken);
    assert.equal('passwordHash' in result.user, false);
    assert.equal(result.expiresIn, 7200);
  }
});

test('bootstrap rechecks the account count under a database transaction lock', async () => {
  const operations = [];
  let writes = 0;
  const service = new AuthService({ user: { count: async () => 0 }, $transaction: async work => work({
    $executeRaw: async strings => { operations.push(strings.join('?')); },
    user: { count: async () => { operations.push('count'); return 1; }, create: async () => { writes++; } },
  }) }, jwt);
  const dto = { email: 'first@example.test', password: 'Strong-password!', firstName: 'First', lastName: 'Admin', bootstrapKey: process.env.BOOTSTRAP_ADMIN_KEY, studentAccessCode: 'Code-123456' };
  await assert.rejects(() => service.bootstrapAdmin(dto), status(409));
  assert.match(operations[0], /pg_advisory_xact_lock/);
  assert.equal(operations[1], 'count');
  assert.equal(writes, 0);
  await assert.rejects(() => service.bootstrapAdmin({ ...dto, bootstrapKey: 'wrong-key' }), status(401));
});

test('creating a user cannot elevate the role; concurrent duplicate emails return 409', async () => {
  const service = new AuthService({ user: { findUnique: async () => null, create: async () => { throw { code: 'P2002' }; } } }, jwt);
  const dto = { email: 'teacher@example.test', password: 'Strong-password!', firstName: 'Teacher', lastName: 'One', role: 'TEACHER' };
  await assert.rejects(() => service.createUser({ ...dto, role: 'ADMIN' }), status(400));
  await assert.rejects(() => service.createUser(dto), status(409));
});

test('JWT rejects forgery, expired/missing expiry, wrong audience, unsupported algorithms and malformed claims', async () => {
  let reads = 0;
  const guard = new JwtAuthGuard(jwt, { user: { findUnique: async () => { reads++; return null; } } });
  const bare = new JwtService({ secret });
  const claim = { sub: 'staff', role: 'ADMIN', iss: JWT_ISSUER, aud: JWT_AUDIENCE };
  const invalid = [
    await new JwtService({ secret: 'different-secret' }).signAsync(claim, { expiresIn: '1h' }),
    await bare.signAsync(claim, { expiresIn: -1 }),
    await bare.signAsync(claim),
    await bare.signAsync({ ...claim, aud: 'another-app' }, { expiresIn: '1h' }),
    await bare.signAsync(claim, { algorithm: 'HS384', expiresIn: '1h' }),
    await bare.signAsync({ ...claim, sub: 'x'.repeat(129) }, { expiresIn: '1h' }),
    await bare.signAsync({ ...claim, kind: 'admin-backdoor' }, { expiresIn: '1h' }),
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.',
  ];
  for (const token of invalid) await assert.rejects(() => guard.canActivate(makeContext(token)), status(401));
  await assert.rejects(() => guard.canActivate(makeContext()), status(401));
  assert.equal(reads, 0);
});

test('current database role and active flag override JWT claims; DB outages are not invalid-password errors', async () => {
  const token = await jwt.signAsync({ sub: 'staff', role: 'ADMIN' });
  const row = { id: 'staff', email: 'teacher@example.test', role: 'TEACHER', isActive: true };
  let unavailable = false;
  const guard = new JwtAuthGuard(jwt, { user: { findUnique: async () => { if (unavailable) throw Error('database offline'); return row; } } });
  const context = makeContext(token);
  await guard.canActivate(context);
  assert.equal(context.request.user.role, 'TEACHER');
  const roles = new RolesGuard({ getAllAndOverride: () => ['ADMIN'] });
  assert.throws(() => roles.canActivate(context), status(403));
  row.isActive = false;
  await assert.rejects(() => guard.canActivate(makeContext(token)), status(401));
  row.isActive = true;
  unavailable = true;
  await assert.rejects(() => guard.canActivate(makeContext(token)), status(503));
});

test('rotating student code revokes existing tokens and student sessions cannot claim admin role', async () => {
  const { createHash } = require('node:crypto');
  let settings = { studentAccessCodeHash: await bcrypt.hash(createHash('sha256').update('Code-123456').digest('base64'), 4) };
  const prisma = { schoolSettings: { findUnique: async () => settings, upsert: async args => { settings = args.update; return settings; } }, user: { findMany: async () => [{ id: 'student-user-1', studentProfile: { id: 'student-profile-1' } }] }, studentProfile: { findUnique: async () => ({ id: 'student-profile-1', user: { isActive: true, role: 'STUDENT', firstName: 'Айша', lastName: 'Алиева' } }) } };
  const service = new AuthService(prisma, jwt);
  const guard = new JwtAuthGuard(jwt, prisma);
  const login = await service.loginSharedStudent({ accessCode: 'Code-123456', firstName: ' Айша ', lastName: 'Алиева' }, '192.0.2.1');
  const context = makeContext(login.accessToken);
  assert.equal(await guard.canActivate(context), true);
  assert.equal(context.request.user.role, 'STUDENT');
  const decoded = jwt.decode(login.accessToken);
  delete decoded.iat; delete decoded.exp; delete decoded.iss; delete decoded.aud;
  const forgedRole = await jwt.signAsync({ ...decoded, role: 'ADMIN' });
  await assert.rejects(() => guard.canActivate(makeContext(forgedRole)), status(401));
  await service.updateStudentAccessCode({ accessCode: 'New-code-123456' });
  await assert.rejects(() => guard.canActivate(makeContext(login.accessToken)), status(401));
  await assert.rejects(() => service.loginSharedStudent({ accessCode: 'Code-123456', firstName: 'Айша', lastName: 'Алиева' }), status(401));
  const newLogin = await service.loginSharedStudent({ accessCode: 'New-code-123456', firstName: 'Айша', lastName: 'Алиева' });
  assert.equal(await guard.canActivate(makeContext(newLogin.accessToken)), true);
});
