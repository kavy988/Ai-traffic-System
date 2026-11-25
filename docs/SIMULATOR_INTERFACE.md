# Simulator interface for the Python environment

This is the simulator-side contract. It supplies measurements and executes commands.
It contains **no Gymnasium class, policy/model, reward formula, episode limit, training
loop, feature scaling, or train/test split**. Those belong to the Python work.

## Browser access

The existing website still starts with adaptive rules. In the browser console:

```js
window.signalStudio.simulator.metadata()
window.signalStudio.simulator.observe()
window.signalStudio.simulator.measurements()
```

`observe()` returns sensor-style information. `measurements()` returns separate
evaluation ground truth. `read()` returns both under `observation` and `measurements`.
Reading does not move the simulation. The older `engine.getObservation()` and
`ml-control.js` interface remain available for existing rule controllers; the new
Python environment should use this documented sensor interface instead.

## Observations

`observation.junctions` contains every controlled junction, in stable `nodeId` order.
`metadata().actionNodeIds` gives the matching order for an action vector.

Each junction contains:

| Field | Contents |
| --- | --- |
| `nodeId`, `neighbourNodeIds` | Public map topology; neighbours are reachable through road connections without passing another controlled junction |
| `incoming` | Direction-specific detection areas ending at each vehicle stop line |
| `outgoing` | Direction-specific detection areas starting on roads leaving the junction |
| `signalControl` | Current stage/phase, elapsed/remaining seconds, compatible phases, red ages, pending choice, legal green durations, and last applied action |
| `pedestrians` | Waiting/crossing counts, oldest waiting age, WALK status and remaining time |

Incoming and outgoing readings include detected count, traffic queue count, moving
vehicle count (`approachingVehicles`), mean speed, mean/oldest current traffic stop,
occupancy, visible buses and loading activity. Planned bus/school loading is excluded
from the traffic queue; vehicles queued behind them still count. Counts are separated
by `streetId` **and** `reverse`, never combined across directions.

`outgoing[].entrySpace` is the measured distance from the junction-side start of
the road to the rear of the nearest detected vehicle, capped at the exit detection
distance. It is not a guarantee that a vehicle may enter: closure, crossing, vehicle
size and gap checks are still enforced by the engine.

Detection uses vehicle centres inside the given area. Occupancy is the summed
vehicle footprint within that area, capped at one. The network detected count
deduplicates vehicles visible in multiple areas. The measurements assume ideal
detectors/tracking, without camera occlusion, sensor noise or communication delay.
Road restrictions/weather/incident flags assume known operational reports.

Default incoming detection distance is **100 simulation distance units** and exit
distance is **60**. These use the engine's distance scale, not surveyed real-world
metres; they are configurable through `detectors`. `detectionStart`/`detectionEnd`
are normalised progress measured in the vehicle's travel direction. Different
sensor distances require no model or engine rewrite.

No uncreated future vehicles, route destinations, generator seed or arrival
schedule is provided as a policy observation. Signal timing is known controller
state: `signalRemainingSeconds` is the current green/yellow remainder, or the
current scheduling estimate until green for a red approach. It may change.

`observation.time` is the exact simulated physics clock. Time-of-day is separately
available as `timeOfDaySeconds`. Choose/encode the Python observation space yourself;
the JavaScript interface does not select the final feature vector or normalise it.

## Actions

Select `engine.setMode('network')` before using network actions. Fixed/adaptive/custom
legacy modes continue to work separately. Supply one integer per junction:

```js
const api = window.signalStudio.simulator;
const ids = api.metadata().actionNodeIds;
window.signalStudio.engine.setMode('network');
api.applyActions(ids.map(() => 1)); // Example command: medium at every junction.
```

| Choice | Meaning |
| --- | --- |
| `0` | Short: minimum legal green duration |
| `1` | Medium: midpoint of the minimum and maximum |
| `2` | Long: maximum legal green duration |

The latest requested choice is held until changed. It is applied **when that
junction starts its next green phase**. It does not interrupt a current phase or
choose phase order. Multiple requests before the next green replace the pending
choice. Observations expose pending and last-applied choices so this delay is
visible to the Python environment. All vector entries are validated before any
are changed. Invalid actions return an error and leave the choices intact.

