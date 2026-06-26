import argparse
import io
import json
import math
import os
import re
import textwrap
import urllib.request
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps


CANVAS = 1200
PALETTES = [
    ("#0f766e", "#f97316", "#fff7ed", "#0b1220"),
    ("#1d4ed8", "#e11d48", "#eef2ff", "#111827"),
    ("#7c3aed", "#14b8a6", "#f5f3ff", "#171717"),
    ("#166534", "#ca8a04", "#ecfdf5", "#102018"),
    ("#be123c", "#0369a1", "#fff1f2", "#1f1020"),
]


def font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def safe_sku(sku):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(sku or "producto").strip())
    return cleaned.strip("-") or "producto"


def palette(seed):
    idx = sum(bytearray(str(seed or "").encode("utf-8"))) % len(PALETTES)
    return PALETTES[idx]


def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": "CatalogImageGenerator/1.0"})
    with urllib.request.urlopen(req, timeout=35) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGBA")


def is_background_pixel(pixel, corner):
    r, g, b, a = pixel
    if a < 12:
        return True
    avg = (r + g + b) / 3
    spread = max(r, g, b) - min(r, g, b)
    dist = sum((pixel[i] - corner[i]) ** 2 for i in range(3)) ** 0.5
    return (
        (avg > 238 and spread < 38)
        or (avg > 220 and spread < 18)
        or (avg > 190 and dist < 44)
    )


def remove_connected_background(img):
    img = ImageOps.exif_transpose(img).convert("RGBA")
    w, h = img.size
    px = img.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    corner = tuple(round(sum(c[i] for c in corners) / len(corners)) for i in range(4))
    bg = Image.new("L", (w, h), 0)
    bg_px = bg.load()
    seen = bytearray(w * h)
    q = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if not is_background_pixel(px[x, y], corner):
            continue
        bg_px[x, y] = 255
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))

    bg = bg.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    alpha = img.getchannel("A")
    alpha = ImageChops.subtract(alpha, bg)
    alpha = alpha.point(lambda p: 0 if p < 40 else 255)
    img.putalpha(alpha)
    bbox = alpha.getbbox()
    return img.crop(bbox) if bbox else img


def opaque_ratio(img):
    hist = img.getchannel("A").histogram()
    total = sum(hist) or 1
    return sum(hist[245:]) / total


def tight_foreground_crop(img):
    img = ImageOps.exif_transpose(img).convert("RGBA")
    w, h = img.size
    px = img.load()
    corner = px[0, 0]
    xs = []
    ys = []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 12:
                continue
            avg = (r + g + b) / 3
            spread = max(r, g, b) - min(r, g, b)
            dist = sum((px[x, y][i] - corner[i]) ** 2 for i in range(3)) ** 0.5
            if not (avg > 248 and spread < 14 and dist < 22):
                xs.append(x)
                ys.append(y)
    if not xs or not ys:
        return img
    pad = 24
    box = (
        max(0, min(xs) - pad),
        max(0, min(ys) - pad),
        min(w, max(xs) + pad),
        min(h, max(ys) + pad),
    )
    cropped = img.crop(box)
    cropped.putalpha(Image.new("L", cropped.size, 255))
    return cropped


