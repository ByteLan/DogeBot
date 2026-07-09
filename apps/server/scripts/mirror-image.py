import sys


def fail(message: str) -> None:
    sys.stderr.write(message + "\n")
    raise SystemExit(1)


if len(sys.argv) < 5:
    fail("usage: mirror-image.py <input> <output> <axis> <sourceSide>")

input_path = sys.argv[1]
output_path = sys.argv[2]
axis = sys.argv[3]
source_side = sys.argv[4]

try:
    from PIL import Image, ImageSequence
except Exception as exc:  # pragma: no cover - runtime dependency guard
    fail(f"failed to import pillow: {exc}. Please install pillow.")

if axis not in {"vertical", "horizontal"}:
    fail(f"unknown axis: {axis}")

if source_side not in {"start", "end"}:
    fail(f"unknown sourceSide: {source_side}")

try:
    image = Image.open(input_path)
except Exception as exc:
    fail(f"failed to load input image: {exc}")

def mirror_frame(frame: Image.Image) -> Image.Image:
    rgba = frame.convert("RGBA")
    width, height = rgba.size
    # Always start from a fresh transparent canvas for each frame, otherwise
    # transparent animated images may retain pixels from prior frames.
    result = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    result.alpha_composite(rgba)
    if axis == "vertical":
        half_width = width // 2
        if source_side == "start":
            source = rgba.crop((0, 0, half_width, height))
            mirrored = source.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            result.paste(mirrored, (width - half_width, 0))
        else:
            source = rgba.crop((width - half_width, 0, width, height))
            mirrored = source.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            result.paste(mirrored, (0, 0))
    else:
        half_height = height // 2
        if source_side == "start":
            source = rgba.crop((0, 0, width, half_height))
            mirrored = source.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            result.paste(mirrored, (0, height - half_height))
        else:
            source = rgba.crop((0, height - half_height, width, height))
            mirrored = source.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            result.paste(mirrored, (0, 0))
    return result


is_animated = bool(getattr(image, "is_animated", False) and getattr(image, "n_frames", 1) > 1)
output_ext = output_path.rsplit(".", 1)[-1].lower() if "." in output_path else "png"

try:
    if is_animated:
        frames = [mirror_frame(frame.copy()) for frame in ImageSequence.Iterator(image)]
        durations = []
        for frame in ImageSequence.Iterator(image):
            durations.append(frame.info.get("duration", image.info.get("duration", 100)))
        save_kwargs = {
            "save_all": True,
            "append_images": frames[1:],
            "loop": image.info.get("loop", 0),
            "duration": durations,
        }
        if output_ext == "gif":
            # Save every output frame as "restore to background" so transparent
            # animated images do not accumulate prior frame pixels as afterimages.
            save_kwargs["disposal"] = [2] * len(frames)
            save_kwargs["optimize"] = False
            frames[0].save(output_path, format="GIF", **save_kwargs)
        elif output_ext == "webp":
            save_kwargs["lossless"] = True
            save_kwargs["background"] = (0, 0, 0, 0)
            frames[0].save(output_path, format="WEBP", **save_kwargs)
        else:
            save_kwargs["disposal"] = [2] * len(frames)
            save_kwargs["optimize"] = False
            frames[0].save(output_path, format="GIF", **save_kwargs)
    else:
        result = mirror_frame(image)
        save_format = {
            "gif": "GIF",
            "webp": "WEBP",
            "jpg": "JPEG",
            "jpeg": "JPEG",
            "png": "PNG",
        }.get(output_ext, "PNG")
        if save_format == "JPEG":
            result = result.convert("RGB")
        result.save(output_path, format=save_format)
except Exception as exc:
    fail(f"failed to save output image: {exc}")
