"""Builds the Google Play feature graphic (1024x500, 24-bit PNG, no alpha).

usage: python3 -I feature.py <repo root> <out.png>
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT, OUT = sys.argv[1], sys.argv[2]
W, H = 1024, 500
S = 2  # supersample, downscale at the end
SHOTS = f"{ROOT}/apps/mobile/store/screenshots/android-phone"

BLUE_A = (95, 175, 231)   # icon blue
BLUE_B = (38, 120, 196)   # deeper end of the gradient
WHITE = (255, 255, 255)

SF = "/System/Library/Fonts/SFNS.ttf"


def font(size, weight):
    f = ImageFont.truetype(SF, size * S)
    try:
        f.set_variation_by_axes([100, max(17, min(96, size)), 400, weight])
    except Exception:
        pass
    return f


def gradient(w, h):
    g = Image.new("RGB", (w, h))
    px = g.load()
    for y in range(h):
        for x in range(w):
            t = min(1.0, max(0.0, (x / w) * 0.65 + (y / h) * 0.35))
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(BLUE_A, BLUE_B))
    return g


def phone(shot_path, width):
    """A screenshot in a dark rounded frame, with its own shadow canvas."""
    shot = Image.open(shot_path).convert("RGB")
    bezel = 9 * S
    inner_w = width - 2 * bezel
    inner_h = round(inner_w * shot.height / shot.width)
    shot = shot.resize((inner_w, inner_h), Image.LANCZOS)
    fw, fh = width, inner_h + 2 * bezel
    r_out, r_in = 34 * S, 26 * S

    frame = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle((0, 0, fw - 1, fh - 1), r_out, fill=(18, 18, 22, 255))
    mask = Image.new("L", (inner_w, inner_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner_w - 1, inner_h - 1), r_in, fill=255)
    frame.paste(shot, (bezel, bezel), mask)

    pad = 40 * S
    canvas = Image.new("RGBA", (fw + 2 * pad, fh + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (pad, pad + 10 * S, pad + fw, pad + fh + 10 * S), r_out, fill=(10, 40, 80, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18 * S))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(frame, (pad, pad))
    return canvas, pad


img = gradient(W * S, H * S).convert("RGBA")

# Soft light circles for depth
glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
d = ImageDraw.Draw(glow)
d.ellipse((560 * S, -220 * S, 1180 * S, 400 * S), fill=(255, 255, 255, 34))
d.ellipse((-200 * S, 300 * S, 300 * S, 800 * S), fill=(255, 255, 255, 18))
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(40 * S)))

# Phones: needs-you behind, session in front; both run off the bottom edge
back, pad_b = phone(f"{SHOTS}/01-needs-you.png", 252 * S)
front, pad_f = phone(f"{SHOTS}/03-session.png", 272 * S)
img.alpha_composite(back, (842 * S - pad_b, 150 * S - pad_b))
img.alpha_composite(front, (616 * S - pad_f, 110 * S - pad_f))

# Logo (white, transparent), cropped to its bounds
logo = Image.open(f"{ROOT}/apps/mobile/assets/android-icon-foreground.png").convert("RGBA")
logo = logo.crop(logo.getbbox())
lw = 200 * S
logo = logo.resize((lw, round(lw * logo.height / logo.width)), Image.LANCZOS)
img.alpha_composite(logo, (64 * S, 58 * S))

d = ImageDraw.Draw(img)
y = 58 * S + logo.height + 34 * S
head = font(40, 700)
for line in ["Your coding agents,", "in your pocket."]:
    d.text((64 * S, y), line, font=head, fill=WHITE)
    y += 48 * S
y += 14 * S
sub = font(19, 500)
for line in ["Answer decisions, review diffs and", "run automations from anywhere."]:
    d.text((64 * S, y), line, font=sub, fill=(255, 255, 255, 225))
    y += 27 * S

img = img.convert("RGB").resize((W, H), Image.LANCZOS)
img.save(OUT, "PNG")
print(OUT, img.size, img.mode)
