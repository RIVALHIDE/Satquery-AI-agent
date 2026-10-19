import numpy as np
import pytest

from satquery.models import Intent
from satquery.router import KeywordIntentClassifier, OrchestratorRouterAgent


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("What changed between these dates?", Intent.CHANGE_DETECTION),
        ("Compare the two satellite images", Intent.CHANGE_DETECTION),
        ("Highlight water bodies", Intent.FEATURE_EXTRACTION),
        ("How much vegetation is visible?", Intent.FEATURE_EXTRACTION),
        ("Tell me a satellite fact", Intent.UNKNOWN),
    ],
)
def test_keyword_classifier_routes_supported_intents(query, expected):
    assert KeywordIntentClassifier().classify(query) is expected


class MockIntentClassifier:
    def __init__(self, intent):
        self.intent = intent

    def classify(self, query):
        return self.intent


def test_router_uses_mock_intent_classifier_for_feature_tool():
    image = np.zeros((12, 12, 3), dtype=np.uint8)
    agent = OrchestratorRouterAgent(
        classifier=MockIntentClassifier(Intent.FEATURE_EXTRACTION)
    )

    response = agent.run("arbitrary mocked query", image=image)

    assert response.status == "ok"
    assert response.intent is Intent.FEATURE_EXTRACTION
    assert response.route == "feature_extraction"
    assert response.result is not None
    assert response.result.tool == "feature_extraction"


def test_change_route_reports_missing_image_pair():
    response = OrchestratorRouterAgent().run("What changed between these dates?")

    assert response.status == "error"
    assert response.intent is Intent.CHANGE_DETECTION
    assert response.error == "change detection requires both before and after images"


def test_unknown_query_is_not_sent_to_a_tool():
    response = OrchestratorRouterAgent().run("Give me a joke")

    assert response.status == "error"
    assert response.route == "unknown"
    assert response.result is None
