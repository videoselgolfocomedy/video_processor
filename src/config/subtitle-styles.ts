import type { SubtitleStyle, SubtitleConstraints } from '@/types/project';

export const DEFAULT_CONSTRAINTS: SubtitleConstraints = {
  maxCharsPerBlock: 80,
  maxDurationMs: 7000,
};

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  style: SubtitleStyle;
}

const baseStyle: SubtitleStyle = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontWeight: 700,
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 3,
  backgroundColor: 'transparent',
  backgroundPadding: 8,
  backgroundRadius: 4,
  position: 'bottom',
  marginBottom: 80,
  animation: 'none',
  highlightColor: '#FFD700',
  textTransform: 'none',
  maxWidth: 900,
  lineHeight: 1.3,
  shadowColor: 'rgba(0,0,0,0.8)',
  shadowBlur: 8,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'youtube-classic',
    name: 'YouTube Classic',
    description: 'Clean white text with dark outline, bottom position',
    thumbnail: 'Aa',
    style: {
      ...baseStyle,
    },
  },
  {
    id: 'tiktok-viral',
    name: 'TikTok Viral',
    description: 'Bold centered text with word-by-word highlight',
    thumbnail: 'Tt',
    style: {
      ...baseStyle,
      fontSize: 56,
      fontWeight: 900,
      position: 'center',
      animation: 'word-highlight',
      highlightColor: '#FFE135',
      textTransform: 'uppercase',
      strokeWidth: 4,
      maxWidth: 700,
    },
  },
  {
    id: 'mrbeast',
    name: 'MrBeast',
    description: 'Large yellow highlighted words, high energy',
    thumbnail: 'MB',
    style: {
      ...baseStyle,
      fontSize: 64,
      fontWeight: 900,
      color: '#FFFFFF',
      highlightColor: '#FF0000',
      animation: 'pop',
      textTransform: 'uppercase',
      strokeWidth: 5,
      strokeColor: '#000000',
      position: 'center',
      maxWidth: 800,
    },
  },
  {
    id: 'netflix',
    name: 'Netflix',
    description: 'Elegant white text with subtle background',
    thumbnail: 'NF',
    style: {
      ...baseStyle,
      fontFamily: 'Georgia',
      fontSize: 42,
      fontWeight: 400,
      strokeWidth: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
      backgroundPadding: 12,
      backgroundRadius: 2,
      shadowBlur: 0,
      position: 'bottom',
      marginBottom: 60,
    },
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description: 'Word-by-word color change, great for music',
    thumbnail: 'KR',
    style: {
      ...baseStyle,
      fontSize: 52,
      fontWeight: 800,
      color: 'rgba(255,255,255,0.4)',
      highlightColor: '#00FF88',
      animation: 'word-highlight',
      strokeWidth: 2,
      position: 'bottom',
      marginBottom: 100,
    },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Small, clean subtitles at the bottom',
    thumbnail: 'Mn',
    style: {
      ...baseStyle,
      fontSize: 32,
      fontWeight: 400,
      strokeWidth: 0,
      shadowBlur: 4,
      shadowColor: 'rgba(0,0,0,0.5)',
      position: 'bottom',
      marginBottom: 40,
    },
  },
  {
    id: 'comedy-club',
    name: 'Comedy Club',
    description: 'Punchline-ready bold text with typewriter animation',
    thumbnail: 'CC',
    style: {
      ...baseStyle,
      fontSize: 54,
      fontWeight: 800,
      color: '#FFFFFF',
      strokeWidth: 4,
      strokeColor: '#1a1a1a',
      animation: 'typewriter',
      position: 'bottom',
      marginBottom: 90,
      maxWidth: 1000,
      shadowBlur: 12,
      shadowColor: 'rgba(0,0,0,0.9)',
    },
  },
];

export function getPresetById(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}
