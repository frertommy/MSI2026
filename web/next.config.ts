import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone режим: Next.js собирает минимальный набор файлов для запуска в Docker
  output: "standalone",
};

export default nextConfig;
