// Shared font-family list for the text-overlay style pickers in BOTH the
// Compose (clip-properties) and Reels (reel-timeline-view) editors, so the two
// never drift apart. The first two (Bebas Neue, Anton) plus Inter/Montserrat/
// Open Sans/Oswald/Roboto are bundled in fonts/ for the FFmpeg/libass export
// AND loaded via Google Fonts in layout.tsx for the browser preview; the rest
// are common system faces that render in the browser and, if installed, in
// libass via coretext fallback.
export const FONT_FAMILIES = [
  // Display / condensed faces — bundled in fonts/ for FFmpeg ASS render
  // and loaded via Google Fonts in layout.tsx for browser preview.
  'Bebas Neue', 'Anton',
  'Inter', 'Arial', 'Helvetica Neue', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Impact', 'Comic Sans MS',
  'Trebuchet MS', 'Palatino', 'Garamond', 'Bookman',
  'Futura', 'Gill Sans', 'Lucida Grande', 'Lucida Console',
  'Optima', 'Avenir', 'Avenir Next', 'Didot',
  'American Typewriter', 'Rockwell', 'Copperplate',
  'Menlo', 'Monaco', 'SF Pro Display', 'SF Pro Text',
  'Baskerville', 'Cochin', 'Hoefler Text',
];
