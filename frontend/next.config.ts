import type { NextConfig } from "next";

// The browser talks to /api on the Next.js origin; requests are proxied to the FastAPI backend.
const apiOrigin = process.env.EVAL_HARNESS_API_URL ?? "http://127.0.0.1:8000";

// Demo builds run the backend in the browser (src/demo), so there is nothing to proxy.
const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

const nextConfig: NextConfig = {
  devIndicators: { position: "bottom-right" },
  async rewrites() {
    if (demoMode) return [];
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
