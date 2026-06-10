# Session Handoff — 2026-06-10

> Para retomar en otro equipo: `git pull`, leer este doc + `CLAUDE.md`,
> reiniciar dev server (`rm -rf .next && npm run dev`). Todo lo de abajo
> está pusheado hasta `0fdd865`.

---

## 1. Qué se hizo en esta sesión (ya en main, funcionando)

| Commit | Qué |
|---|---|
| `91c2216` | Rotación (ángulo) por clip en compose — slider -15°..15° en Motion |
| `00bec1a` | Endpoint para consolidar presets de estilo legacy al store global |
| `b81094d` | Reels heredan el transform (zoom/pos/ángulo) del clip de compose |
| `6ca4f42` | Preview de setup del reel hereda el transform de compose |
| `095cf1c` | Copy/paste de clips (Cmd+C/V) en compose y reels |
| `9e07997` | Panel Motion (zoom/pos/ángulo) en el editor de reels |
| `18b1e39` | Plantillas de overlay de TEXTO en compose (librería global compartida) |
| `d412a91` | Canvas previews 9:16 del reel aplican el transform (fix preview torcido) |
| `9ac8fe9` | Botón "Aplicar" plantilla a un text overlay seleccionado (reels+compose) |
| `8de27f1` | **Video PiP overlays en el EXPORT** (reels + compose) |
| `0fdd865` | **Preview en vivo del PiP en el editor de reels** |

### Cómo funciona el PiP de vídeo (lo recién terminado)
- Añadir pista de vídeo extra en el reel → subir/arrastrar vídeo a esa pista.
- Seleccionar el clip → panel "Overlay (PiP)": Pos X/Y (centro), Tamaño, Opacidad
  → escribe `clip.overlayPosition` + `clip.opacity`.
- Preview: `reel-overlay-videos.tsx` monta un `<video>` oculto por clip PiP,
  sincronizado al playhead vía rAF; `drawActiveOverlayVideos()` en
  `src/lib/reel-transform.ts` lo pinta en ambos canvas 9:16.
- Export: `renderReelVideo` (ffmpeg-wrapper) acepta `videoOverlays:
  VideoOverlayInput[]`; render-worker los extrae (reels: video clips con
  trackId != 'rv1'; compose: video clips mode==='overlay' en track != 'v1').

---

## 2. TAREA PENDIENTE PRINCIPAL: mezcla real de audio multi-pista

### Síntoma reportado por el usuario
Copiar (Cmd+C/V) un trozo de audio a la pista "Extra Audio" del reel **no
suena** al reproducir. Solo "funciona" desplazar el clip de Main Audio.

### Causa (verificada, no es bug del copy/paste)
El modelo de audio actual de reels (y compose) tiene **una sola fuente de
audio real** (el mix/muxed). Los clips en `ra1`/`ra2` NO son un mezclador:
son **marcadores de presencia** — donde hay clip suena el audio principal,
donde no hay se mutea. Ver:

- `reel-video-player.tsx` ~línea 360: `inAudioClip = audioClips.some(...)` →
  `volume = inAudioClip ? 1 : 0`. No reproduce archivos distintos.
- Export: `renderReelVideo` corta la ÚNICA pista `audioInputPath` por clip y
  concatena; `audioClipRanges` solo silencia huecos (filtro `volume=if(...)`).
- Un clip de audio pegado con otro `sourceInMs` ni siquiera cambia qué se oye:
  el audio que suena en el tramo T siempre es mix[T-del-video], no
  mix[sourceInMs-del-clip].

### Qué hay que construir
Mezcla real: que cada clip de audio en `ra1`/`ra2` (y `a1`/`a2`+ en compose)
reproduzca SU rango fuente (`sourceInMs..sourceOutMs`) de SU archivo
(`fileName`) en su posición de timeline, mezclado con lo demás.

#### A) Preview (reels primero)
Patrón ya existente para copiar: **`src/components/reels/reel-overlay-videos.tsx`**
hace exactamente esto para vídeo PiP. Crear `reel-extra-audio.tsx` análogo:
1. Filtrar clips `type === 'audio'` con `fileName` distinto del audio principal
   (o todos los de ra2, decisión de diseño: sugerido = tratar ra1 como la pista
   "principal" con el comportamiento actual de gap-mute, y ra2+ como pistas
   mezcladas de verdad).
2. Montar `<audio>` oculto por clip, src =
   `/api/projects/{id}/reels/file?name=...` (sirve audio también) o
   `/api/projects/{id}/audio/file?name=...` según dónde viva el archivo.
3. Loop rAF: si playhead dentro del clip → `currentTime = (sourceInMs +
   (playhead - timelineStartMs))/1000`, play/pause con el estado global,
   `el.volume = clip.volume ?? 1`. Fuera del clip → pause.
