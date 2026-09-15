import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sanitize-html"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  async rewrites() {
    return [
      { source: "/:key([a-zA-Z0-9\\-]{8,128}).txt", destination: "/api/indexnow-key" },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
      {
        protocol: "https",
        hostname: "souwesterlodge.com",
      },
    ],
  },
};

// widenClientFileUpload + sourcemap generation are only useful when there's
// an auth token to actually upload them — without one (this spawn has none
// configured) the build was doing the expensive file-widening/sourcemap work
// every time and then discarding it, which was a real contributor to
// build-time OOM kills. Skip that work entirely when there's no token;
// runtime error capture (DSN-based) is unaffected either way.
const hasSentryAuthToken = !!process.env.SENTRY_AUTH_TOKEN;

export default withSentryConfig(nextConfig, {
  org: "chris-bolton",
  project: "directoryone",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: hasSentryAuthToken,
  disableLogger: true,
  sourcemaps: {
    disable: !hasSentryAuthToken,
  },
});
