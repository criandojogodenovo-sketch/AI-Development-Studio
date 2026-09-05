import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone apenas para self-host/local (o "start" usa .next/standalone/server.js).
  // Na Vercel (VERCEL=1) o output permanece padrão — o adapter @vercel/next cuida do bundle.
  output: process.env.VERCEL ? undefined : "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
