export function validateProductionConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const jwtSecret = env.JWT_SECRET ?? '';
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 ||
      /^(replace-with|change-me|your-secret|example-secret)/iu.test(jwtSecret)) {
    throw new Error('JWT_SECRET must be a unique random secret of at least 32 bytes in production');
  }
  if (!env.WEB_ORIGIN) {
    throw new Error('WEB_ORIGIN must be configured in production');
  }
}
