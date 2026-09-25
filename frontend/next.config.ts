import type { NextConfig } from "next";

// The browser talks to /api on the Next.js origin; requests are proxied to the FastAPI backend.
const apiOrigin = process.env.EVAL_HARNESS_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  devIndicators: { position: "bottom-right" },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
