import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const audioCleanupSettingsSchema = z.object({
  eqFrequency: z.number().min(20).max(20000).default(3500),
  eqGain: z.number().min(-20).max(20).default(-6),
  eqWidth: z.number().min(0.1).max(10).default(2),
  compressorThreshold: z.number().min(-60).max(0).default(-20),
  compressorRatio: z.number().min(1).max(20).default(4),
  limiterLevel: z.number().min(0).max(1).default(0.95),
  noiseReduction: z.number().min(0).max(20).default(7),
  noiseFloor: z.number().min(0.001).max(0.1).default(0.002),
});

export const syncSettingsSchema = z.object({
  boardVolume: z.number().min(0).max(2).default(1),
  cameraAmbientVolume: z.number().min(0).max(2).default(0.7),
  manualOffsetMs: z.number().optional(),
});

export const subtitleStyleSchema = z.object({
  fontFamily: z.string().default('Inter'),
  fontSize: z.number().min(8).max(200).default(48),
  fontWeight: z.number().min(100).max(900).default(700),
  color: z.string().default('#FFFFFF'),
  strokeColor: z.string().default('#000000'),
  strokeWidth: z.number().min(0).max(20).default(3),
  backgroundColor: z.string().default('transparent'),
  backgroundPadding: z.number().min(0).max(50).default(8),
  backgroundRadius: z.number().min(0).max(30).default(4),
  position: z.enum(['bottom', 'center', 'top']).default('bottom'),
  marginBottom: z.number().min(0).max(500).default(80),
  animation: z.enum(['none', 'fade', 'typewriter', 'word-highlight', 'pop']).default('none'),
  highlightColor: z.string().default('#FFD700'),
  textTransform: z.enum(['none', 'uppercase', 'lowercase']).default('none'),
  maxWidth: z.number().min(100).max(2000).default(900),
  lineHeight: z.number().min(0.5).max(3).default(1.3),
  shadowColor: z.string().default('rgba(0,0,0,0.8)'),
  shadowBlur: z.number().min(0).max(50).default(8),
  shadowOffsetX: z.number().min(-20).max(20).default(2),
  shadowOffsetY: z.number().min(-20).max(20).default(2),
});

export const exportSettingsSchema = z.object({
  presetId: z.string(),
  customWidth: z.number().optional(),
  customHeight: z.number().optional(),
  customFps: z.number().optional(),
  customCrf: z.number().optional(),
});
