import argparse
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


def _background_mask_from_white(rgb, white_thresh):
    dist = (255.0 - rgb.astype(np.float32)).max(axis=2)
    candidate = dist <= float(white_thresh)
    if not np.any(candidate):
        return np.zeros(candidate.shape, dtype=bool)

    _, labels = cv2.connectedComponents(candidate.astype(np.uint8), connectivity=8)
    border = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    border_labels = np.unique(border)
    border_labels = border_labels[border_labels != 0]
    if border_labels.size == 0:
        return np.zeros(candidate.shape, dtype=bool)

    return np.isin(labels, border_labels)


def _bg_transparent_with_outline(rgb, bg_mask, outline_px):
    alpha = np.where(bg_mask, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])

    if outline_px and outline_px > 0:
        fg_mask = ~bg_mask
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (outline_px * 2 + 1, outline_px * 2 + 1))
        dil = cv2.dilate(fg_mask.astype(np.uint8), k, iterations=1).astype(bool)
        edge = dil & ~fg_mask
        rgba[edge, :3] = 255
        rgba[edge, 3] = 255

    return rgba


def _detect_watermark_mask(
    rgb,
    wm_detect_thresh=25,
    wm_color_thresh=220,
    wm_sat_thresh=60,
    wm_roi_frac=0.6,
    wm_area_min_ratio=0.0002,
    wm_area_max_ratio=0.02,
    bg_mask=None,
):
    h, w, _ = rgb.shape
    x0 = int(w * wm_roi_frac)
    y0 = int(h * wm_roi_frac)
    roi = rgb[y0:h, x0:w]
    dist = (255.0 - roi.astype(np.float32)).max(axis=2)
    hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)
    sat = hsv[..., 1]
    candidate = (dist >= float(wm_detect_thresh)) & (dist <= float(wm_color_thresh)) & (sat <= float(wm_sat_thresh))
    if bg_mask is not None:
        bg_roi = bg_mask[y0:h, x0:w]
        candidate_bg = candidate & bg_roi
        if np.any(candidate_bg):
            candidate = candidate_bg

    if not np.any(candidate):
        return None, None

    num_labels, labels = cv2.connectedComponents(candidate.astype(np.uint8), connectivity=8)
    best_label = None
    best_score = None

    for label in range(1, num_labels):
        ys, xs = np.where(labels == label)
        area = ys.size
        area_ratio = area / float(h * w)
        if area_ratio < wm_area_min_ratio or area_ratio > wm_area_max_ratio:
            continue
        x_min = xs.min() + x0
        x_max = xs.max() + x0
        y_min = ys.min() + y0
        y_max = ys.max() + y0
        br_dist = (w - 1 - x_max) + (h - 1 - y_max)
        score = (br_dist, area)
        if best_score is None or score < best_score:
            best_score = score
            best_label = label

    if best_label is None:
        for label in range(1, num_labels):
            ys, xs = np.where(labels == label)
            area = ys.size
            area_ratio = area / float(h * w)
            if area_ratio > 0.1:
                continue
            x_max = xs.max() + x0
            y_max = ys.max() + y0
            br_dist = (w - 1 - x_max) + (h - 1 - y_max)
            score = (br_dist, area)
            if best_score is None or score < best_score:
                best_score = score
                best_label = label

    if best_label is None:
        return None, None

    mask = np.zeros((h, w), dtype=bool)
    mask_roi = labels == best_label
    ys, xs = np.where(mask_roi)
    mask[ys + y0, xs + x0] = True

    x_min = xs.min() + x0
    x_max = xs.max() + x0
    y_min = ys.min() + y0
    y_max = ys.max() + y0
    rect = [int(x_min), int(y_min), int(x_max - x_min + 1), int(y_max - y_min + 1)]
    return mask, rect


def _apply_transparent_rect(rgba, rect):
    if rect is None:
        return rgba
    x, y, w, h = rect
    h_img, w_img = rgba.shape[:2]
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(w_img, x + w)
    y1 = min(h_img, y + h)
    if x1 <= x0 or y1 <= y0:
        return rgba
    rgba[y0:y1, x0:x1, 3] = 0
    return rgba


def process_image(
    path,
    out_dir,
    white_thresh,
    outline_px,
    wm_detect_thresh,
    wm_color_thresh,
    wm_sat_thresh,
    wm_dilate,
    wm_rect,
):
    img = Image.open(path).convert("RGB")
    rgb = np.array(img)
    bg_mask = _background_mask_from_white(rgb, white_thresh)
    if wm_rect:
        rect = wm_rect
    else:
        _, rect = _detect_watermark_mask(
            rgb,
            wm_detect_thresh=wm_detect_thresh,
            wm_color_thresh=wm_color_thresh,
            wm_sat_thresh=wm_sat_thresh,
            bg_mask=bg_mask,
        )
    rgba = _bg_transparent_with_outline(rgb, bg_mask, outline_px)
    rgba = _apply_transparent_rect(rgba, rect)
    out_path = out_dir / (path.stem + ".png")
    Image.fromarray(rgba, mode="RGBA").save(out_path)
    return out_path


