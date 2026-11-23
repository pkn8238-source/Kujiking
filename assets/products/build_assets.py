#!/usr/bin/env python3
"""쿠지킹 — 시바마루야 실물 상품 등급 카드 이미지 생성 (v2).

준비: assets/fonts/Pretendard-Black.otf, Pretendard-Bold.otf
      assets/products/{slug}/raw/*.webp  (fetch_images.sh 로 다운로드)


raw/*.webp (시바마루 스토어 상품 사진, 1000x1000) 의 스튜디오 배경을 투명하게 지우고
- tier_a.png ~ tier_e.png : 900x900 등급 카드(A상~E상 배지)
- last_one.png            : 900x900 라스트원 카드
- cover.jpg               : 900x1125 판 커버(4:5)
를 만든다.
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
FONT_BLACK = os.path.join(ROOT, '..', 'fonts', 'Pretendard-Black.otf')
FONT_BOLD = os.path.join(ROOT, '..', 'fonts', 'Pretendard-Bold.otf')

GRADE_RGB = {
    'a': (239, 59, 45),
    'b': (255, 122, 26),
    'c': (242, 180, 0),
    'd': (18, 168, 122),
    'e': (139, 122, 102),
    'last': (31, 26, 20),
}

PRODUCTS = {
    'dragonball-saiyan': {
        'series': '드래곤볼',
        'tint': (255, 178, 90),
        'tiers': {'a': ['a'], 'b': ['b'], 'c': ['c'], 'd': ['d', 'e'], 'e': ['f', 'g', 'h', 'i', 'j']},
        'last': 'last',
    },
    'hunter-chimera-ant': {
        'series': '헌터×헌터',
        'tint': (96, 190, 140),
        'tiers': {'a': ['a'], 'b': ['b'], 'c': ['c'], 'd': ['d', 'e', 'f'], 'e': ['g', 'h', 'i']},
        'last': 'last',
    },
    'jojo-rivals': {
        'series': '죠죠의 기묘한 모험',
        'tint': (168, 118, 216),
        'tiers': {'a': ['a'], 'b': ['b'], 'c': ['c'], 'd': ['d', 'e', 'f'], 'e': ['g', 'h', 'i', 'j', 'k', 'l']},
        'last': 'last',
    },
    'apothecary-secret': {
        'series': '약사의 혼잣말',
        'tint': (224, 128, 142),
        'tiers': {'a': ['a'], 'b': ['b'], 'c': ['c'], 'd': ['d', 'e'], 'e': ['f', 'g', 'h']},
        'last': 'last',
    },
}

_cache = {}


def font(path, size):
    return ImageFont.truetype(path, size)


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def rounded_rect_mask(w, h, radius):
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m


def fit(im, box_w, box_h):
    w, h = im.size
    scale = min(box_w / w, box_h / h)
    return im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)


def strip_bg(path):
    """스튜디오 배경(밝은 회색~흰색)을 가장자리부터 flood fill 로 지운다."""
    if path in _cache:
        return _cache[path].copy()
    src = Image.open(path).convert('RGB')
    full = src.size[0]
    small = src.resize((240, 240), Image.LANCZOS)
    a = np.asarray(small).astype(np.int16)
    light = (a.min(axis=2) >= 224) & ((a.max(axis=2) - a.min(axis=2)) <= 14)
    seen = np.zeros((240, 240), bool)
    q = deque()
    for i in range(240):
        for x, y in ((i, 0), (i, 239), (0, i), (239, i)):
            if light[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < 240 and 0 <= nx < 240 and light[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    mask = Image.fromarray((~seen * 255).astype(np.uint8), 'L').resize((full, full), Image.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))
    out = src.convert('RGBA')
    out.putalpha(mask)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    _cache[path] = out
    return out.copy()


def load(slug, name):
    return strip_bg(os.path.join(ROOT, slug, 'raw', name + '.webp'))


def backdrop(size, tint, strength=0.13):
    small = Image.new('RGB', (64, 64), (255, 255, 255))
    d = ImageDraw.Draw(small)
    for i in range(30, 0, -1):
        v = i / 30.0
        c = tuple(int(255 - (255 - t) * strength * v) for t in tint)
        r = int(33 * v) + 2
        d.ellipse([32 - r, 32 - r, 32 + r, 32 + r], fill=c)
    return small.resize((size, size), Image.LANCZOS)


def draw_badge(img, xy, w, h, fill, text, tsize, sub=None, sub_size=None, fg=(255, 255, 255)):
    x, y = xy
    radius = int(h * 0.30)
    shadow = Image.new('RGBA', (w + 60, h + 60), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([30, 32, 30 + w, 32 + h], radius=radius, fill=(0, 0, 0, 60))
    shadow = shadow.filter(ImageFilter.GaussianBlur(9))
    img.alpha_composite(shadow, (x - 30, y - 30))
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill + (255,))
    f = font(FONT_BLACK, tsize)
    if sub:
        fb = font(FONT_BLACK, sub_size or int(tsize * 0.60))
        tb = d.textbbox((0, 0), sub, font=fb)
        tf = d.textbbox((0, 0), text, font=f)
        fh = tf[3] - tf[1]
        th = tb[3] - tb[1]
        ty = y + (h - (fh + 8 + th)) / 2 - tf[1]
        d.text((x + w / 2 - (tf[2] - tf[0]) / 2 - tf[0], ty), text, font=f, fill=fg)
        d.text((x + w / 2 - (tb[2] - tb[0]) / 2 - tb[0], ty + fh + 12), sub, font=fb, fill=fg)
    else:
        tb = d.textbbox((0, 0), text, font=f)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        d.text((x + (w - tw) / 2 - tb[0], y + (h - th) / 2 - tb[1]), text, font=f, fill=fg)
    img.alpha_composite(layer)


def card(slug, kind, items, out_path, size=900):
    cfg = PRODUCTS[slug]
    img = backdrop(size, cfg['tint']).convert('RGBA')
    frame = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle([14, 14, size - 14, size - 14], radius=46,
                                            outline=(240, 229, 206, 255), width=3)
    img.alpha_composite(frame)

    ims = [load(slug, n) for n in items]
    area_w, area_h = size - 140, size - 190
    if len(ims) == 1:
        pic = fit(ims[0], area_w, area_h)
        px, py = (size - pic.width) // 2, (size - pic.height) // 2 + 26
        shadow = Image.new('RGBA', (pic.width + 80, 90), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).ellipse([40, 20, pic.width + 40, 70], fill=(120, 100, 70, 60))
        shadow = shadow.filter(ImageFilter.GaussianBlur(18))
        img.alpha_composite(shadow, (px - 40, py + pic.height - 58))
        img.alpha_composite(pic, (px, py))
    else:
        n = len(ims)
        cols = 2 if n <= 4 else 3
        rows = (n + cols - 1) // cols
        cell_w, cell_h = area_w // cols, area_h // rows
        for i, im in enumerate(ims):
            r, c = divmod(i, cols)
            in_row = min(cols, n - r * cols)
            x_cell = (size - in_row * cell_w) // 2 + c * cell_w
            y_cell = (size - rows * cell_h) // 2 + 34 + r * cell_h
            tw, th = cell_w - 26, cell_h - 26
            m = rounded_rect_mask(tw, th, 28)
            tile = Image.new('RGBA', (tw, th), (255, 255, 255, 252))
            tile.putalpha(m)
            bd = Image.new('RGBA', (tw, th), (0, 0, 0, 0))
            ImageDraw.Draw(bd).rounded_rectangle([1, 1, tw - 2, th - 2], radius=28,
                                                 outline=(240, 231, 213, 255), width=3)
            tile.alpha_composite(bd)
            pic = fit(im, tw - 34, th - 34)
            tile.alpha_composite(pic, ((tw - pic.width) // 2, (th - pic.height) // 2))
            sh = Image.new('RGBA', (tw + 40, th + 40), (0, 0, 0, 0))
            ImageDraw.Draw(sh).rounded_rectangle([20, 22, 20 + tw, 22 + th], radius=28, fill=(120, 100, 70, 45))
            sh = sh.filter(ImageFilter.GaussianBlur(8))
            img.alpha_composite(sh, (x_cell - 20, y_cell - 20))
            img.alpha_composite(tile, (x_cell, y_cell))

    if kind == 'last':
        draw_badge(img, (44, 44), 250, 96, GRADE_RGB['last'], 'LAST ONE', 40, fg=(246, 199, 68))
    else:
        draw_badge(img, (44, 44), 136, 136, GRADE_RGB[kind], kind.upper() + '상', 60)

    img.convert('RGB').save(out_path, quality=90, optimize=True, progressive=True)
    print('saved', out_path, img.size)


def vertical_gradient(size, top, bottom):
    W, H = size
    g = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        t = y / (H - 1)
        g[y, :, :] = [int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)]
    return Image.fromarray(g, 'RGB')


def cover(slug, size=(900, 1125)):
    cfg = PRODUCTS[slug]
    W, H = size
    tint = cfg['tint']
    top = tuple(int(255 - (255 - c) * 0.30) for c in tint)
    bottom = tuple(int(255 - (255 - c) * 0.06) for c in tint)
    img = vertical_gradient(size, top, bottom).convert('RGBA')

    # 은은한 대각선 패턴
    pattern = Image.new('RGBA', size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(pattern)
    for i in range(-H, W, 46):
        pd.line([(i, 0), (i + H, H)], fill=(255, 255, 255, 40), width=14)
    pattern = pattern.filter(ImageFilter.GaussianBlur(6))
    img.alpha_composite(pattern)

    # 흰 원형 스테이지
    stage = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stage)
    r = int(W * 0.40)
    cx, cy = W // 2, int(H * 0.40)
    sd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(120, 100, 70, 45))
    stage = stage.filter(ImageFilter.GaussianBlur(22))
    img.alpha_composite(stage, (0, 26))
    plate = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(plate).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 236))
    img.alpha_composite(plate)

    # 상단 워드마크 필
    wtxt = '一番くじ · ' + cfg['series']
    wf = font(FONT_BOLD, 30)
    tmp = Image.new('RGBA', (10, 10))
    td = ImageDraw.Draw(tmp)
    tb = td.textbbox((0, 0), wtxt, font=wf)
    pw, ph = tb[2] - tb[0] + 62, 68
    pill_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    pd2 = ImageDraw.Draw(pill_layer)
    px0 = (W - pw) // 2
    pd2.rounded_rectangle([px0, 56, px0 + pw, 56 + ph], radius=34, fill=(255, 255, 255, 235))
    img.alpha_composite(pill_layer)
    d2 = ImageDraw.Draw(img)
    dark = tuple(max(0, int(c * 0.55)) for c in tint)
    d2.text((px0 + 31 - tb[0], 56 + (ph - (tb[3] - tb[1])) / 2 - tb[1]), wtxt, font=wf, fill=dark)

    main = load(slug, cfg['tiers']['a'][0])
    pic = fit(main, int(W * 0.80), int(H * 0.58))
    img.alpha_composite(pic, ((W - pic.width) // 2, cy - pic.height // 2 + int(H * 0.01)))

    # 하단 등급 썸네일 4개
    keys = ['b', 'c', 'd', 'e']
    box, gap = 168, 18
    total = len(keys) * box + (len(keys) - 1) * gap
    x0 = (W - total) // 2
    y0 = int(H * 0.755)
    for i, k in enumerate(keys):
        im = load(slug, cfg['tiers'][k][0])
        tile = Image.new('RGBA', (box, box), (0, 0, 0, 0))
        tile.paste(Image.new('RGBA', (box, box), (255, 255, 255, 255)), (0, 0), rounded_mask(box, 30))
        pic2 = fit(im, box - 30, box - 30)
        tile.alpha_composite(pic2, ((box - pic2.width) // 2, (box - pic2.height) // 2 - 4))
        bd = Image.new('RGBA', (box, box), (0, 0, 0, 0))
        ImageDraw.Draw(bd).rounded_rectangle([1, 1, box - 2, box - 2], radius=30,
                                             outline=(255, 255, 255, 255), width=5)
        tile.alpha_composite(bd)
        shadow = Image.new('RGBA', (box + 50, box + 50), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([25, 27, 25 + box, 27 + box], radius=30, fill=(80, 60, 40, 70))
        shadow = shadow.filter(ImageFilter.GaussianBlur(9))
        x = x0 + i * (box + gap)
        img.alpha_composite(shadow, (x - 25, y0 - 25))
        img.alpha_composite(tile, (x, y0))
        # 등급 칩
        chip = Image.new('RGBA', (54, 54), (0, 0, 0, 0))
        ImageDraw.Draw(chip).ellipse([0, 0, 53, 53], fill=GRADE_RGB[k] + (255,),
                                     outline=(255, 255, 255, 255), width=4)
        d = ImageDraw.Draw(chip)
        f = font(FONT_BLACK, 30)
        tb = d.textbbox((0, 0), k.upper(), font=f)
        d.text((27 - (tb[2] - tb[0]) / 2 - tb[0], 27 - (tb[3] - tb[1]) / 2 - tb[1]), k.upper(), font=f, fill=(255, 255, 255))
        img.alpha_composite(chip, (x + box - 40, y0 - 14))

    img.convert('RGB').save(os.path.join(ROOT, slug, 'cover.jpg'), quality=92, optimize=True)
    print('saved cover', slug, img.size)


if __name__ == '__main__':
    for slug, cfg in PRODUCTS.items():
        for g, items in cfg['tiers'].items():
            card(slug, g, items, os.path.join(ROOT, slug, 'tier_%s.jpg' % g))
        card(slug, 'last', [cfg['last']], os.path.join(ROOT, slug, 'last_one.jpg'))
        cover(slug)
