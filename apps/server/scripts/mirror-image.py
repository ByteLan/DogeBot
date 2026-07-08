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
    from PIL import Image
except Exception as exc:  # pragma: no cover - runtime dependency guard
    fail(f"failed to import pillow: {exc}. Please install pillow.")

if axis not in {"vertical", "horizontal"}:
    fail(f"unknown axis: {axis}")

if source_side not in {"start", "end"}:
    fail(f"unknown sourceSide: {source_side}")

try:
    image = Image.open(input_path).convert("RGBA")
except Exception as exc:
    fail(f"failed to load input image: {exc}")

width, height = image.size
result = image.copy()

if axis == "vertical":
    half_width = width // 2
    if source_side == "start":
      source = image.crop((0, 0, half_width, height))
      mirrored = source.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
      result.paste(mirrored, (width - half_width, 0))
    else:
      source = image.crop((width - half_width, 0, width, height))
      mirrored = source.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
      result.paste(mirrored, (0, 0))
else:
    half_height = height // 2
    if source_side == "start":
      source = image.crop((0, 0, width, half_height))
      mirrored = source.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
      result.paste(mirrored, (0, height - half_height))
    else:
      source = image.crop((0, height - half_height, width, height))
      mirrored = source.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
      result.paste(mirrored, (0, 0))

try:
    result.save(output_path, format="PNG")
except Exception as exc:
    fail(f"failed to save output image: {exc}")
