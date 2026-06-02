# Sesión 2026-06-02 — Handoff

> Documento puente para retomar el proyecto en otro equipo después de la
> sesión del 2 de junio de 2026. Pensado para que un Claude nuevo (o tú
> en otro Mac) pille el contexto sin leer todo el JSONL.

Rama: `main` — todo commiteado en `3fdfe1d` y subido a `origin`.

---

## 1. Lo que se arregló en esta sesión

### 1.1 Sync audio/video en el render (894 ms de desfase)

**Síntoma**: el export final de YouTube sonaba con el audio retrasado
~1 s respecto al video.

**Causa raíz**: el paso de mux hacía input-seek del video al keyframe
**at-or-after** `|alignmentOffsetMs|` (rápido y exacto dentro de la
malla de keyframes) y atrimaba el delta del audio. Eso desplaza el
t=0 del muxed unos cientos de ms hacia adelante respecto al t=0 del
audio file standalone. El renderer en cambio aplicaba el mismo `-ss`
a video y audio, así que el audio quedaba desfasado por ese delta.

**Fix**:
- `SyncState.muxedAudioOffsetMs` nuevo en `src/types/project.ts` —
  guarda el delta (positivo, ms).
- `src/app/api/projects/[id]/audio/mux/route.ts` rellena el campo
  durante el mux (keyframe lookup + atrim).
- `src/server/ffmpeg-wrapper.ts`: añadido
  `RenderReelOptions.audioSourceOffsetMs` y
  `RenderVideoOptions.audioSourceOffsetMs`. Cada audio input usa
  `-ss (seekSec + offset)` en vez de `-ss seekSec`.
- `src/server/workers/render-worker.ts`: lee
  `project.sync.muxedAudioOffsetMs` y lo pasa a los dos call sites
  (reel + compose YouTube). Sólo aplica cuando el video sale del
  muxed (con cámara raw el offset es distinto y no se aplica).
- `src/stores/compose-store.ts` + `src/app/project/[id]/compose/page.tsx`:
  el clip a1 auto-creado en `loadComposition` se inicializa con
  `sourceInMs = audioOffset` para que el preview de Remotion (muted
  video + standalone audio) también esté sincronizado.

**Cómo se verificó**: cross-correlation entre primeros 10 s del render
y los primeros 10 s del mix file con seek = v1.sourceInMs + 894.
Antes del fix: lag = -935 ms. Después: lag = 0 ms.

### 1.2 Watchdog de FFmpeg

**Síntoma**: el watchdog del renderer mataba a FFmpeg con SIGTERM
durante fases silenciosas (lookahead flush de libx264 al final del
encoding y `+faststart moov-atom rewrite`), justo cuando el render
estaba a punto de terminar.

**Causa raíz**: el watchdog antiguo medía silencio de stderr/stdout
durante 90 s y mataba. Esas fases finales no emiten nada en stderr.

**Fix** en `src/server/ffmpeg-wrapper.ts` (`renderReelVideo` y
`renderVideo`): el watchdog ahora monitoriza **crecimiento del archivo
de salida**. Si en 5 min no crece ni un byte → SIGTERM. Mientras
escriba, no toca nada. Implementado con `fs.statSync(outputPath).size`
cada 15 s; el faststart pausa la escritura unos segundos al copiar el
moov atom, pero nunca 5 min.

### 1.3 Fallback silencioso cuando se borra el muxed

**Síntoma**: si borras el `muxed_*.mp4` del `export/` (p.ej. para
liberar disco) y luego renderizas, el video sale empezando en el
sitio equivocado y todos los cortes desplazados.

**Causa raíz**: el render-worker hacía fallback silencioso a
`videoSrc` (cámara raw 4K) cuando no encontraba muxed. Pero las clips
del compose tienen `sourceInMs` relativos al timeline del muxed
(`t=0 = camera-t≈54.5s` por el keyframe-snap). Aplicar esos `-ss` al
raw camera te lleva ~53 s antes de donde debe.

**Fix** en `src/server/workers/render-worker.ts`: si las clips
referencian `muxed_*.mp4` (por `fileName`) y no se encuentra ningún
muxed file en `export/` ni `compose/`, el export **falla con mensaje
claro** ("Re-run Sync & Mix") en vez de generar un render basura.

### 1.4 Densidad de subtítulos por defecto

- `transcription` y `compose`: `maxCharsPerBlock` de 80 → **40**.
- `reels`: `maxCharsPerBlock` de 38 → **20**.
- Ficheros: `src/config/subtitle-styles.ts`,
  `src/app/project/[id]/transcription/page.tsx`.

### 1.5 Cohesión léxica de subtítulos

**Objetivo**: que los cortes de bloque no rompan frases en mitad de
"artículo + nombre + adjetivo" ("un | partido nuevo").

**Fix**:
- `src/lib/subtitle-utils.ts`: tabla `SPANISH_GLUE_WORDS` (artículos,
  contracciones, preposiciones, posesivos, demostrativos, "no",
  auxiliares he/has/ha/voy/va/estoy/está/soy/es/son, conjunciones
  y/o/u/e/ni). `splitByWords` y `splitByText` extienden/desplazan
  cortes hacia adelante para no acabar en glue, con presupuesto de
  overflow del 25% y pase final de tail-merge para palabras
  huérfanas.
- `src/server/workers/reinterpret-worker.ts`: instrucciones equivalentes
  en el prompt para la reinterpretación con LLM.

### 1.6 Custom subtitle presets globales

Pasados de per-project (`project.customStylePresets`) a globales en
`data/settings.json`. Hay auto-migración en
`src/hooks/use-custom-presets.ts`. Endpoint nuevo
`/api/settings/style-presets`.

