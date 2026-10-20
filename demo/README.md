# Demo images

These deterministic synthetic satellite-like images are retained as standalone computer-vision fixtures. The v2 API does not load them or return canned responses; production analysis acquires scenes through Planetary Computer.

## Change detection

Use these two files when manually exercising a local image-processing experiment:

- Earlier image: `demo/images/change_before.png`
- Later image: `demo/images/change_after.png`

The later image contains a new development cluster, an expanded road, and a small water extension.

## Feature extraction

Use `demo/images/feature_scene.png` with a standalone CV notebook or script:

- `Highlight water bodies`
- `How much vegetation is visible?`

The image contains saturated blue water regions and green vegetation regions for deterministic visual experiments.

## Regenerate

From the repository root:

```bash
PYTHONPATH=.deps:. python3.11 scripts/generate_demo_images.py
```

The generator uses a fixed seed, so the outputs are reproducible and do not require downloads or external services.