def process_video(
    path,
    out_dir,
    white_thresh,
    outline_px,
    wm_detect_thresh,
    wm_pad,
    wm_rect,
    wm_color_thresh,
    wm_sat_thresh,
    wm_dilate,
):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open video: {path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or math.isnan(fps) or fps <= 0:
        fps = 30.0

    temp_dir = Path(tempfile.mkdtemp(prefix=f"{path.stem}_frames_"))
    try:
        ret, frame = cap.read()
        if not ret:
            raise RuntimeError(f"Failed to read first frame: {path}")

        rgb0 = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        bg_mask0 = _background_mask_from_white(rgb0, white_thresh)
        if wm_rect:
            rect = wm_rect
            if wm_pad:
                rect = [rect[0] - wm_pad, rect[1] - wm_pad, rect[2] + 2 * wm_pad, rect[3] + 2 * wm_pad]
        else:
            _, rect = _detect_watermark_mask(
                rgb0,
                wm_detect_thresh=wm_detect_thresh,
                wm_color_thresh=wm_color_thresh,
                wm_sat_thresh=wm_sat_thresh,
                bg_mask=bg_mask0,
            )

        frame_idx = 0
        while ret:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            bg_mask = _background_mask_from_white(rgb, white_thresh)
            rgba = _bg_transparent_with_outline(rgb, bg_mask, outline_px)
            rgba = _apply_transparent_rect(rgba, rect)
            out_frame = temp_dir / f"{frame_idx:06d}.png"
            cv2.imwrite(str(out_frame), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
            frame_idx += 1
            ret, frame = cap.read()

        cap.release()

        out_path = out_dir / f"{path.stem}_transparent.mov"
        ffmpeg_cmd = [
            "ffmpeg",
            "-y",
            "-r",
            f"{fps}",
            "-i",
            str(temp_dir / "%06d.png"),
            "-i",
            str(path),
            "-map",
            "0:v",
            "-map",
            "1:a?",
            "-c:v",
            "prores_ks",
            "-profile:v",
            "4444",
            "-pix_fmt",
            "yuva444p10le",
            "-c:a",
            "copy",
            str(out_path),
        ]
        subprocess.run(ffmpeg_cmd, check=True)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return out_path, rect


def parse_rect(value):
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("wm-rect must be x,y,w,h")
    return [int(p.strip()) for p in parts]


def main():
    parser = argparse.ArgumentParser(description="Make white background transparent, add white outline, and mask watermark.")
    parser.add_argument("--input-dir", default=".", help="Input folder with images/videos")
    parser.add_argument("--output-dir", default="output_transparent", help="Output folder")
    parser.add_argument("--white-thresh", type=int, default=18, help="White threshold (lower = stricter)")
    parser.add_argument("--outline", type=int, default=3, help="White outline size (px)")
    parser.add_argument("--white-soft", type=int, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--wm-detect-thresh", type=int, default=25, help="Non-white threshold for watermark detect")
    parser.add_argument("--wm-pad", type=int, default=4, help="Padding around detected watermark rect")
    parser.add_argument("--wm-color-thresh", type=int, default=220, help="Watermark max distance from white")
    parser.add_argument("--wm-sat-thresh", type=int, default=60, help="Watermark max saturation")
    parser.add_argument("--wm-dilate", type=int, default=3, help="Mask dilation for watermark removal")
    parser.add_argument("--wm-rect", type=parse_rect, default=None, help="Override watermark rect x,y,w,h")
    args = parser.parse_args()
    if args.white_soft is not None:
        args.outline = args.white_soft

    in_dir = Path(args.input_dir).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    images = [p for p in in_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS]
    videos = [p for p in in_dir.iterdir() if p.suffix.lower() in VIDEO_EXTS]

    if not images and not videos:
        print("No images or videos found.")
        return

    for img in images:
        out = process_image(
            img,
            out_dir,
            args.white_thresh,
            args.outline,
            args.wm_detect_thresh,
            args.wm_color_thresh,
            args.wm_sat_thresh,
            args.wm_dilate,
            args.wm_rect,
        )
        print(f"Image -> {out.name}")

    for vid in videos:
        out, rect = process_video(
            vid,
            out_dir,
            args.white_thresh,
            args.outline,
            args.wm_detect_thresh,
            args.wm_pad,
            args.wm_rect,
            args.wm_color_thresh,
            args.wm_sat_thresh,
            args.wm_dilate,
        )
        rect_info = f"{rect}" if rect else "None"
        print(f"Video -> {out.name} | watermark rect: {rect_info}")


if __name__ == "__main__":
    main()
