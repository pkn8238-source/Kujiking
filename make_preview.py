#!/usr/bin/env python3
"""preview-v35.html 생성기 — 배포 검토 전용 (검증 후 삭제)
사용: python3 make_preview.py <rev> [원본 index.html 경로]
"""
import sys, subprocess, pathlib

rev = sys.argv[1] if len(sys.argv) > 1 else subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD']).decode().strip()
root = pathlib.Path(__file__).resolve().parent
src = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else (root / 'index.html')
html = src.read_text(encoding='utf-8')
html = html.replace('<title>쿠지킹 KUJIKING — 한 장에 설레는 순간</title>', '<title>쿠지킹 v3.5 미리보기</title>')
html = html.replace('assets/styles.css?v=3.5', f'assets/styles.v35.css?v={rev}')
html = html.replace('assets/config.js?v=3.0.2', f'assets/config.demo.js?v={rev}')
html = html.replace('assets/app.js?v=3.5', f'assets/app.v35.js?v={rev}')
html = html.replace(f'<script src="assets/app.v35.js?v={rev}" defer></script>',
                    f'<script src="assets/app.v35.js?v={rev}" defer></script>\n'
                    f'<script src="assets/driver.v35.js?v={rev}" defer></script>')
(root / 'preview-v35.html').write_text(html, encoding='utf-8')
print('preview-v35.html rev =', rev)