4. Montarlo dentro de `ReelVideoPlayer` igual que `<ReelOverlayVideos/>`.

OJO: el "gap-mute" actual de `reel-video-player.tsx` (líneas ~360-385 y
~425-435) considera ra1 Y ra2 juntos para mutear el principal. Si ra2 pasa a
ser mezcla real, ese filtro debe considerar SOLO ra1 — si no, pegar un clip en
ra2 "desmutea" el principal en ese tramo (efecto colateral del modelo actual).

#### B) Export
`renderReelVideo` en `src/server/ffmpeg-wrapper.ts`:
1. Nueva opción `extraAudio?: { filePath, startMs, endMs, sourceInMs,
   volume }[]` (startMs/endMs en el timeline de salida concatenado, igual que
   `videoOverlays` — reutilizar el mismo remapeo `vcTimeMap` del worker).
2. Por cada entrada: input `-ss sourceIn -t dur -i file`, filtro
   `[i:a]asetpts=PTS-STARTPTS,adelay=startMs|startMs,volume=V[xa_i]`.
3. Mezclar con la salida actual: `[outa(o finala)][xa_0]...[xa_n]
   amix=inputs=N+1:duration=first:normalize=0[mixeda]` y mapear `[mixeda]`.
   - `duration=first` para no alargar el vídeo.
   - `normalize=0` para no bajar el volumen del principal (FFmpeg ≥5; el
     bundle es 6.0 → ok).
4. En `render-worker.ts`, extraer los clips extra igual que `videoOverlays`
   (dos sitios: bloque reel ~línea 470+ y bloque compose ~línea 805+),
   resolviendo `filePath` con `getProjectDir(projectId)` + fileName (los
   uploads de reels viven en la raíz del proyecto: `reel_<ts>_<nombre>`).
5. Cuidado con el orden de inputs: ya hay [clips video/audio…][imágenes…]
   [vídeos PiP…] → los audios extra van después; calcular
   `firstExtraAudioInputIdx = firstVideoOverlayInputIdx + videoOverlays.length`.

#### C) Compose (después)
Mismo plan: preview es Remotion (`compose-preview.tsx` ya monta `<Audio>` por
clip de audio extra con `clipSources` — ¡revisar si ya suena ahí!; el gap está
sobre todo en reels), export comparte `renderReelVideo` → B) lo cubre si el
worker compose también extrae los clips.

### Decisiones de diseño tomadas (mantener coherencia)
- PiP de vídeo NO aporta audio (ni preview ni export). Si se quiere, es otro
  flag (`muteOverlayAudio`) — no mezclarlo con esta tarea.
- `clip.volume` ya existe en el tipo (`CompositionClip.volume`) y el panel de
  audio de compose ya lo edita — usarlo como ganancia del clip en la mezcla.

---

## 3. Otras tareas pendientes (orden sugerido)

1. **Bug: pérdida de sincronía al borrar el primer trozo del reel** (reportado,
   sin investigar a fondo). Sospecha: `rippleDeleteSelected` en
   `reel-store.ts` (~línea 1290) desplaza clips/subtítulos pero puede dejar
   `sourceInMs` del audio marcador desalineado con el vídeo, o el problema es
   el modelo de audio de §2 (el marcador desplazado cambia DÓNDE suena pero el
   QUÉ suena sigue anclado al timeline). **Probable que §2 lo arregle de raíz**;
   re-testear después de implementar la mezcla.
2. **Plantillas de overlay de IMAGEN en compose** — hoy solo texto; al aplicar
   una plantilla con imágenes en compose se omiten con aviso. Falta generalizar
   `import-template-asset` (hoy es endpoint de reels) para que copie el asset
   al media-bin de compose.
3. **Botones visibles Copiar/Pegar** en toolbars de compose y reels (hoy solo
   atajos Cmd+C/V, el usuario no los descubre solo).
4. **Audio del PiP** opcional (ver §2, flag aparte).

---

## 4. Gotchas frescos de esta sesión

- Los cambios en stores Zustand NO siempre hot-recargan: tras `git pull`,
  reiniciar dev server o el usuario verá comportamiento viejo.
- El gap-mute del reel ahora NO mutea si el reel tiene CERO clips de audio
  (fallback al audio embebido del muxed) — no "limpiar" ese if pensando que
  sobra (`reel-video-player.tsx` ~línea 365).
- Los canvas 9:16 del reel siguen redibujando en pausa mientras un PiP está
  activo (`hasActiveOverlayVideo`) — necesario para scrubbing; no optimizar
  quitándolo.
- Uploads del editor de reels van a la RAÍZ del dir del proyecto
  (`reel_<ts>_<nombre>`, ver `reels/upload/route.ts`), no a `source/`.
