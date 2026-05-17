import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Standup Video Editor",
  description: "Semi-automated standup comedy video editor",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="dark">
      <head>
        {/*
          Preload the display fonts that text overlays use. `@font-face`
          alone defers the actual download until the browser sees a glyph
          that needs the font — which means the first render of any overlay
          flashes the fallback (sans-serif) and only swaps to Anton/Bebas
          when the network round-trip completes. With <link rel="preload">
          + crossOrigin the browser fetches in parallel with the HTML so the
          fonts are ready before paint. Removed the Google Fonts <link>
          that used to live here — it created a race where the preview
          could fall back to sans-serif (which is much wider than Anton)
          and produce a visibly different rendering than the export.
        */}
        <link rel="preload" href="/fonts/Anton-Regular.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/BebasNeue-Regular.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/Oswald-Bold.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
