import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: {
    root: process.cwd(),
  },
  // Dev-server only (has no effect on production builds): without this,
  // Next.js blocks cross-origin requests to /_next/* — including the HMR
  // websocket — from any host other than localhost. Loading the admin app
  // from a phone via the dev machine's LAN IP hit that block, which made
  // Turbopack's HMR client repeatedly force full-page reloads while the
  // websocket kept failing to connect. That reload loop made the page
  // reload out from under in-progress interactions (e.g. mid-login), which
  // is what made the login button behave unreliably on LAN access.
  allowedDevOrigins: ["192.168.*.*"],
};

export default nextConfig;
