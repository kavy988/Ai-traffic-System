# ML control and data interface

Signal Studio is a synthetic browser simulation. Its **Adaptive rules baseline** and **Fixed timing baseline** are built-in heuristics, not trained models. The **Queue-aware AI baseline** is also hand-written control logic; it is labeled AI for the project interface but is not machine learning and has no training results.

## Controller choices and safety bounds

The queue-aware baseline estimates pressure from each approach's street queue and pedestrian count, adjusted by the approach's available speed factor. It proposes a green duration within the bounds provided for that decision. The simulator clamps the action to those bounds and retains its yellow/all-red transitions and 30-second red-wait limit. The controller cannot select a conflicting phase or disable those protections.

`window.signalStudio.engine` is the simulator handle. `getObservation()` returns time, demand, per-street counts and queue totals, pedestrians, road restrictions and surface conditions, signals, and network metrics. When the simulator asks a controller to act, it adds:

```js
observation.decision
// { nodeId, streetId, reverse, minGreen, maxGreen }
```

The current observation reports per-street queues, not direction-specific queues. Green actions are planned ahead of the actual green interval. Logged transitions retain the observation used for the proposal and sample the next observation when that approach finishes its green interval.

## Register an external model

The external adapter is synchronous. It receives a copy of the simulator observation and must return an object with `holdSeconds`:

```js
window.signalStudio.registerMLModel((observation) => {
  const { minGreen, maxGreen } = observation.decision;
  const estimate = 18; // Replace with your model's prediction.
  return { holdSeconds: Math.max(minGreen, Math.min(maxGreen, estimate)) };
});
```

Registering the model activates it. The same API is available as `window.signalStudio.connectController(fn)`. Choose **External ML model** in the strategy selector after registration, or use `window.signalStudio.setControllerMode('external')`. To disconnect and return to Adaptive rules, call:

```js
window.signalStudio.connectController(null);
```

Do not make blocking network requests inside the controller callback. For a Python-hosted model, request predictions asynchronously elsewhere, cache the latest response, and return a valid cached action synchronously. If a model throws or returns an unusable value, the adapter proposes the current legal maximum as a fallback; the simulator still applies its own bounds.

## Logged transitions and reward

The app records each decision as an observation, a phase/approach action, a next observation, reward terms, and episode metadata. The JSON created by **Export run data** contains the simulator snapshot plus `mlDataset` and `mlEpisodeSummary`. `window.signalStudio.ml.exportDataset()` returns the learning-data portion directly. A mid-run export also includes pending actions separately; those actions have no reward until their green interval is observed.

The baseline reward is intentionally visible in the export schema:

```text
reward = -0.01 × newly accumulated waiting vehicle-seconds
         -0.05 × network queued vehicle-seconds
         +2.00 × completed journeys during the green interval
```

The waiting penalty uses active vehicle `runWaitTime` plus the simulator's visible-run `completedWaitSeconds` metric. It does not use the display rolling `avgWait`. Older engine snapshots fall back to `waitTime` for active vehicles and `completed` × `avgWaitOverall` for finished trips. This excludes warm-up delay from the reward. Queue exposure is integrated from UI snapshots while an approach is green; it is network-wide, and concurrent junction actions can have overlapping rewards. Per-street queue totals also combine directions. These are useful shaping labels for early experiments, not a calibrated transportation objective or independent causal score for a single signal.

Each transition records the proposed and bounded green duration, legal min/max, whether the proposal was clamped, the approach identity, the observed green interval, next-state network metrics, queue, wait measures, and completion delta. The visible **AVG. WAIT** metric is the mean stopped delay from the latest 30 completed trips; it includes stops at signals, traffic queues, and breakdowns, not just red lights. It has no time-based cutoff and updates only when a trip completes; `avgWaitLastCompletionAgeSeconds` exposes the age of the newest retained sample. `avgWaitSampleCount` gives the retained sample count and `avgWaitWindowTrips` is 30. When no vehicles are active, `avgWait` is null so the interface suppresses a stale headline mean; the sample count and latest completion age remain available for context. Because the mean only includes finished trips, it can look better during congestion while long-delayed vehicles are still active. The episode readout separately reports accumulated in-network wait and current queued vehicle count; use those alongside the completed-trip mean for model scoring.

Episodes begin on page load and after Reset. The export identifies controller changes within an episode and stores the latest 1,500 transitions per episode; older excess transitions are counted as dropped. The latest 20 episodes are retained in browser memory. Reloading the page clears this data.

## Comparing controllers fairly

For each comparison, reset to the same seed, then keep demand, road closures, breakdowns, bike-only restrictions, road surfaces, and simulated duration the same. Export each run separately. Compare the completed-trip rolling wait with its sample count, all-run completed wait, completed journeys, current queue, active vehicles, throughput, and total arrivals. The queue and active-trip wait expose unfinished delay that a completed-trip mean can omit.

Reset reproduces the seeded opening state. It does not guarantee a perfectly paired stream of arrivals across different controllers: changes to routing and simulation events can consume the simulator's random stream differently. The page does not run a multi-controller batch comparison or claim statistical significance. Use repeated seeds and report this limitation when evaluating results.

## Current limits

This environment has no real traffic feeds, learned parameters, Python service, or model training pipeline. The network caps at 180 active vehicles; at capacity, new arrivals pause at the boundary and are not represented as an upstream queue. The export is a browser-generated trajectory dataset with documented approximations and transition timing; it needs inspection and validation before use for training. It is a portfolio-scale synthetic simulator, not evidence of real-world signal performance.
