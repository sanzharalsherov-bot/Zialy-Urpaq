import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { registerDecorator, ValidationOptions } from 'class-validator';

export const JWT_ISSUER = 'zaily-urpaq-api';
export const JWT_AUDIENCE = 'zaily-urpaq-web';

export function normalizeName(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 100 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new BadRequestException('Введите имя и фамилию без управляющих и невидимых символов');
  }
  return normalized;
}

export function sharedStudentSubject(firstName: string, lastName: string): string {
  const identity = `${firstName.toLocaleLowerCase('ru-RU')}\u0000${lastName.toLocaleLowerCase('ru-RU')}`;
  return `shared-student:${createHash('sha256').update(identity).digest('hex')}`;
}

export function studentCodeVersion(hash: string): string {
  return createHash('sha256').update(hash).digest('hex');
}

export function validatePasswordBytes(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new BadRequestException('Пароль должен занимать не более 72 байт UTF-8 (кириллица — обычно 2 байта на символ)');
  }
}

export function MaxPasswordBytes(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({
    name: 'maxPasswordBytes', target: target.constructor, propertyName: String(propertyKey),
    options: { message: 'Пароль должен занимать не более 72 байт UTF-8', ...options },
    validator: { validate: value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72 },
  });
}

type Bucket = { count: number; resetAt: number };

/** Failed attempts are bounded across IPs; successful classroom logins release their reservation. */
export class LoginAttempts {
  private readonly buckets = new Map<string, Bucket>();
  private lastCleanup = 0;

  reserve(key: string, limit: number, now = Date.now()): () => void {
    if (now - this.lastCleanup >= 60_000 || this.buckets.size >= 20_000) {
      for (const [knownKey, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(knownKey);
      this.lastCleanup = now;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= 20_000) this.reject();
      bucket = { count: 0, resetAt: now + 15 * 60_000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) this.reject();
    bucket.count++;
    let released = false;
    return () => {
      if (!released) bucket.count = Math.max(0, bucket.count - 1);
      released = true;
    };
  }

  private reject(): never {
    throw new HttpException('Слишком много попыток входа. Повторите через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
