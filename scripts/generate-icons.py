"""Generate PWA icons from the project's ring mark. Pillow is only needed to regenerate."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parent.parent / 'public' / 'icons'
out.mkdir(parents=True, exist_ok=True)
for filename, size, maskable in [('icon-192.png', 192, False), ('icon-512.png', 512, False), ('maskable-512.png', 512, True), ('apple-touch-icon.png', 180, False)]:
    scale = 4
    image = Image.new('RGB', (size * scale, size * scale), '#b9ed8c')
    draw = ImageDraw.Draw(image)
    def box(a, b, c, d): return tuple(int(v * size * scale) for v in (a, b, c, d))
    radius = .26 if maskable else .28
    draw.ellipse(box(.5-radius, .5-radius, .5+radius, .5+radius), fill='#202b1c')
    draw.ellipse(box(.5-radius+.12, .5-radius+.12, .5+radius-.12, .5+radius-.12), fill='#b9ed8c')
    draw.ellipse(box(.65, .16, .85, .36), fill='#b9ed8c')
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / filename, optimize=True)
print('Generated four app icons.')
