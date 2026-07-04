#!/usr/bin/env python3
"""temp/cast의 원본 배우 사진을 표시용 크기로 축소해 shows/<공연id>/images/로 복사하고,
Finale용 스프라이트(합친 사진 1장 + 좌표 JSON)를 생성한다.
사용: temp/cast에 사진을 추가/수정한 뒤  python3 sync-cast.py [공연id]
(공연id 생략 시 shows/index.json의 default 공연.
 temp/은 gitignore — 원본은 로컬 보관, shows/<id>/images/의 축소본·스프라이트만 커밋.
 스프라이트는 이미 축소된 shows/<id>/images/*.jpeg 를 읽어 만들므로, 사진만 바꾸고
 이 스크립트를 다시 돌리면 스프라이트도 자동 갱신된다. temp/cast 원본이 없어도 재생성 가능.)"""
import glob, hashlib, io, json, os, sys
from PIL import Image, ImageOps
SRC, MAX, Q = "temp/cast", 680, 82
SPRITE_TILE, SPRITE_W, SPRITE_Q = 400, 2000, 82   # 타일 최대 변(px)·스프라이트 목표 폭·품질

# Finale 캐스팅 보드 사진들을 한 장(casting-sprite.jpg)으로 팩킹하고, 각 사진의 절대 좌표를
# casting-sprite.json에 저장한다. 사진 비율이 제각각이어도 좌표로 정확히 잘라 쓸 수 있다.
def build_sprite(dst):
    paths = sorted(glob.glob(os.path.join(dst, "*.jpeg")))   # 배우 사진·플레이스홀더(.jpeg). 생성물은 .jpg라 제외됨
    if not paths:
        print("스프라이트: 사진(.jpeg) 없음 — 건너뜀"); return
    tiles = []
    for p in paths:
        im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
        w, h = im.size; s = SPRITE_TILE / max(w, h)
        if s < 1: im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
        tiles.append((os.path.splitext(os.path.basename(p))[0], im))
    tiles.sort(key=lambda t: t[0])   # 이름순 고정 배치 → 재생성 시 git diff 안정
    PAD = 2; x = y = shelf_h = sw = 0; meta = {}
    for stem, im in tiles:
        w, h = im.size
        if x > 0 and x + w > SPRITE_W:   # 목표 폭 넘으면 다음 줄(shelf)
            x = 0; y += shelf_h + PAD; shelf_h = 0
        meta[stem] = (x, y, w, h, im); x += w + PAD; shelf_h = max(shelf_h, h); sw = max(sw, x - PAD)
    sh = y + shelf_h
    sprite = Image.new("RGB", (sw, sh), (255, 255, 255))
    coords = {}
    for stem, (px, py, w, h, im) in meta.items():
        sprite.paste(im, (px, py)); coords[stem] = {"x": px, "y": py, "w": w, "h": h}
    buf = io.BytesIO(); sprite.save(buf, "JPEG", quality=SPRITE_Q, optimize=True); data = buf.getvalue()
    ver = hashlib.sha256(data).hexdigest()[:8]   # 내용 해시 = 캐시 버스터(바뀔 때만 URL 변경)
    with open(os.path.join(dst, "casting-sprite.jpg"), "wb") as f: f.write(data)
    # sprite 경로는 공연 폴더 상대(showUrl이 해석) — 사진과 같은 images/ 폴더
    manifest = {"version": 1, "sprite": f"images/casting-sprite.jpg?v={ver}", "w": sw, "h": sh, "tiles": coords}
    with open(os.path.join(dst, "casting-sprite.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    print(f"스프라이트 생성: {len(coords)}장 → casting-sprite.jpg ({len(data)//1024} KB, {sw}x{sh}) + casting-sprite.json")

def main():
    show = sys.argv[1] if len(sys.argv) > 1 else json.load(open("shows/index.json", encoding="utf-8"))["default"]
    dst = os.path.join("shows", show, "images")
    if not os.path.isdir(dst):
        sys.exit(f"대상 폴더가 없습니다: {dst} (공연id 확인: shows/index.json)")
    n = 0
    for p in sorted(glob.glob(os.path.join(SRC, "*.jpeg"))):
        im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")  # EXIF 회전 보정
        w, h = im.size; s = MAX / max(w, h)
        if s < 1: im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
        im.save(os.path.join(dst, os.path.basename(p)), "JPEG", quality=Q, optimize=True)
        n += 1
    print(f"{n}장 축소 복사 → {dst}/")
    build_sprite(dst)   # 축소본으로 Finale 스프라이트 재생성(사진 안 바꿔도 항상 최신 유지)
if __name__ == "__main__":
    main()
