#!/usr/bin/env python3
"""Eklenti simgesini üretir — bağımlılık yok, zlib ile ham PNG yazar.

Terminal penceresi + `>_` istemi + geri dönüş oku (hafızadan geri getirme).
"""
import math
import struct
import zlib
from pathlib import Path

BOY = 256
VURGU = (34, 211, 238)     # cyan-400
VURGU2 = (56, 189, 248)    # sky-400
CERCEVE = (51, 65, 85)     # slate-700

tuval = [[(0, 0, 0) for _ in range(BOY)] for _ in range(BOY)]


def harmanla(x, y, renk, a):
    if not (0 <= x < BOY and 0 <= y < BOY) or a <= 0:
        return
    a = min(1.0, a)
    eski = tuval[y][x]
    tuval[y][x] = tuple(int(eski[i] * (1 - a) + renk[i] * a) for i in range(3))


def yuvarlak_kare(x0, y0, x1, y1, r, renk, kalinlik=None):
    """Dolu ya da çerçeveli yuvarlatılmış dikdörtgen (kenar yumuşatmalı)."""
    for y in range(max(0, int(y0) - 2), min(BOY, int(y1) + 3)):
        for x in range(max(0, int(x0) - 2), min(BOY, int(x1) + 3)):
            dx = max(x0 + r - x, 0, x - (x1 - r))
            dy = max(y0 + r - y, 0, y - (y1 - r))
            d = math.hypot(dx, dy) - r
            if kalinlik is None:
                harmanla(x, y, renk, 0.5 - d)
            else:
                harmanla(x, y, renk, min(0.5 - d, d + kalinlik + 0.5))


def cizgi(x0, y0, x1, y1, kalinlik, renk):
    """Uçları yuvarlatılmış kalın çizgi."""
    uz2 = (x1 - x0) ** 2 + (y1 - y0) ** 2
    for y in range(BOY):
        for x in range(BOY):
            t = 0 if uz2 == 0 else max(0, min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / uz2))
            d = math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)))
            harmanla(x, y, renk, kalinlik / 2 + 0.5 - d)


def yay(cx, cy, ic, dis, bas, bit, renk):
    for y in range(BOY):
        for x in range(BOY):
            d = math.hypot(x - cx, y - cy)
            if ic - 1 <= d <= dis + 1:
                aci = math.degrees(math.atan2(y - cy, x - cx)) % 360
                if bas <= aci <= bit:
                    harmanla(x, y, renk, min(d - (ic - 1), (dis + 1) - d, 1.0))


# Zemin — hafif dikey gradyan
for y in range(BOY):
    for x in range(BOY):
        t = y / BOY
        tuval[y][x] = (int(11 + 6 * t), int(18 + 10 * t), int(32 + 18 * t))

# Terminal penceresi çerçevesi
yuvarlak_kare(34, 52, 222, 196, 18, CERCEVE, kalinlik=5)
# Başlık çubuğu ayracı
cizgi(38, 84, 218, 84, 3, CERCEVE)
# Üç düğme
for i, cx in enumerate((56, 76, 96)):
    for y in range(BOY):
        for x in range(BOY):
            harmanla(x, y, CERCEVE, 4.5 - math.hypot(x - cx, y - 68))

# `>` istemi
cizgi(66, 108, 96, 130, 9, VURGU)
cizgi(96, 130, 66, 152, 9, VURGU)
# `_` imleç — geri dönüş okuna değmesin diye kısa tutuldu
cizgi(110, 154, 142, 154, 9, VURGU)

# Geri dönüş oku — sağ altta, "kaldığı yerden devam".
# Sağ tarafta boşluk bırakılıp ok ucu oraya konuyor, halka kapanmıyor.
yay(178, 150, 17, 23, 35, 335, VURGU2)
cizgi(196, 128, 196, 146, 7, VURGU2)   # ok ucu — üst kanat
cizgi(196, 146, 212, 140, 7, VURGU2)   # ok ucu — alt kanat


def png_yaz(yol):
    ham = b''.join(
        b'\x00' + b''.join(struct.pack('3B', *tuval[y][x]) for x in range(BOY))
        for y in range(BOY)
    )

    def parca(etiket, veri):
        govde = etiket + veri
        return struct.pack('>I', len(veri)) + govde + struct.pack('>I', zlib.crc32(govde))

    png = (b'\x89PNG\r\n\x1a\n'
           + parca(b'IHDR', struct.pack('>IIBBBBB', BOY, BOY, 8, 2, 0, 0, 0))
           + parca(b'IDAT', zlib.compress(ham, 9))
           + parca(b'IEND', b''))
    Path(yol).parent.mkdir(parents=True, exist_ok=True)
    Path(yol).write_bytes(png)
    return len(png)


if __name__ == '__main__':
    hedef = Path(__file__).resolve().parent.parent / 'media' / 'simge.png'
    print(f'{hedef} — {png_yaz(hedef)} bayt')
