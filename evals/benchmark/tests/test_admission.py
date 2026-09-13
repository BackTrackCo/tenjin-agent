from types import SimpleNamespace
import pytest
from evals.benchmark import admission


def test_budget_subtracts_setup_and_drains_both_producer_and_consumer():
    config = SimpleNamespace(arms=[{}, {"producer": {"executor": "same"}}], pins={"wall_clock_s": 1500})
    assert admission.seconds(config, 21600, 300) == 17100
    assert admission.seconds(config, 21600, 600) == 16800


def test_expired_budget_admits_nothing():
    config = SimpleNamespace(arms=[{}], pins={"wall_clock_s": 600})
    assert admission.seconds(config, 3600, 3000) == 0


@pytest.mark.parametrize("value", [-1, float("inf"), float("nan")])
def test_invalid_time_is_refused(value):
    with pytest.raises(ValueError):
        admission.seconds(SimpleNamespace(arms=[{}], pins={"wall_clock_s": 600}), value, 0)
