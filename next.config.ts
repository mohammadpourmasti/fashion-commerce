import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Minimal self-contained server for the Docker image (see Dockerfile). Opt-in
  // so local builds and `next start` behave as usual; standalone output also
  // needs symlink privileges on Windows.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Root layout lives under app/[locale], so unmatched URLs need a
    // standalone 404 document (see src/app/global-not-found.tsx).
    globalNotFound: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
