import argparse
import io
import json
import math
import os
import re
import textwrap
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps


CANVAS = 1200
PALETTES = [
    ("#0f766e", "#f97316", "#fef3c7"),
    ("#1d4ed8", "#e11d48", "#ecfeff"),
    ("#7c3aed", "#14b8a6", "#fff7ed"),
    ("#166534", "#ca8a04", "#f0fdfa"),
    ("#be123c", "#0369a1", "#f8fafc"),
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


def trim_product(img):
    img = ImageOps.exif_transpose(img).convert("RGBA")
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if bbox:
        img = img.crop(bbox)

    bg = Image.new("RGBA", img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, bg)
    diff = ImageChops.add(diff, diff, 2.0, -18)
    bbox = diff.getbbox()
    if bbox:
        img = img.crop(bbox)

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


def add_shadow(base, layer, pos, blur=28, offset=(0, 24), opacity=90):
    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    alpha = layer.getchannel("A").filter(ImageFilter.GaussianBlur(blur))
    shadow.putalpha(alpha.point(lambda p: min(opacity, p)))
    base.alpha_composite(shadow, (pos[0] + offset[0], pos[1] + offset[1]))
    base.alpha_composite(layer, pos)


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
    brand, accent, soft = colors
    img = gradient((CANVAS, CANVAS), soft, "#ffffff")
    draw = ImageDraw.Draw(img)
    draw.ellipse((720, -40, 1220, 460), fill=(*hex_rgb(brand), 28))
    draw.ellipse((-130, 760, 410, 1300), fill=(*hex_rgb(accent), 34))
    draw.ellipse((230, 170, 970, 900), fill=(*hex_rgb(accent), 30))
    rounded_border(draw, (92, 84, 1108, 1116), 42, hex_rgb(brand), 7)
    draw.text((110, 154), "CATALOGO PREMIUM", font=font(28, True), fill=hex_rgb(brand))
    add_shadow(img, prod, (240, 215))
    title_end = draw_wrapped(draw, product.get("nombre") or product.get("sku"), (600, 930), 720, 3, 40, "#111827", True, "ma", 6)
    draw.text((600, min(1088, title_end + 18)), str(product.get("marca") or product.get("sku") or ""), font=font(28, True), fill=hex_rgb(accent), anchor="ma")
    return img


def benefits(product, prod, colors):
    brand, accent, soft = colors
    img = Image.new("RGBA", (CANVAS, CANVAS), "#ffffff")
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 510, CANVAS), fill=soft)
    draw.pieslice((-180, 260, 660, 1120), 270, 90, fill=(*hex_rgb(brand), 32))
    draw.ellipse((15, 40, 375, 400), fill=(*hex_rgb(accent), 28))
    small = ImageOps.contain(prod, (500, 650), Image.Resampling.LANCZOS)
    add_shadow(img, small, (40 + (500 - small.width) // 2, 285 + (650 - small.height) // 2), blur=22, offset=(0, 18), opacity=70)
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
    brand, accent, soft = colors
    img = gradient((CANVAS, CANVAS), "#ffffff", soft)
    draw = ImageDraw.Draw(img)
    rounded_border(draw, (78, 78, 1122, 1122), 46, hex_rgb(brand), 7)
    draw.ellipse((790, 65, 1120, 395), fill=(*hex_rgb(accent), 32))
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
