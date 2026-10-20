export function validateProductionConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const jwtSecret = env.JWT_SECRET ?? '';
  const jwtBytes = Buffer.byteLength(jwtSecret, 'utf8');
  const looksLikePlaceholder = /^(replace-with|change-me|your-secret|example-secret)/iu.test(jwtSecret);
  const hasLowCharacterDiversity = new Set(jwtSecret).size < 12;
  const repeatsShortPattern = /^(.{1,4})\1+$/u.test(jwtSecret);
  const reusesAnotherSecret = [env.POSTGRES_PASSWORD, env.BOOTSTRAP_ADMIN_KEY, env.LIVEKIT_API_SECRET]
    .some(secret => typeof secret === 'string' && secret.length > 0 && secret === jwtSecret);

  if (jwtBytes < 32 || looksLikePlaceholder || hasLowCharacterDiversity ||
      repeatsShortPattern || reusesAnotherSecret) {
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
