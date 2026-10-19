# Demo images

These deterministic synthetic satellite-like images are safe to use offline with the API or Streamlit frontend.

## Change detection

Use these two files with the query `What changed between these dates?`:

- Earlier image: `demo/images/change_before.png`
- Later image: `demo/images/change_after.png`

The later image contains a new development cluster, an expanded road, and a small water extension. The change tool should return multiple changed regions and pixel-space bounding boxes.

## Feature extraction

Use `demo/images/feature_scene.png` with either:

- `Highlight water bodies`
- `How much vegetation is visible?`

The image contains saturated blue water regions and green vegetation regions that are intentionally compatible with the HSV thresholds in `satquery/tools.py`.

## Regenerate

From the repository root:

```bash
PYTHONPATH=.deps:. python3.11 scripts/generate_demo_images.py
```

The generator uses a fixed seed, so the outputs are reproducible and do not require downloads or external services.
