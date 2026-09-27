# Del bolo al reel — guía de edición

Cómo se edita un bolo en el Standup Video Editor, en el orden en que se hace.
Escrita el 7 sep 2026 sobre el estado real de la app; los nombres entre «» son
los botones tal como aparecen en pantalla.

## 0 · Las tres palabras que lo explican todo

- **Mesa** = el micro del cómico (el audio de la mesa de sonido). Solo se oye a él.
- **Cámara / ambiente** = el micro del iPhone. Oye la sala: público, risas y al cómico de lejos.
- **Parte** = un vídeo de cámara + su audio de mesa. Un bolo grabado de una vez es UNA parte. Si paraste la cámara, cada trozo es una parte y al final se unen.

La mezcla final es siempre **mesa procesada + ambiente procesado**, y todo lo de abajo va de decidir cuánto de cada uno suena en cada momento.

## 1 · Importar — menú «Importar»

1. Deja el `.mov` de la cámara y el audio de la mesa en la bandeja de entrada del proyecto.
2. Asigna el rol de cada fichero: **cámara** o **mesa**.
3. Impórtalos (copia o mueve). Quedan en `source/` del proyecto.

Se puede borrar `source/` para liberar sitio **solo** cuando ya hayas cortado en Compose (o solo uses Reels) y no vayas a volver a Sync & Mix con esa grabación. Realinear o re-mezclar necesita los originales.

## 2 · Sync & Mix — menú «Sync & Mix»

Es el corazón. Cada parte es una tarjeta con estos pasos en orden.

### 2.1 Fuentes y «Alinear»
Elige vídeo y audio de mesa y pulsa **«Alinear»**. Calcula el desfase entre los dos micros (aparece como `offset mm:ss`). Se puede corregir a mano; si cambias el offset de una parte ya mezclada, vuelve a mezclarse sola.

### 2.2 Filtro previo — risas de micro (je-je) y rellenos
Antes de nivelar. Detecta los je-je-je del cómico (pulsos espaciados, no muy altos) y te los lista:
- pincha una fila → la oyes (medio segundo antes y después);
- **✓** la atenúa y enseña al detector; **✗** la deja intacta y también enseña; lo que no marcas no enseña nada;
- **«Buscar parecidos»** se calibra con tus ✓/✗ de esa grabación y propone más;
- en la onda, clic en una banda → botón rojo «borrar zona» (o Supr).

Dos cosas que conviene saber: el filtro va **antes** del nivelador a propósito, para que el nivelador no suba los je-je como si fueran frases flojas; y **una zona marcada cuenta como hueco** para el ambiente, así que si el cómico habla por encima de una risa larga y marcas ese trozo, la risa sube entera.

### 2.3 Nivelar la voz
Deja **Nivelar voz automáticamente** (recomendado). Sube lo flojo más que lo fuerte, con un techo (por defecto −3 dB, tú usas −10). La curva y los niveles «orig → proc» de la fila PROCESADA te dicen exactamente qué ha hecho.

### 2.4 Bajar ambiente mientras hay voz
La cámara baja cuando habla el cómico y vuelve a subir en las pausas **con público**. Los mandos:

| mando | qué hace | recomendado |
|---|---|---|
| Con voz −N dB | cuánto baja el ambiente bajo la voz | 12–16 (22 se ve/oye como un salto enorme) |
| en los huecos +N dB | cuánto sube en una pausa con público | 4–6 |
| solo si el público supera N dB | listón de público sobre el ruido de sala | 6 |
| anticipa | empieza a bajar antes de la frase | 100 ms |
| ataque | rapidez de la bajada | 20 ms |
| pausa mínima | huecos más cortos son «entre palabras»: no suben | 800 ms |
| vuelve | rampa de subida | 400 ms |
| sube la risa N ms antes | la risa entra bajo las últimas palabras | 250 ms |

El botón **«valores recomendados»** pone exactamente esos. Lo que decide si una pausa sube ya no es un umbral: es que haya **un evento de público real** (una hinchada continua de al menos medio segundo) y la subida empieza donde empieza la risa.

