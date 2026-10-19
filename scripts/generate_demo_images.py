"""Generate deterministic satellite-like images for local SatQuery demos."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


SIZE = 512


def _terrain_base() -> np.ndarray:
    """Create a textured, mostly vegetated synthetic satellite scene."""

    rng = np.random.default_rng(26167)
    image = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    image[:] = (46, 116, 55)  # BGR green background

    # Low-frequency texture makes the flat synthetic scene look more like a
    # raster while keeping the dominant green/blue colors thresholdable.
    texture = rng.normal(0, 7, (SIZE, SIZE, 1))
    image = np.clip(image.astype(np.int16) + texture, 0, 255).astype(np.uint8)

    fields = [
        ([(20, 25), (180, 12), (215, 115), (55, 135)], (52, 137, 65)),
        ([(250, 20), (490, 35), (472, 145), (275, 125)], (42, 128, 58)),
        ([(20, 260), (135, 235), (178, 480), (28, 492)], (58, 145, 70)),
        ([(270, 370), (480, 300), (500, 492), (255, 495)], (48, 132, 60)),
    ]
    for points, color in fields:
        cv2.fillPoly(image, [np.array(points, dtype=np.int32)], color)

    # Water is deliberately saturated blue so the feature tool detects it.
    water = np.array(
        [(75, 175), (105, 148), (160, 151), (203, 180), (190, 228),
         (142, 252), (90, 235), (61, 202)],
        dtype=np.int32,
    )
    cv2.fillPoly(image, [water], (220, 85, 30))
    cv2.ellipse(image, (395, 170), (57, 34), -18, 0, 360, (220, 85, 30), -1)

    # Roads and field boundaries.
    road = (105, 105, 105)
    cv2.line(image, (0, 320), (512, 250), road, 9, cv2.LINE_AA)
    cv2.line(image, (230, 0), (290, 512), road, 7, cv2.LINE_AA)
    cv2.line(image, (15, 430), (220, 315), (125, 125, 125), 4, cv2.LINE_AA)

    # Small existing structures.
    for x, y, width, height in [(300, 175, 25, 18), (338, 202, 18, 25), (415, 260, 30, 20)]:
        cv2.rectangle(image, (x, y), (x + width, y + height), (82, 82, 82), -1)
        cv2.rectangle(image, (x + 3, y + 3), (x + width - 3, y + 5), (170, 170, 170), -1)

    return image


def _make_change_pair() -> tuple[np.ndarray, np.ndarray]:
    before = _terrain_base()
    after = before.copy()

    # New development cluster: a clear changed region for bounding-box output.
    cv2.rectangle(after, (325, 315), (430, 390), (80, 80, 80), -1)
    for x in range(335, 425, 25):
        cv2.rectangle(after, (x, 325), (x + 15, 345), (175, 175, 175), -1)
        cv2.rectangle(after, (x, 360), (x + 15, 380), (145, 145, 145), -1)
    cv2.line(after, (300, 405), (450, 405), (92, 92, 92), 13, cv2.LINE_AA)

    # A small water extension represents a second, separate temporal change.
    cv2.ellipse(after, (180, 194), (34, 18), 12, 0, 360, (220, 85, 30), -1)
    return before, after


def _make_feature_scene() -> np.ndarray:
    image = _terrain_base()
    # Add a larger lake and a bright vegetation parcel to make percentages
    # obvious when the single-image tool is used from Streamlit.
    cv2.ellipse(image, (170, 370), (105, 65), -12, 0, 360, (220, 85, 30), -1)
    cv2.fillPoly(
        image,
        [np.array([(300, 35), (475, 65), (460, 150), (315, 135)], dtype=np.int32)],
        (35, 155, 65),
    )
    return image


def main() -> None:
    output_dir = Path(__file__).resolve().parents[1] / "demo" / "images"
    output_dir.mkdir(parents=True, exist_ok=True)
    before, after = _make_change_pair()
    feature_scene = _make_feature_scene()

    outputs = {
        "change_before.png": before,
        "change_after.png": after,
        "feature_scene.png": feature_scene,
    }
    for filename, image in outputs.items():
        path = output_dir / filename
        if not cv2.imwrite(str(path), image):
            raise RuntimeError(f"Could not write {path}")
        print(f"wrote {path.relative_to(output_dir.parents[1])}")


if __name__ == "__main__":
    main()
