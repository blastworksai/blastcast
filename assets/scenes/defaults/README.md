# Original BlastCast scene defaults

Supplied and designated as original defaults by einh on 2026-09-27.
Moved unchanged from `/opt/glitch/einhinput/` by CodexBWAI at his explicit
request (MOVE, not COPY). These are source assets, not generated replacements.

| Asset | Default scene |
| --- | --- |
| `1cam.png` | One camera |
| `2cam.png` | Two cameras, side by side |
| `3cam.png` | Three cameras, one above two |
| `4cam.png` | Four cameras, two by two |
| `5cam.png` | Five cameras, two above three |
| `6cam.png` | Six cameras, three by two |
| `7cam.png` | Seven cameras, three above four |
| `8cam.png` | Eight cameras, four by two |
| `screensharehorizont-8.png` | Screenshare above eight cameras in a bottom row |
| `screensharevert-8.png` | Screenshare beside eight cameras in a right-hand column |

## Implementation contract for B7/B8

- Bundle all ten as the original backgrounds for their corresponding scenes.
- Users can replace the background in their own scenes and rearrange camera and
  screenshare positions. User customization must not overwrite these bundled
  originals; keep scene-specific selections separately.
- Both screenshare presets are available; the previously agreed initial
  screenshare layout remains the right-hand vertical camera strip.
- Camera and screenshare sources must be placed within the depicted frames.
  These PNGs are backgrounds, not a substitute for editable scene geometry.
- Preserve the supplied originals without repainting, cropping or resampling
  the source files. Render the composition on the agreed 1920x1080 output canvas.
- Verify source placement and aspect-ratio handling in preview and recorded
  output, particularly the wide camera slots in the vertical screenshare scene.
  Never stretch faces or screen content to fill a mismatched frame.
- Acceptance includes all ten defaults, per-scene background replacement, and
  proof that original assets stay unchanged after customization.

Assets are now on disk; scene loading and rendering are not implemented yet.
