"""Run the Bench-3 historical experiment catalog through Bench-1 infrastructure."""
from pathlib import Path

from ..historical import main


if __name__ == "__main__":
    raise SystemExit(main(catalog=Path(__file__).with_name("catalog.json")))
