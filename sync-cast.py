#!/usr/bin/env python3
"""temp/cast의 원본 배우 사진을 표시용 크기로 축소해 images/로 복사한다.
사용: temp/cast에 사진을 추가/수정한 뒤  python3 sync-cast.py
(temp/은 gitignore — 원본은 로컬 보관, images/의 축소본만 커밋)"""
import glob, os
from PIL import Image, ImageOps
SRC, DST, MAX, Q = "temp/cast", "images", 680, 82
def main():
    n = 0
    for p in sorted(glob.glob(os.path.join(SRC, "*.jpeg"))):
        im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")  # EXIF 회전 보정
        w, h = im.size; s = MAX / max(w, h)
        if s < 1: im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
        im.save(os.path.join(DST, os.path.basename(p)), "JPEG", quality=Q, optimize=True)
        n += 1
    print(f"{n}장 축소 복사 → {DST}/")
if __name__ == "__main__":
    main()