### 1.7 AVIF/HEIC overlays

**Síntoma**: render fallaba con `Decoder (codec none) not found` al
añadir un overlay AVIF.

**Fix** en `src/server/ffmpeg-wrapper.ts`: pre-conversión a PNG temporal
con `execFileSync` antes de pasarlo al pipeline. Limpieza al final en
`cleanupTempImages`. JPEG sigue forzando `-f image2`; PNG/BMP/WebP
auto-detect; GIF con `ignore_loop=0 + stream_loop=-1`.

---

## 2. Estado del proyecto de El Golfo

Proyecto activo:
`projects/6ec88284-b6cd-425f-ab70-b13cf67f6610/`

- **`project.json`**: 10 clips compose (5 v1 + 5 a1), `sync.muxedAudioOffsetMs = 894`, subtítulos OK, custom presets migrados a global. `exports` vaciado (los 3 renders previos están borrados o fueron malos).
- **`export/`**: solo `.DS_Store` + `debug_subs_youtube_1080.ass`. El **muxed file está borrado** — tienes que regenerarlo.
- **`source/`**: cámara raw `.mp4` (3840×2160 @ 50fps, h264, 26:55) + WAV de cámara. Intactos.
- **`audio/`**: aligned + mix + amplified + raw. Intactos.

### Qué hay que hacer al abrirlo en el otro equipo

1. Clona el repo y `npm install` + `npm run dev`.
2. Asegúrate de que el directorio del proyecto está bajo `projects/<uuid>/` (cópialo entero — son varios GB).
3. Abre el proyecto en la UI → **`/sync` → botón Mux**. Regenera `muxed_*.mp4` (~30 s con `-c:v copy`).
   - El `alignmentOffsetMs` ya está guardado, así que el mux usará el mismo offset.
   - Las clips compose seguirán siendo válidas porque el audio define la duración, no el video.
4. Ve a `/export` y dispara el render YouTube 1080p. Esta vez saldrá sincronizado de fábrica (los cambios de `audioSourceOffsetMs` están todos en `main`).

---

## 3. Cosas a vigilar / conocidas

- **Compose autosave** sigue debounced a 3 s. Las ops destructivas guardan inmediatamente.
- El bug del rAF feedback loop en reel-player sigue tapado con
  `lastTickSetMsRef` y `lastGapSeekSourceMsRef`. No reemplazar por
  booleanos.
- **`v1`/`a1` tracks protegidos** en `addClip`/`removeTrack` — la auto-populate en `loadComposition` los recrea si faltan.
- **HLG preview washed en browser**: no es bug, es la nada de tone-mapping de HLG. Workaround pendiente sería sidecar SDR proxy. No implementado.
- **Render path simple (`renderVideo` línea 887 de render-worker)** usa cámara raw + aligned audio. Si lo usas para algo no-compose, hay un offset distinto (~53 s, no 894 ms) que NO se aplica. No estaba afectado en esta sesión porque no se usa para el path principal de YouTube.

---

## 4. Cambios en código (referencia rápida)

```
src/types/project.ts                            — SyncState.muxedAudioOffsetMs
src/app/api/projects/[id]/audio/mux/route.ts    — keyframe-snap + atrim + record offset
src/server/ffmpeg-wrapper.ts                    — audioSourceOffsetMs + file-size watchdog + AVIF→PNG
src/server/workers/render-worker.ts             — wire offset to both render calls + fail-fast on missing muxed
src/server/workers/reinterpret-worker.ts        — glue-word guidance in LLM prompt
src/stores/compose-store.ts                     — audioSourceOffsetMs arg in loadComposition
src/app/project/[id]/compose/page.tsx           — passes muxedAudioOffsetMs
src/config/subtitle-styles.ts                   — maxCharsPerBlock 40 / 20
src/app/project/[id]/transcription/page.tsx     — input fallback 40
src/lib/subtitle-utils.ts                       — SPANISH_GLUE_WORDS + tail-merge
src/hooks/use-custom-presets.ts                 — global presets via /api/settings/style-presets
src/server/settings-manager.ts                  — customStylePresets in AppSettings
src/app/api/settings/style-presets/route.ts     — new endpoint
```

Commit clave: `3fdfe1d` — "Subtitle phrasing + A/V sync offset + watchdog hardening".

---

## 5. Cómo verificar el sync rápidamente (post-mux)

Si quieres comprobar que el render queda sincronizado sin esperar al
export entero, hay un script casero en bash que extrae los primeros
10 s del output y los compara contra el mix file en el offset
esperado. Cross-correlation, lag en ms. Se hizo inline en esta sesión:

```python
# Pseudocódigo
read_pcm(rendered_output)  -> a
read_pcm(mix_file, ss=v1.sourceInMs + muxedAudioOffsetMs, t=10) -> b
best_lag(a, b) ≈ 0  → sincronizado
best_lag(a, b) ≈ -935 ms → el bug viejo, audio retrasado ~1 s
```

---

## 6. Antes de empezar en el otro equipo

1. `git pull origin main` (commit más reciente: `3fdfe1d`).
2. Mira `CLAUDE.md` (en root) — onboarding completo del repo.
3. Mira esta nota (`SESSION_HANDOFF_2026-06-02.md`) para el contexto fresco.
4. Si necesitas todos los archivos del proyecto en disco, copia
   `projects/6ec88284-b6cd-425f-ab70-b13cf67f6610/` entero (varios GB).
   El bundle mínimo es `project.json` + `source/` — el resto se
   regenera con el botón Mux.
