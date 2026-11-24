#!/usr/bin/env python3
"""쿠지킹 — 2026-11-24 신규 3판(치이카와 온천 · 귀멸의 칼날 상현의 2 · 주술회전 5주년 FINAL) 등급 카드 생성.

기존 build_assets.py 의 카드 렌더러를 그대로 쓰고, 새 판 설정만 더해
tier_a.jpg ~ tier_*.jpg / last_one.jpg (900x900) 를 만든다.
커버(1600x1100)는 work/kujiking-cover-work/make_covers.py 에서 만든다.
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_assets as B


def strip_bg_soft(path, thresh=210, satmax=22):
    """1kuji 공식 사진(#e7e7e7 스튜디오 배경)을 더 넓은 임계값으로 지운다.

    기존 strip_bg 는 밝기 224 미만 픽셀을 남겨 사진 가장자리에 옅은 사각 테두리가
    보였다. 테두리에서 시작하는 flood fill 이라 인물 내부의 흰색은 지우지 않는다.
    """
    if path in B._cache:
        return B._cache[path].copy()
    src = Image.open(path).convert('RGB')
    full = src.size[0]
    small = src.resize((240, 240), Image.LANCZOS)
    a = np.asarray(small).astype(np.int16)
    light = (a.min(axis=2) >= thresh) & ((a.max(axis=2) - a.min(axis=2)) <= satmax)
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
    mask = mask.filter(ImageFilter.GaussianBlur(1.1))
    out = src.convert('RGBA')
    out.putalpha(mask)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    B._cache[path] = out
    return out.copy()


B.strip_bg = strip_bg_soft

B.FONT_BLACK = '/workspace/work/kujiking-site/assets/fonts/Pretendard-Black.otf'
B.FONT_BOLD = '/workspace/work/kujiking-site/assets/fonts/Pretendard-Bold.otf'

B.PRODUCTS['chiikawa'] = {
    'series': '치이카와',
    'tint': (138, 202, 222),      # 목욕탕 물빛
    'tiers': {c: [c] for c in 'abcdefgh'},
    'last': 'last',
}
B.PRODUCTS['kimetsu'] = {
    'series': '귀멸의 칼날',
    'tint': (96, 132, 186),       # 상현의 밤
    'tiers': {c: [c] for c in 'abcdefgh'},
    'last': 'last',
}
B.PRODUCTS['jujutsu'] = {
    'series': '주술회전',
    'tint': (132, 112, 196),      # 주력(呪力) 보라
    'tiers': {c: [c] for c in 'abcdefghij'},
    'last': 'last',
}
B.PRODUCTS['myhero'] = {
    'series': '나의 히어로 아카데미아',
    'tint': (236, 150, 96),       # 히어로 오렌지
    'tiers': {c: [c] for c in 'abcdefghi'},
    'last': 'last',
}

ROOT = B.ROOT

if __name__ == '__main__':
    for slug in ['chiikawa', 'kimetsu', 'jujutsu', 'myhero']:
        cfg = B.PRODUCTS[slug]
        for g in cfg['tiers']:
            B.card(slug, g, cfg['tiers'][g], os.path.join(ROOT, slug, 'tier_%s.jpg' % g))
        B.card(slug, 'last', [cfg['last']], os.path.join(ROOT, slug, 'last_one.jpg'))
