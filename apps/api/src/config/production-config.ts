export function validateProductionConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const jwtSecret = env.JWT_SECRET ?? '';
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 ||
      /^(replace-with|change-me|your-secret|example-secret)/iu.test(jwtSecret)) {
    throw new Error('JWT_SECRET must be a unique random secret of at least 32 bytes in production');
  }
  const webOrigin = env.WEB_ORIGIN ?? '';
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(webOrigin);
  } catch {
    throw new Error('WEB_ORIGIN must be a valid HTTPS origin in production');
  }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== webOrigin ||
      parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' ||
      parsedOrigin.search || parsedOrigin.hash) {
    throw new Error('WEB_ORIGIN must be a single HTTPS origin without credentials, path, query, or fragment');
  }
}
