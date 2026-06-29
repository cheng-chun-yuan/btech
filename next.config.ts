import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The app is reached via the cloudflared tunnel host in dev; allow it to load
  // the dev/HMR client assets so React can hydrate (otherwise the UI is not clickable).
  allowedDevOrigins: ["btech.polyoctant.com"],
};

export default nextConfig;
