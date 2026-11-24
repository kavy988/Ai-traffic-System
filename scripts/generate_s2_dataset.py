"""Generate independent simulator episodes and label each S2 sample 30 seconds ahead."""

import argparse
import csv
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


HERE = Path(__file__).resolve().parent
SPLIT_SEEDS = {"train": range(101, 113), "validation": range(201, 205), "test": range(301, 305)}
SCENARIOS = {
    "quiet": {"demand": 0.6, "startTime": None, "incidents": False},
    "typical": {"demand": 1, "startTime": None, "incidents": False},
    "morning_peak": {"demand": 1.5, "startTime": "08:30", "incidents": False},
    "incidents": {"demand": 1.5, "startTime": "08:30", "incidents": True},
}
INTERVAL = 5
HORIZON = 30
DURATION = 600


def run_episode(seed, settings):
    config = dict(settings, seed=seed, duration=DURATION, interval=INTERVAL)
    result = subprocess.run(
        ["node", str(HERE / "sample-s2.cjs"), json.dumps(config)],
        check=True, text=True, capture_output=True,
    )
    samples = [json.loads(line) for line in result.stdout.splitlines()]
    expected = list(range(0, DURATION + 1, INTERVAL))
    if [row["time_s"] for row in samples] != expected:
        raise ValueError(f"Unexpected sample times for seed {seed}")
    return {row["time_s"]: row for row in samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE.parent / "data" / "s2")
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    counts = {}
    for split, seeds in SPLIT_SEEDS.items():
        file = output / f"{split}.csv"
        count = 0
        with file.with_suffix(".tmp").open("w", newline="", encoding="utf-8") as stream:
            writer = None
            for seed in seeds:
                for scenario, settings in SCENARIOS.items():
                    samples = run_episode(seed, settings)
                    for time in range(0, DURATION - HORIZON + 1, INTERVAL):
                        row = {
                            "run_id": f"{scenario}-{seed}",
                            "seed": seed,
                            "scenario": scenario,
                            **samples[time],
                            "queue_in_30s": samples[time + HORIZON]["queue_now"],
                        }
                        if writer is None:
                            writer = csv.DictWriter(stream, fieldnames=list(row))
                            writer.writeheader()
                        writer.writerow(row)
                        count += 1
        file.with_suffix(".tmp").replace(file)
        counts[split] = count
        print(f"{file}: {count:,} rows", flush=True)

    manifest = {
        "target": "Number of stopped vehicles on S2 approaching k2, 30 simulated seconds later",
        "signal_strategy": "adaptive",
        "split_seeds": {split: list(seeds) for split, seeds in SPLIT_SEEDS.items()},
        "scenarios": SCENARIOS,
        "duration_seconds": DURATION,
        "sample_interval_seconds": INTERVAL,
        "forecast_horizon_seconds": HORIZON,
        "row_counts": counts,
    }
    (output / "dataset.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    archive = output / "s2_dataset.zip"
    with ZipFile(archive.with_suffix(".tmp"), "w", compression=ZIP_DEFLATED) as bundle:
        for name in ("train.csv", "validation.csv", "test.csv", "dataset.json"):
            bundle.write(output / name, arcname=name)
    archive.with_suffix(".tmp").replace(archive)
    print(f"{archive}: Colab upload bundle", flush=True)


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as error:
        if error.filename != "node":
            raise
        raise SystemExit("Node.js is needed to run the Signal Studio simulator. Install Node and rerun.") from error
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Simulator failed:\n{error.stderr}") from error
