#!/usr/bin/env python3
"""temp/cast의 원본 배우 사진을 표시용 크기로 축소해 shows/<공연id>/images/로 복사한다.
사용: temp/cast에 사진을 추가/수정한 뒤  python3 sync-cast.py [공연id]
(공연id 생략 시 shows/index.json의 default 공연.
 temp/은 gitignore — 원본은 로컬 보관, shows/<id>/images/의 축소본만 커밋)"""
import glob, json, os, sys
from PIL import Image, ImageOps
SRC, MAX, Q = "temp/cast", 680, 82
EXTS = ("*.jpeg", "*.jpg", "*.JPEG", "*.JPG")   # 원본은 .jpeg/.jpg 모두 허용, 출력은 항상 .jpeg
def main():
    show = sys.argv[1] if len(sys.argv) > 1 else json.load(open("shows/index.json", encoding="utf-8"))["default"]
    dst = os.path.join("shows", show, "images")
    if not os.path.isdir(dst):
        sys.exit(f"대상 폴더가 없습니다: {dst} (공연id 확인: shows/index.json)")
    srcs = {}
    for pat in EXTS:                                # 이름(확장자 제외) 기준 dedupe, .jpeg 우선
        for p in glob.glob(os.path.join(SRC, pat)):
            srcs.setdefault(os.path.splitext(os.path.basename(p))[0], p)
    n = 0
    for stem, p in sorted(srcs.items()):
        im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")  # EXIF 회전 보정
        w, h = im.size; s = MAX / max(w, h)
        if s < 1: im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
        im.save(os.path.join(dst, stem + ".jpeg"), "JPEG", quality=Q, optimize=True)  # 출력은 항상 .jpeg
        n += 1
    print(f"{n}장 축소 복사 → {dst}/")
if __name__ == "__main__":
    main()