Durations are computed at application time using the pedestrian/maximum-red
constraints then in effect. New pedestrian requests may shorten a running green
through the existing safety rules. `lastAppliedAction.scheduledSeconds` records the
initial scheduled duration; `greenDurationSeconds` exposes any later shortening.
Yellow, all-red, compatible movements and WALK protection stay with the engine.
No model callback or automatic learning is installed by network mode. Its initial
pending choice is medium until commands are supplied.

`maxRedSeconds` remains a run-level setting (default 30), not an agent action.
A different limit such as 60 must be explicitly supplied when creating a run.

## Raw scoring measurements

`measurements.metrics` includes existing queues, waiting, throughput and entry
queue statistics, plus:

- `completedTravelSeconds`: cumulative full journey duration of trips completed
  since the visible run began, independent of the bounded completed-trip buffer.
- `avgCompletedTravelSeconds`: that total divided by completed trips, or null.
- `unfinishedTravelSeconds`: summed elapsed time of vehicles still in the network.

Journey duration is measured from vehicle creation/admission to network exit;
waiting outside the network is reported separately by `boundaryWaitSeconds` and
`entryQueues`. Initial vehicles retain their pre-zero warm-up journey age, so
full journey duration can include time before the visible run. Completions and
their cumulative counters reset at visible time zero. Account for this explicitly
when defining your reward and evaluation.

`completedJourneys` contains the most recent 100 trip records; cumulative metrics
are not limited to 100. `pedestrianTotals` contains per-crossing completed/waiting
counts and oldest current wait. No reward is calculated from these measurements.

## Headless JavaScript command bridge

Start a persistent Node process from the project root:

```sh
node scripts/simulator-bridge.cjs
```

Send one JSON object per line to standard input. Read one JSON response per line
from standard output. Optional `id` is echoed. No files or datasets are written.
This transport can be called from Python using a subprocess; it is not Gymnasium.

Example requests (send each on its own line):

```json
{"id":1,"command":"init","settings":{"seed":42,"mode":"network","maxRedSeconds":60,"demand":1,"detectors":{"approachDistance":100,"exitDistance":60}}}
{"id":2,"command":"actions","choices":[0,1,2,0,1,2,0,1]}
{"id":3,"command":"advance","seconds":5}
{"id":4,"command":"observe"}
{"id":5,"command":"reset","seed":7}
{"id":6,"command":"close"}
```

Build the action vector from returned `metadata.actionNodeIds`, not hardcoded
positions. `init`/`reset` return metadata and a reading. `observe`/`advance` return
a reading. `actions` acknowledges accepted choices without advancing time.
Errors return `ok:false` and `error`; malformed input does not terminate the process.

`init.settings` also supports `autoPedestrians`, `autoBuses`, `schoolTraffic`,
`autoBreakdowns`, `autoCranes` (all default true), `demandProfile`, `startTime`, and
`roads:[{"streetId":"S18","changes":{"closed":true},"surface":"wet"}]`.
Reset keeps the same seed unless another is provided, restores the original
init settings, and clears pending/applied actions. It does not load any model.
Warm-up uses the existing adaptive baseline before these scenario settings are
applied, consistently across controller modes.

Other commands: `mode` (`value`: adaptive/fixed/network), `demand` (`value`),
`profile` (`value`: steady/daily; optional `startTime`), `road` (`streetId`,
`changes`) and `surface` (`streetId`, `value`: clear/wet/snow).

`advance` accepts 0–3600 simulated seconds and splits requests into engine-sized
calls. Physics uses 0.25-second ticks; fractional leftovers accumulate. There is
no automatic stopping horizon or terminated/truncated flag: the Python environment
owns episode endings. Headless advancing runs as fast as computation allows;
the website's playback multiplier does not constrain it.

## Verification

```sh
node tests/simulator-interface.cjs
node tests/signal-red-limit.cjs
node tests/automatic-pedestrians.cjs
node tests/driving-behavior.cjs
```

These are deterministic simulator/transport tests, not agent training. The interface
tests exercise three seeds, 30/60-second red limits and short/long/mixed action
vectors over 20 simulated minutes at 8x-equivalent updates. Additional runs vary
demand, simultaneous closure/breakdown conditions, wet/snow surfaces and recovery.
