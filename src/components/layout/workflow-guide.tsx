'use client';

import {
  FolderPlus,
  Upload,
  Music,
  Waves,
  Laugh,
  Sparkles,
  Radio,
  Subtitles,
  Download,
  ArrowRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface WorkflowStep {
  icon: React.ElementType;
  title: string;
  page: string;
  description: string;
  details: string[];
}

const workflowSteps: WorkflowStep[] = [
  {
    icon: FolderPlus,
    title: '1. Crear proyecto',
    page: '/',
    description: 'Crea un proyecto nuevo desde el Dashboard.',
    details: [
      'Dale un nombre descriptivo al show/set',
    ],
  },
  {
    icon: Upload,
    title: '2. Importar archivos',
    page: '/project/[id]/import',
    description: 'Sube el video de cámara y el audio de mesa.',
    details: [
      'Sube el video de la cámara y márcalo como "Cámara"',
      'Sube el audio del micro de mesa y márcalo como "Mesa"',
      'También puedes importar desde la carpeta inbox/',
    ],
  },
  {
    icon: Music,
    title: '3. Extracción de audio',
    page: '/project/[id]/audio-prep',
    description: 'Extrae la pista de audio del video de cámara.',
    details: [
      'Automático: un clic para extraer el audio del .mp4',
      'Necesario para los pasos siguientes',
    ],
  },
  {
    icon: Waves,
    title: '4. Sustracción guiada de voz',
    page: '/project/[id]/audio-prep',
    description: 'Usa el micro de mesa como referencia para aislar el ambiente de la cámara.',
    details: [
      'Método Espectral (STFT): rápido, buen resultado general',
      'Método NLMS: filtro adaptativo, mejor con buena alineación',
      'Ajusta alpha (agresividad) y floor (piso espectral)',
      'Resultado: ambiente limpio (risas, aplausos, sala)',
    ],
  },
  {
    icon: Laugh,
    title: '5. Detección de risas',
    page: '/project/[id]/audio-prep',
    description: 'Analiza el ambiente para encontrar risas, aplausos y reacciones.',
    details: [
      'Detecta segmentos de alta energía automáticamente',
      'Clasifica: risa, aplauso, reacción',
      'Genera curva de volumen dinámico para la mezcla',
      'Ajusta sensibilidad y duración mínima',
    ],
  },
  {
    icon: Sparkles,
    title: '6. Limpieza de audio',
    page: '/project/[id]/audio-prep',
    description: 'Opcional: EQ, compresor y reducción de ruido sobre el ambiente.',
    details: [
      'Ecualizador paramétrico para cortar frecuencias',
      'Compresor dinámico + limitador',
      'Reducción de ruido de fondo',
    ],
  },
  {
    icon: Radio,
    title: '7. Sincronización y mezcla',
    page: '/project/[id]/sync',
    description: 'Alinea mesa + cámara y ajusta volúmenes de la mezcla.',
    details: [
      'Auto-sync por correlación cruzada',
      'Ajuste manual de offset si es necesario',
      'Mezclador: volumen de mesa (voz) y ambiente (cámara)',
      'La curva de volumen del ambiente se aplica aquí',
    ],
  },
  {
    icon: Subtitles,
    title: '8. Subtítulos',
    page: '/project/[id]/subtitles',
    description: 'Transcribe con Whisper, edita el texto y elige estilo visual.',
    details: [
      'Whisper: modelos tiny a large-v3, idioma auto o manual',
      'Editor de segmentos con tiempos editables',
      '7 presets de estilo (YouTube, Netflix, TikTok...)',
      'Preview en tiempo real con Remotion',
    ],
  },
  {
    icon: Download,
    title: '9. Exportar',
    page: '/project/[id]/export',
    description: 'Renderiza el video final con subtítulos y audio mezclado.',
    details: [
      'Presets: horizontal 1080p/4K, vertical para Shorts/Reels',
      'Cola de render con progreso en tiempo real',
      'Codec H.264/H.265, CRF configurable',
    ],
  },
];

export function WorkflowGuide() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Flujo de trabajo
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Guía paso a paso para procesar un video de standup
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-0">
          {workflowSteps.map((step, i) => (
            <div key={step.title} className="group">
              <div className="flex gap-3 py-3">
                {/* Icon + connector */}
                <div className="flex flex-col items-center">
                  <div className="rounded-lg bg-secondary p-2 group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                    <step.icon className="h-4 w-4" />
                  </div>
                  {i < workflowSteps.length - 1 && (
                    <div className="mt-1 h-full w-px bg-border flex-1 min-h-[8px]" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 pb-1">
                  <div className="flex items-baseline gap-2">
                    <h4 className="text-sm font-medium">{step.title}</h4>
                    <span className="text-xs text-muted-foreground/50 font-mono">
                      {step.page}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {step.description}
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {step.details.map((detail) => (
                      <li
                        key={detail}
                        className="flex items-start gap-1.5 text-xs text-muted-foreground/70"
                      >
                        <ArrowRight className="h-3 w-3 mt-0.5 flex-none" />
                        {detail}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
