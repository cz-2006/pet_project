import argparse
import json
import sys
from pathlib import Path


def export_with_av(in_path, out_dir, pad, start, every):
    import av
    from PIL import Image

    container = av.open(str(in_path))
    stream = container.streams.video[0]
    fps = float(stream.average_rate) if stream.average_rate else None

    in_index = 0
    out_index = start

    for frame in container.decode(stream):
        if in_index % every != 0:
            in_index += 1
            continue
        arr = frame.to_ndarray(format="rgba")
        img = Image.fromarray(arr, "RGBA")
        img.save(out_dir / f"{out_index:0{pad}d}.png")
        out_index += 1
        in_index += 1

    return fps, out_index - start


def export_with_cv2(in_path, out_dir, pad, start, every):
    import cv2

    cap = cv2.VideoCapture(str(in_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or None

    in_index = 0
    out_index = start
    warned = False

    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        if in_index % every != 0:
            in_index += 1
            continue
        if len(frame.shape) == 2:
            frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGRA)
        elif frame.shape[2] == 3:
            if not warned:
                print("WARNING: OpenCV backend likely drops alpha. Install 'av' for true alpha.")
                warned = True
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
        cv2.imwrite(str(out_dir / f"{out_index:0{pad}d}.png"), frame)
        out_index += 1
        in_index += 1

    cap.release()
    return fps, out_index - start


def convert_one(in_path, out_root, pad, start, every, strip_suffix):
    in_path = Path(in_path)
    if not in_path.exists():
        raise FileNotFoundError(in_path)

    name = in_path.stem
    if strip_suffix and name.endswith(strip_suffix):
        name = name[: -len(strip_suffix)]

    out_dir = Path(out_root) / name
    out_dir.mkdir(parents=True, exist_ok=True)

    backend = "av"
    try:
        fps, frames = export_with_av(in_path, out_dir, pad, start, every)
    except Exception:
        try:
            backend = "cv2"
            fps, frames = export_with_cv2(in_path, out_dir, pad, start, every)
        except Exception as exc:
            raise RuntimeError("No usable backend found. Install 'av' + 'Pillow' or 'opencv-python'.") from exc

    meta = {
        "source": str(in_path),
        "frames": frames,
        "fps": fps,
        "backend": backend
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return out_dir, meta


def iter_inputs(input_dir):
    exts = {".mp4", ".mov"}
    for p in sorted(Path(input_dir).iterdir()):
        if p.is_file() and p.suffix.lower() in exts:
            yield p


def main():
    parser = argparse.ArgumentParser(description="Export MP4/MOV to PNG sequence.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", help="Single input file (.mp4/.mov)")
    group.add_argument("--input-dir", help="Directory with .mp4/.mov files")
    parser.add_argument("--outdir", default="assets/frames", help="Output root directory")
    parser.add_argument("--pad", type=int, default=4, help="Zero padding width")
    parser.add_argument("--start", type=int, default=1, help="Start index")
    parser.add_argument("--every", type=int, default=1, help="Export every Nth frame")
    parser.add_argument("--strip-suffix", default="_transparent", help="Strip suffix from folder name")
    args = parser.parse_args()

    outputs = []
    if args.input:
        outputs.append(convert_one(args.input, args.outdir, args.pad, args.start, args.every, args.strip_suffix))
    else:
        for p in iter_inputs(args.input_dir):
            outputs.append(convert_one(p, args.outdir, args.pad, args.start, args.every, args.strip_suffix))

    for out_dir, meta in outputs:
        print(f"{out_dir} -> {meta['frames']} frames (fps={meta['fps']}, backend={meta['backend']})")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc))
        sys.exit(1)
