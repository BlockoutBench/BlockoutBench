#!/usr/bin/env python3
"""Build LevelWorkbench native Windows GUI launcher (关卡工作台.exe) and app icon."""

from __future__ import annotations

import math
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESKTOP_DIR = ROOT / "desktop"
ICON_PATH = DESKTOP_DIR / "app.ico"
LAUNCHER_C = DESKTOP_DIR / "launcher.c"
OUTPUT_EXE = ROOT / "关卡工作台.exe"

VS_ROOTS = [
    pathlib.Path(r"C:\Program Files\Microsoft Visual Studio"),
    pathlib.Path(r"C:\Program Files (x86)\Microsoft Visual Studio"),
]
WINSDK_ROOT = pathlib.Path(r"C:\Program Files (x86)\Windows Kits\10")


def _blend(dst: tuple[int, int, int, int], src: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    sr, sg, sb, sa = src
    if sa <= 0:
        return dst
    if sa >= 255:
        return src
    dr, dg, db, da = dst
    af = sa / 255.0
    inv = 1.0 - af
    out_a = sa + da * inv
    if out_a <= 0:
        return (0, 0, 0, 0)
    return (
        int(round((sr * af + dr * (da / 255.0) * inv) / (out_a / 255.0))),
        int(round((sg * af + dg * (da / 255.0) * inv) / (out_a / 255.0))),
        int(round((sb * af + db * (da / 255.0) * inv) / (out_a / 255.0))),
        int(round(out_a)),
    )


def _rounded_rect_alpha(u: float, v: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    cx = max(x0 + r, min(x1 - r, u))
    cy = max(y0 + r, min(y1 - r, v))
    dx = u - cx
    dy = v - cy
    return (dx * dx + dy * dy) <= r * r and x0 <= u <= x1 and y0 <= v <= y1


def _sample_icon_pixel(u: float, v: float) -> tuple[int, int, int, int]:
    """Sample LevelWorkbench architectural blueprint icon at normalized coords u,v in [0, 1]."""
    if not _rounded_rect_alpha(u, v, 0.04, 0.04, 0.96, 0.96, 0.18):
        return (0, 0, 0, 0)

    # Outer slate frame (#1f242b)
    col = (31, 36, 43, 255)

    # Inner parchment badge (#f6f1e6)
    if _rounded_rect_alpha(u, v, 0.09, 0.09, 0.91, 0.91, 0.13):
        col = (246, 241, 230, 255)

        # Subtle blueprint grid lines (#e4dccb)
        for g in (0.25, 0.50, 0.75):
            if abs(u - g) < 0.012 or abs(v - g) < 0.012:
                col = (228, 220, 203, 255)

        # Architectural room whitebox walls (#242b33)
        ink = (36, 43, 51, 255)
        w = 0.032

        # Outer room perimeter (left, top, right, bottom)
        on_top = 0.21 <= u <= 0.79 and abs(v - 0.22) <= w
        on_bot = 0.21 <= u <= 0.79 and abs(v - 0.78) <= w
        on_left = 0.22 <= v <= 0.78 and abs(u - 0.21) <= w
        on_right = 0.22 <= v <= 0.78 and abs(u - 0.79) <= w
        # Interior divider wall with central doorway opening (v in 0.43..0.57)
        on_mid_top = 0.22 <= v <= 0.41 and abs(u - 0.50) <= w
        on_mid_bot = 0.59 <= v <= 0.78 and abs(u - 0.50) <= w
        # Side room partition with door gap on right room
        on_sub = 0.50 <= u <= 0.79 and abs(v - 0.50) <= w * 0.85

        if on_top or on_bot or on_left or on_right or on_mid_top or on_mid_bot or on_sub:
            col = ink

        # Main route path (#c86428) flowing through left room -> doorway -> right top room
        route = (200, 100, 40, 255)
        # Segment 1: (0.35, 0.63) -> (0.35, 0.50)
        if abs(u - 0.35) <= 0.024 and 0.48 <= v <= 0.65:
            col = route
        # Segment 2: (0.35, 0.50) -> (0.65, 0.50) wait - doorway is center-v, go straight through gap
        if abs(v - 0.50) <= 0.024 and 0.35 <= u <= 0.65:
            col = route
        # Segment 3: (0.65, 0.50) -> (0.65, 0.35)
        if abs(u - 0.65) <= 0.024 and 0.34 <= v <= 0.50:
            col = route

        # Amber waypoint circle in top-right chamber
        d_target = math.hypot(u - 0.65, v - 0.35)
        if d_target <= 0.068:
            col = (200, 100, 40, 255)
        if d_target <= 0.028:
            col = (255, 250, 240, 255)

        # Slate start anchor in bottom-left chamber
        d_start = math.hypot(u - 0.35, v - 0.63)
        if d_start <= 0.056:
            col = (45, 95, 138, 255)

    return col


def _render_rgba(size: int) -> bytes:
    """Render size x size RGBA buffer with 2x2 supersampling."""
    buf = bytearray(size * size * 4)
    offsets = (0.25, 0.75)
    for y in range(size):
        for x in range(size):
            r_sum = g_sum = b_sum = a_sum = 0
            for oy in offsets:
                v = (y + oy) / size
                for ox in offsets:
                    u = (x + ox) / size
                    r, g, b, a = _sample_icon_pixel(u, v)
                    r_sum += r
                    g_sum += g
                    b_sum += b
                    a_sum += a
            idx = (y * size + x) * 4
            buf[idx] = r_sum // 4
            buf[idx + 1] = g_sum // 4
            buf[idx + 2] = b_sum // 4
            buf[idx + 3] = a_sum // 4
    return bytes(buf)


def _rgba_to_ico_dib(size: int, rgba: bytes) -> bytes:
    """Encode RGBA pixels into a 32-bit bottom-up BGRA DIB + 1bpp AND mask for .ico."""
    # BITMAPINFOHEADER (40 bytes): biHeight is doubled (color + AND mask)
    header = struct.pack(
        "<IiiHHIIiiII",
        40,         # biSize
        size,       # biWidth
        size * 2,   # biHeight
        1,          # biPlanes
        32,         # biBitCount
        0,          # biCompression (BI_RGB)
        size * size * 4,
        0, 0, 0, 0,
    )
    xor_rows = bytearray()
    and_rows = bytearray()
    and_stride = ((size + 31) // 32) * 4

    for y in range(size - 1, -1, -1):
        and_row = bytearray(and_stride)
        for x in range(size):
            src = (y * size + x) * 4
            r, g, b, a = rgba[src], rgba[src + 1], rgba[src + 2], rgba[src + 3]
            xor_rows.extend((b, g, r, a))
            if a == 0:
                and_row[x // 8] |= 1 << (7 - (x % 8))
        and_rows.extend(and_row)

    return header + bytes(xor_rows) + bytes(and_rows)


def _rgba_to_png(size: int, rgba: bytes) -> bytes:
    """Encode RGBA pixels into PNG bytes (used for 256x256 ICO entry)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw_rows = bytearray()
    row_bytes = size * 4
    for y in range(size):
        raw_rows.append(0)
        start = y * row_bytes
        raw_rows.extend(rgba[start : start + row_bytes])

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def write_icon(path: pathlib.Path) -> None:
    entries: list[tuple[int, bytes]] = []
    for sz in (16, 32, 48, 64):
        entries.append((sz, _rgba_to_ico_dib(sz, _render_rgba(sz))))
    entries.append((256, _rgba_to_png(256, _render_rgba(256))))

    count = len(entries)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + count * 16
    dir_entries = bytearray()
    payloads = bytearray()

    for sz, blob in entries:
        dim = 0 if sz >= 256 else sz
        dir_entries.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset))
        payloads.extend(blob)
        offset += len(blob)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + bytes(dir_entries) + bytes(payloads))


def _ver_key(name: str) -> tuple[int, ...]:
    parts = []
    for seg in name.split("."):
        try:
            parts.append(int(seg))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def find_msvc_toolchain() -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    candidates: list[tuple[tuple[int, ...], pathlib.Path, pathlib.Path, pathlib.Path]] = []
    for root in VS_ROOTS:
        if not root.is_dir():
            continue
        for cl in root.glob("**/VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe"):
            msvc_dir = cl.parents[3]
            inc = msvc_dir / "include"
            lib = msvc_dir / "lib" / "x64"
            if inc.is_dir() and lib.is_dir():
                candidates.append((_ver_key(msvc_dir.name), cl, inc, lib))
    if not candidates:
        raise FileNotFoundError("未找到 MSVC x64 cl.exe 工具链")
    candidates.sort(key=lambda item: item[0], reverse=True)
    _, cl, inc, lib = candidates[0]
    return cl, inc, lib


def find_winsdk() -> tuple[pathlib.Path, list[pathlib.Path], list[pathlib.Path]]:
    bin_root = WINSDK_ROOT / "bin"
    if not bin_root.is_dir():
        raise FileNotFoundError("未找到 Windows Kits 10")
    candidates: list[tuple[tuple[int, ...], pathlib.Path, list[pathlib.Path], list[pathlib.Path]]] = []
    for rc in bin_root.glob("*/x64/rc.exe"):
        ver = rc.parents[1].name
        inc_base = WINSDK_ROOT / "Include" / ver
        lib_base = WINSDK_ROOT / "Lib" / ver
        incs = [inc_base / "um", inc_base / "shared", inc_base / "ucrt"]
        libs = [lib_base / "um" / "x64", lib_base / "ucrt" / "x64"]
        if all(p.is_dir() for p in incs + libs):
            candidates.append((_ver_key(ver), rc, incs, libs))
    if not candidates:
        raise FileNotFoundError("未找到完整的 Windows 10 SDK (x64 rc.exe / include / lib)")
    candidates.sort(key=lambda item: item[0], reverse=True)
    _, rc, incs, libs = candidates[0]
    return rc, incs, libs


def main() -> int:
    write_icon(ICON_PATH)
    print(f"Icon written: {ICON_PATH} ({ICON_PATH.stat().st_size} bytes)")

    cl, msvc_inc, msvc_lib = find_msvc_toolchain()
    rc, sdk_incs, sdk_libs = find_winsdk()

    tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="lw_exe_"))
    try:
        rc_ico = tmp_dir / "app.ico"
        rc_file = tmp_dir / "launcher.rc"
        res_file = tmp_dir / "launcher.res"
        obj_file = tmp_dir / "launcher.obj"

        shutil.copy2(ICON_PATH, rc_ico)
        rc_file.write_text('1 ICON "app.ico"\n', encoding="ascii")

        rc_cmd = [str(rc), "/nologo"]
        for inc in sdk_incs:
            rc_cmd.extend(["/i", str(inc)])
        rc_cmd.extend(["/fo", str(res_file), str(rc_file)])
        rc_res = subprocess.run(rc_cmd, cwd=str(tmp_dir), capture_output=True, text=True)
        if rc_res.stdout.strip():
            print(rc_res.stdout.strip())
        if rc_res.stderr.strip():
            print(rc_res.stderr.strip(), file=sys.stderr)
        if rc_res.returncode != 0:
            raise RuntimeError(f"rc.exe 编译资源失败 (exit {rc_res.returncode})")

        cl_cmd = [
            str(cl),
            "/nologo",
            "/O2",
            "/MT",
            "/W3",
            "/utf-8",
            f"/I{msvc_inc}",
            *[f"/I{inc}" for inc in sdk_incs],
            f"/Fo:{obj_file}",
            f"/Fe:{OUTPUT_EXE}",
            str(LAUNCHER_C),
            str(res_file),
            "/link",
            f"/LIBPATH:{msvc_lib}",
            *[f"/LIBPATH:{lib}" for lib in sdk_libs],
            "/SUBSYSTEM:WINDOWS",
            "kernel32.lib",
        ]
        cl_res = subprocess.run(cl_cmd, cwd=str(ROOT), capture_output=True, text=True)
        if cl_res.stdout.strip():
            print(cl_res.stdout.strip())
        if cl_res.stderr.strip():
            print(cl_res.stderr.strip(), file=sys.stderr)
        if cl_res.returncode != 0:
            raise RuntimeError(f"cl.exe 编译失败 (exit {cl_res.returncode})")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    print(f"Built launcher: {OUTPUT_EXE} ({OUTPUT_EXE.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
