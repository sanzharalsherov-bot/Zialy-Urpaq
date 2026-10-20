
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
});

export function configureApplication(app: NestExpressApplication) {
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET ?? '';
    if (Buffer.byteLength(jwtSecret, 'utf8') < 32 ||
        /^(replace-with|change-me|your-secret|example-secret)/iu.test(jwtSecret)) {
      throw new Error('JWT_SECRET must be a unique random secret of at least 32 bytes in production');
    }
  }
  if (process.env.NODE_ENV === 'production' && !process.env.WEB_ORIGIN) {
    throw new Error('WEB_ORIGIN must be configured in production');
  }
  app.setGlobalPrefix('api');
  const server = app.getHttpAdapter().getInstance();
  server.disable('x-powered-by');
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5');
  }
  server.set('trust proxy', trustProxyHops);
  const windows = new Map<string, { count: number; resetAt: number }>();
  const minute = 60_000;
  const limiter = (id: string, max: number, duration: number) =>
    (req: any, res: any, next: () => void) => {
      const now = Date.now();
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const key = `${id}:${ip}`;
      let bucket = windows.get(key);
      if (!bucket || bucket.resetAt <= now) {
        if (windows.size >= 50_000) {
          for (const [knownKey, known] of windows) if (known.resetAt <= now) windows.delete(knownKey);
        }
        if (windows.size >= 50_000) {
          res.setHeader('Retry-After', '60');
          return res.status(429).json({ statusCode: 429, message: 'Слишком много запросов. Повторите позже.' });
        }
        bucket = { count: 0, resetAt: now + duration };
        windows.set(key, bucket);
      }
      bucket.count++;
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
      if (bucket.count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        return res.status(429).json({ statusCode: 429, message: 'Слишком много запросов. Повторите позже.' });
      }
      next();
    };

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of windows) if (bucket.resetAt <= now) windows.delete(key);
  }, minute);
  cleanup.unref();

  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // A school can have hundreds of students behind one public IP. Per-user
  // quotas are enforced after JWT verification in JwtAuthGuard.
  app.use('/api', limiter('api', 30000, minute));
  app.use('/api/auth/login', limiter('account-login', 120, 15 * minute));
  app.use('/api/auth/student-access', limiter('student-access-login', 1200, 15 * minute));
  app.use('/api/auth/bootstrap-admin', limiter('admin-bootstrap', 5, 60 * minute));
  const liveKitTokenLimiter = limiter('livekit-token', 600, minute);
  app.use('/api', (req: any, res: any, next: () => void) => {
    const path = String(req.originalUrl || '').split('?', 1)[0];
    if (req.method === 'POST' && /^\/api\/(?:rooms\/[^/]+\/livekit-token|student\/rooms\/[^/]+\/v2\/livekit-token)$/u.test(path)) {
      return liveKitTokenLimiter(req, res, next);
    }
    next();
  });

  // Limits run before parsing; compressed requests cannot inflate into a large in-memory body.
  app.useBodyParser('json', { limit: '1mb', strict: true, inflate: false });
  app.useBodyParser('urlencoded', { limit: '16kb', extended: false, parameterLimit: 100, inflate: false });

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3100',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const httpServer = app.getHttpServer();
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxRequestsPerSocket = 1000;
  httpServer.on('close', () => clearInterval(cleanup));
}

async function bootstrap() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApplication(app);

  const port = Number(process.env.API_PORT ?? 4000);

  await app.listen(port);
  console.log(`Zialy Urpaq API listening on http://localhost:${port}/api`);
}

if (require.main === module) {
  bootstrap().catch(error => {
    console.error(error instanceof Error ? error.message : 'API startup failed');
    process.exitCode = 1;
  });
}
