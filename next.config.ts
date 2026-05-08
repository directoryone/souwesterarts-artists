import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sanitize-html"],
  transpilePackages: ["@directoryone/core", "@directoryone/ui", "@directoryone/app"],
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
    ],
  },
};

export default nextConfig;
