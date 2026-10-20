"""Errors crossing the acquisition and validation boundaries."""


class AcquisitionError(RuntimeError):
    """A catalog, signing, network, or raster acquisition failure."""


class NoScenesError(AcquisitionError):
    """The request has no usable scenes."""


class AssetValidationError(AcquisitionError):
    """An acquired asset cannot safely enter the analysis graph."""