def trim_product(img):
    original = ImageOps.exif_transpose(img).convert("RGBA")
    img = remove_connected_background(original)
    if opaque_ratio(img) < 0.5:
        img = tight_foreground_crop(original)

    img.thumbnail((720, 720), Image.Resampling.LANCZOS)
    layer = Image.new("RGBA", (720, 720), (255, 255, 255, 0))
    layer.alpha_composite(img, ((720 - img.width) // 2, (720 - img.height) // 2))
    return layer


def gradient(size, left, right):
    w, h = size
    left_rgb = hex_rgb(left)
    right_rgb = hex_rgb(right)
    img = Image.new("RGB", size)
    px = img.load()
    for x in range(w):
        t = x / max(1, w - 1)
        col = tuple(round(left_rgb[i] * (1 - t) + right_rgb[i] * t) for i in range(3))
        for y in range(h):
            px[x, y] = col
    return img.convert("RGBA")


def vertical_gradient(size, top, bottom):
    w, h = size
    top_rgb = hex_rgb(top)
    bottom_rgb = hex_rgb(bottom)
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        col = tuple(round(top_rgb[i] * (1 - t) + bottom_rgb[i] * t) for i in range(3))
        for x in range(w):
            px[x, y] = col
    return img.convert("RGBA")


def add_shadow(base, layer, pos, blur=28, offset=(0, 24), opacity=90):
    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    alpha = layer.getchannel("A").filter(ImageFilter.GaussianBlur(blur))
    shadow.putalpha(alpha.point(lambda p: min(opacity, p)))
    base.alpha_composite(shadow, (pos[0] + offset[0], pos[1] + offset[1]))
    base.alpha_composite(layer, pos)


def add_soft_product(base, layer, box, shadow=True, glow_color=(255, 255, 255)):
    product = ImageOps.contain(layer, box, Image.Resampling.LANCZOS)
    x = (CANVAS - product.width) // 2
    y = 250 + (box[1] - product.height) // 2
    if shadow:
        glow = Image.new("RGBA", product.size, (*glow_color, 0))
        glow.putalpha(product.getchannel("A").filter(ImageFilter.GaussianBlur(18)).point(lambda p: min(135, p)))
        base.alpha_composite(glow, (x, y))
        add_shadow(base, product, (x, y), blur=34, offset=(0, 30), opacity=82)
    else:
        base.alpha_composite(product, (x, y))
    return (x, y, product.width, product.height)


def draw_sparkles(draw, color):
    for x, y, r in [(165, 260, 9), (1015, 260, 7), (1010, 940, 10), (210, 940, 6), (905, 165, 5)]:
        draw.line((x - r, y, x + r, y), fill=color, width=3)
        draw.line((x, y - r, x, y + r), fill=color, width=3)


def split_to_width(draw, text, max_width, fnt, max_lines):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        width = draw.textbbox((0, 0), candidate, font=fnt)[2]
        if current and width > max_width:
            lines.append(current)
            current = word
            if len(lines) == max_lines - 1:
                break
        else:
            current = candidate
    if current and len(lines) < max_lines:
        lines.append(current)
    original = " ".join(words)
    if original and len(" ".join(lines)) < len(original) and lines:
        base = lines[-1].rstrip(".,;:")
        while base and draw.textbbox((0, 0), base + "...", font=fnt)[2] > max_width:
            base = base[:-1].rstrip()
        lines[-1] = (base or lines[-1][:1]) + "..."
    return lines


def draw_wrapped(draw, text, xy, max_width, max_lines, size, fill, bold=False, anchor="la", spacing=8):
    fnt = font(size, bold)
    lines = split_to_width(draw, text, max_width, fnt, max_lines)
    x, y = xy
    line_h = size + spacing
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill, anchor=anchor)
    return y + len(lines) * line_h


def rounded_border(draw, box, radius, outline, width):
    for i in range(width):
        b = (box[0] + i, box[1] + i, box[2] - i, box[3] - i)
        draw.rounded_rectangle(b, radius=radius, outline=outline)


def pill(draw, box, label, fill, outline, text_fill, size=30):
    draw.rounded_rectangle(box, radius=28, fill=fill, outline=outline, width=3)
    x = (box[0] + box[2]) / 2
    y = (box[1] + box[3]) / 2
    draw.text((x, y), label, font=font(size, True), fill=text_fill, anchor="mm")


def premium(product, prod, colors):
    brand, accent, soft, dark = colors
    img = vertical_gradient((CANVAS, CANVAS), dark, brand)
    draw = ImageDraw.Draw(img)
    draw.ellipse((120, 115, 1080, 1075), fill=(*hex_rgb(accent), 58))
    draw.ellipse((255, 225, 945, 915), fill=(*hex_rgb(brand), 68))
    draw.rounded_rectangle((92, 82, 1108, 1118), radius=46, outline=(255, 255, 255, 92), width=4)
    draw.rounded_rectangle((136, 128, 1064, 1072), radius=38, outline=(*hex_rgb(accent), 190), width=4)
    draw_sparkles(draw, (255, 255, 255, 170))
    add_soft_product(img, prod, (710, 680), glow_color=hex_rgb(accent))
    draw.rounded_rectangle((220, 858, 980, 1038), radius=26, fill=(255, 255, 255, 232))
    title_end = draw_wrapped(draw, product.get("nombre") or product.get("sku"), (600, 920), 680, 2, 38, "#111827", True, "ma", 6)
    draw.text((600, min(1010, title_end + 12)), str(product.get("marca") or product.get("sku") or ""), font=font(27, True), fill=hex_rgb(brand), anchor="ma")
    draw.text((600, 174), "PORTADA PREMIUM", font=font(30, True), fill="#ffffff", anchor="ma")
    return img


def benefits(product, prod, colors):
    brand, accent, soft, dark = colors
    img = gradient((CANVAS, CANVAS), "#ffffff", soft)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((54, 70, 1134, 1134), radius=44, fill=(255, 255, 255, 232), outline=(*hex_rgb(brand), 120), width=4)
    draw.ellipse((-130, 120, 620, 870), fill=(*hex_rgb(brand), 42))
    draw.ellipse((70, 250, 545, 725), fill=(*hex_rgb(accent), 58))
    small = ImageOps.contain(prod, (470, 620), Image.Resampling.LANCZOS)
    add_shadow(img, small, (88 + (470 - small.width) // 2, 322 + (620 - small.height) // 2), blur=24, offset=(0, 22), opacity=72)
    draw.text((620, 180), "BENEFICIOS CLAVE", font=font(34, True), fill=hex_rgb(brand))
    draw_wrapped(draw, product.get("nombre") or product.get("sku"), (620, 245), 500, 2, 40, "#111827", True, "la", 4)
    benefits_list = product.get("beneficios") if isinstance(product.get("beneficios"), list) else []
    benefits_list = benefits_list[:4] or ["Calidad seleccionada", "Producto original", "Ideal para tu rutina"]
    for i, benefit in enumerate(benefits_list):
        y = 400 + i * 105
        draw.ellipse((626, y - 36, 674, y + 12), fill=hex_rgb(accent))
        draw.line((638, y - 12, 646, y - 3, 665, y - 25), fill="#ffffff", width=7, joint="curve")
        draw_wrapped(draw, benefit, (700, y - 32), 420, 2, 32, "#0f172a", True, "la", 2)
    draw.rounded_rectangle((620, 1020, 1010, 1026), radius=3, fill=hex_rgb(accent))
    return img


def trust(product, prod, colors):
    brand, accent, soft, dark = colors
    img = vertical_gradient((CANVAS, CANVAS), "#ffffff", soft)
    draw = ImageDraw.Draw(img)
    rounded_border(draw, (78, 78, 1122, 1122), 46, hex_rgb(brand), 6)
    draw.ellipse((790, 65, 1120, 395), fill=(*hex_rgb(accent), 40))
    draw.ellipse((160, 345, 1040, 710), fill=(255, 255, 255, 180))
    draw.text((600, 150), "CONFIANZA Y ORIGEN", font=font(35, True), fill=hex_rgb(brand), anchor="ma")
    draw_wrapped(draw, product.get("nombre") or product.get("sku"), (600, 225), 720, 2, 40, "#111827", True, "ma", 6)
    small = ImageOps.contain(prod, (500, 430), Image.Resampling.LANCZOS)
    add_shadow(img, small, (350 + (500 - small.width) // 2, 330 + (430 - small.height) // 2), blur=22, offset=(0, 18), opacity=70)
    pill(draw, (112, 795, 332, 879), "FDA*", "#ffffff", brand, brand, 30)
    pill(draw, (360, 795, 580, 879), "NO GMO*", "#ffffff", brand, brand, 30)
    pill(draw, (608, 795, 858, 879), "USA", brand, brand, "#ffffff", 34)
    pill(draw, (884, 795, 1089, 879), "ORIGINAL", "#fff7ed", accent, accent, 29)
    draw.text((600, 930), "Producto importado de Estados Unidos", font=font(26, True), fill="#0f172a", anchor="ma")
    draw.text((600, 982), "*Sellos informativos sujetos a la etiqueta del fabricante.", font=font(20), fill="#64748b", anchor="ma")
    return img


def save_webp(img, path):
    img.convert("RGB").save(path, "WEBP", quality=88, method=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", nargs="?", default="productos.json")
    parser.add_argument("out_dir", nargs="?", default="assets/catalog")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    catalog_path = Path(args.catalog)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    products = json.loads(catalog_path.read_text(encoding="utf-8"))
    selected = products[: args.limit] if args.limit else products
    generated = reused = failed = 0
    failures = []

    for product in selected:
        sku = safe_sku(product.get("sku"))
        files = [
            out_dir / f"{sku}-01-premium.webp",
            out_dir / f"{sku}-02-beneficios.webp",
            out_dir / f"{sku}-03-confianza.webp",
        ]
        try:
            if not args.force and all(file.exists() for file in files):
                reused += 1
            else:
                source = str(product.get("imagen") or "").strip()
                if not source:
                    raise RuntimeError("Producto sin imagen base")
                prod = trim_product(fetch_image(source))
                colors = palette(product.get("categoria") or product.get("marca") or sku)
                save_webp(premium(product, prod, colors), files[0])
                save_webp(benefits(product, prod, colors), files[1])
                save_webp(trust(product, prod, colors), files[2])
                generated += 1
            product["imagenesCatalogo"] = [str(file).replace("\\", "/") for file in files]
        except Exception as exc:
            failed += 1
            failures.append(f"{product.get('sku')}: {exc}")

    catalog_path.write_text(json.dumps(products, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imagenes generadas: {generated}")
    print(f"Imagenes reutilizadas: {reused}")
    print(f"Fallos: {failed}")
    if failures:
        print("\n".join(failures))


if __name__ == "__main__":
    main()
