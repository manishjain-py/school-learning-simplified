"""Rebuild the deterministic fictional geometric PNG; synthetic plumbing only.

New test artwork, no source portrait, image model, likeness or curriculum.
"""
from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new('RGB', (512, 768), '#e6f1ee')
d = ImageDraw.Draw(image)
d.rounded_rectangle((20, 22, 492, 746), radius=28, fill='#f7faf7', outline='#bfd8d0', width=3)
# Room/background is deliberately abstract; the whole head fits the app crop.
d.rectangle((43, 62, 125, 273), fill='#e3e9d1')
d.line((53, 95, 114, 95), fill='#bdc9a5', width=6)
d.line((53, 140, 114, 140), fill='#bdc9a5', width=6)
d.ellipse((369, 168, 471, 287), fill='#d9e8c2')
d.rectangle((411, 258, 438, 314), fill='#b48c68')
# Body, neck, face, short hair, eyes, nose. Mouth is an intentional empty overlay region.
d.rounded_rectangle((99, 416, 413, 682), radius=90, fill='#547f91')
d.rectangle((220, 370, 292, 452), fill='#e4ac83')
d.ellipse((143, 122, 369, 408), fill='#e9b88f', outline='#b98360', width=3)
d.pieslice((142, 93, 370, 321), 180, 360, fill='#324651')
d.ellipse((146, 159, 171, 275), fill='#324651')
d.ellipse((341, 159, 366, 275), fill='#324651')
d.ellipse((194, 239, 208, 255), fill='#233c47')
d.ellipse((304, 239, 318, 255), fill='#233c47')
d.line((188, 226, 219, 222), fill='#324651', width=5)
d.line((293, 222, 324, 226), fill='#324651', width=5)
d.line((256, 257, 246, 289, 261, 292), fill='#c08761', width=4)
d.line((256, 451, 256, 625), fill='#bad8df', width=4)
d.ellipse((247, 480, 255, 488), fill='#e9eeeb')
d.ellipse((247, 530, 255, 538), fill='#e9eeeb')
d.rounded_rectangle((69, 693, 443, 730), radius=10, fill='#d9e7e2')
d.text((127, 706), 'SYNTHETIC AVATAR - PLUMBING ONLY', fill='#284b57')
image.save(Path(__file__).with_name('synthetic-character.png'))
