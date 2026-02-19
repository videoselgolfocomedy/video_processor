/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'fluent-ffmpeg',
      'ffmpeg-static',
      'ffprobe-static',
      'busboy',
    ],
    serverActions: {
      bodySizeLimit: '10gb',
    },
  },
};

export default nextConfig;
