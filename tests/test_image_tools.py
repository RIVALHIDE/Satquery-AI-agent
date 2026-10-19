import numpy as np
import pytest

from satquery.tools import BiTemporalChangeDetectionTool, FeatureExtractionTool


def test_change_detection_finds_changed_bounding_box():
    before = np.zeros((100, 100, 3), dtype=np.uint8)
    after = before.copy()
    after[20:60, 30:70] = (255, 255, 255)

    result = BiTemporalChangeDetectionTool().analyze(before, after)

    assert result.metrics["changed_area_percentage"] == pytest.approx(16.0)
    assert result.metrics["region_count"] == 1
    assert result.bounding_boxes[0].model_dump() == {
        "x": 30,
        "y": 20,
        "width": 40,
        "height": 40,
        "area": 1600,
    }
    assert "Detected 16.00% structural surface shift" in result.summary


def test_change_detection_returns_zero_for_identical_images():
    image = np.full((20, 20, 3), 80, dtype=np.uint8)

    result = BiTemporalChangeDetectionTool().analyze(image, image.copy())

    assert result.metrics["changed_area_percentage"] == 0
    assert result.bounding_boxes == []


def test_feature_extraction_estimates_blue_and_green_coverage():
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    image[:50, :50] = (255, 0, 0)  # BGR blue -> water mask
    image[50:, 50:] = (0, 255, 0)  # BGR green -> vegetation mask

    result = FeatureExtractionTool().analyze(image)

    assert result.metrics["water_coverage_percentage"] == pytest.approx(25.0)
    assert result.metrics["vegetation_coverage_percentage"] == pytest.approx(25.0)
    assert "Water bodies cover 25.00%" in result.summary


def test_change_detection_rejects_different_dimensions():
    with pytest.raises(ValueError, match="same dimensions"):
        BiTemporalChangeDetectionTool().analyze(
            np.zeros((10, 10, 3), dtype=np.uint8),
            np.zeros((11, 10, 3), dtype=np.uint8),
        )
