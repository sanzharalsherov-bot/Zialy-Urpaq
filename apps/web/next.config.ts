import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  output: 'standalone',
  // Production builds must not replace CSS/chunks used by a running dev server.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  poweredByHeader: false,
  async rewrites() {
    return process.env.NODE_ENV === 'development'
      ? [{ source: '/api/:path*', destination: 'http://127.0.0.1:4000/api/:path*' }]
      : [];
  },
  async headers() {
    let apiOrigin = "'self'";
    try {
      const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';
      apiOrigin = configuredApiUrl.startsWith('/')
        ? "'self'"
        : new URL(configuredApiUrl).origin;
    } catch {
      // Keep the policy closed to unknown origins when the API URL is malformed.
    }
    const headers = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    if (process.env.NODE_ENV === 'production') {
      headers.push(
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        { key: 'Content-Security-Policy', value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ${apiOrigin}` },
      );
    }
    return [{ source: '/:path*', headers }];
  },
};
export default nextConfig;
