/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'fluent-ffmpeg',
      'ffmpeg-static',
      'ffprobe-static',
      'busboy',
      // unzipper has an optional `@aws-sdk/client-s3` import for streaming from
      // S3 buckets that webpack tries to resolve at build time. We don't use S3,
      // so mark unzipper as external to skip bundling. Same with archiver —
      // both are server-only and have native deps better left to Node.
      'unzipper',
      'archiver',
    ],
    serverActions: {
      bodySizeLimit: '10gb',
    },
  },
};

export default nextConfig;