### 2.5 Comprobar y aplicar
- **Comprobar de oído**: los originales con tus volúmenes, EN VIVO. No lleva filtro je-je ni ducking.
- **«Probar los ajustes sin remezclar»**: 30 s por la cadena real (< 1 s). Las filas PROCESADA pasan a mostrar la prueba.
- **«Mezclar y muxar»** la primera vez. Después, **«Re-mezclar (solo audio)»**: regenera solo el audio en segundos y NO reescribe el vídeo de 25 GB.
- La fila **MEZCLA REAL** es lo que usan Compose, Reels, transcripción y export.
- El vídeo de la parte no necesita re-muxarse para editar. Solo si quieres el `.mp4` con el audio nuevo: **«Muxar el vídeo con la mezcla vigente»** dentro de VÍDEO.
- Con una sola parte el vídeo final se genera solo. Con varias, ordénalas y únelas.

Cada fila dice qué suena (ORIGINAL / PROCESADA / VISTA PREVIA / MEZCLA REAL), cuándo se generó, y avisa con ⚠ si has cambiado ajustes desde esa mezcla.

## 3 · Transcription — menú «Transcription»
**«Transcribir»** (Whisper, en local) sobre el audio de la mezcla. Revisa los segmentos, y si quieres, detecta bits (los chistes como unidades) para Reels. Si importaste un vídeo que ya trae su audio mezclado, **«Usar vídeo directamente»** se salta todo lo anterior.

## 4 · Compose — menú «Compose» (vídeo largo 16:9)
- Se crean solas la pista de vídeo (v1), la de audio (a1, la mezcla) y la de subtítulos.
- Cortar: `S` divide, `Shift+S` divide todas las pistas, `Q`/`W` recortan entrada/salida, `G` cierra el hueco, `Supr` borra, `Shift+Supr` borra y cierra. `Ctrl+Z` deshace.
- Los subtítulos se editan sobre la pista (doble clic), con estilos por preset.
- **Guarda con «Save» o `Ctrl+S`. Compose no guarda solo.**

### Audio dentro de Compose
- **Carriles «Mesa −dB» y «Ambiente +dB»**, bajo las pistas: cada atenuación de je-je y cada subida de público es una banda. Clic → seleccionar; ✕ o Supr → borrar; arrastra el cuerpo para moverla y los bordes para alargarla; **＋** en la cabecera crea una en el cursor. Aparece una barra **«Aplicar (re-mezclar audio)»**: hasta pulsarla, el audio no cambia. Las bandas caen donde toca aunque hayas cortado.
- **«Separar en pistas (mesa + ambiente)»**, en el panel de mezcla: convierte la mezcla en dos pistas independientes (los stems ya procesados) y silencia la principal. Ahí subes o bajas cada una por clip (0–200 %) sin re-mezclar. ×1 = tal cual sonaba en la mezcla. **«Volver a la mezcla única»** lo deshace.
- Los paneles «Atenuar mesa» y «Subir ambiente» del panel derecho son la misma edición que en Sync & Mix, con «Aplicar».

## 5 · Reels — menú «Reels» (vertical 9:16)
1. **＋** crea un reel (o desde un bit detectado). Recorta el rango y encuadra el 9:16.
2. **«Edit Reel»** entra en la línea de tiempo: hereda los cortes de Compose y, si separaste mesa y ambiente, también esas pistas con sus volúmenes.
3. Mismas herramientas de corte y subtítulos que Compose; **encuadre con keyframes** (zoom y posición animados).
4. Los carriles «Mesa −dB» / «Ambiente +dB» también están aquí, mapeados a los cortes del reel.
5. Reels **guarda solo** (3 s después de cada cambio).

## 6 · Export — menú «Export»
- Vídeo largo desde Compose: `youtube_1080` (H.264, el más compatible), `youtube_4k`, o `youtube_1080_hdr` (HEVC 10 bits, el único que devuelve el HDR del iPhone tal cual).
- Reels: preset `reels` (o `instagram`). `preview` para una prueba rápida.
- Los previews del navegador se ven «lavados» con el HDR del iPhone. Es normal: el navegador no mapea HLG. El export sí sale bien.

## 7 · Qué es inmediato y qué necesita re-mezclar

| cambio | efecto |
|---|---|
| volumen de un clip, cortes, subtítulos, overlays, encuadre | inmediato en el preview y en el export |
| separar mesa y ambiente / volver a la mezcla | inmediato |
| marcar o borrar je-je, subidas de ambiente, nivelador, ducking | guardado al instante; **suena** al pulsar «Aplicar» / «Re-mezclar (solo audio)» (segundos) |
| cambiar el offset de alineación | vuelve a mezclar y muxar esa parte sola |
| muxar el vídeo con la mezcla vigente | solo si quieres el `.mp4` con el audio nuevo; el resto no lo necesita |

Regla práctica: si una fila o el estado lleva ⚠, hay ajustes que la mezcla aún no lleva.
