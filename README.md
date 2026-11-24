# Signal Studio 

An interactive traffic simulation website made with HTML, CSS, and JavaScript.
This launchable working copy is the `traffic system` folder.

## Open it in VS Code

1. In VS Code, choose **File → Open Folder**.
2. Open the entire **traffic system** folder.
3. Right-click **index.html** and choose **Open with Live Server**, or click **Go Live** at the bottom of VS Code.
4. Keep the VS Code window open while using the website. Save any code changes and Live Server refreshes the page.

If Live Server is missing, install the VS Code extension **Live Server** by Ritwick Dey. No npm installation, domain, account, or hosting is required. This is a local website. Nothing is published.

You can also open index.html directly in a browser; Live Server is recommended when editing. All assets and scripts are included locally.

## Try the website

- Use Pause / Resume, the speed selector, or Reset below the map. At **1×**, one simulation second is one real second while the browser tab is visible. The selector also offers 2×, 4×, and 8×. Pausing or switching away from the tab pauses progression.
- Hover or tap a roadside signal to see its current colour and remaining seconds.
- Select a vehicle marker, search by plate, or choose **Car**, **Bike**, **Pedestrians**, or **Crane** in the tracker below the map. Pedestrian tracking follows the selected group through its crossing. Enable **Counts** to see each street's vehicle and queue totals.
- When a closure changes a vehicle's planned route, its inspector shows where the route split, the detour it will take, and the original plan with the closed road crossed out.
- Drag the map to pan. Use + / − to zoom and the fit button to return to the full network. On small screens, zoom in for readable street IDs.
- Cranes arrive automatically for roadwork. You can also select a street in **Street Conditions**, choose **Cranes**, and select **Dispatch cranes** to add one manually. Each crane is assigned a work site within its first two streets and continues to a network exit after work.
- Follow the scheduled closure and work time in **Street Conditions** or track the crane in the regular vehicle inspector. The work street closes to newcomers and lets existing traffic clear. The darker part of the road shows how much the crane has covered. Work ends after at most 30 simulated seconds and the crane resumes its trip. If traffic or a signal prevents it from covering the full road within that time, the work ends incomplete. A manual closure remains active until you clear it.
- Pedestrians arrive automatically in small groups at marked crossings. Select a crossing on the map or in **Add Activity** to request an additional group. People wait at the curb and cross during the dedicated **WALK** phase, when the junction stops vehicle traffic. People arriving during **WALK** wait for the next eligible phase.
- In Scenarios, choose a street and apply Clear, Wet, or Snow. Each surface change affects only that street, so you can give different roads different conditions. Wet roads slow traffic; snow slows it further. Bike-only streets show a highlighted lane and bicycle marking.
- Simulated time of day appears beside the vehicle plate search. Switch on **Daily demand** in Scenarios to see the same clock with the effective demand. Enter a 24-hour time and choose **Set time** to update both clocks.
- Change incoming traffic demand and watch the queue counts and network chart respond. **Heavy** and the slider's highest setting both use 3.0× demand. The summary at the top shows the active scenario and the most recent traffic change.
- Compare the Adaptive rules, Fixed timing, and Queue-aware AI baseline controllers. The queue-aware baseline is hand-written control logic, not a trained model. Reset the network to repeat the same seeded starting conditions.
- In **Insights → Run comparison**, test the fixed, adaptive, and queue-aware strategies at two demand levels across three seeds. The comparison also scores a connected model. It runs separately from the live network.
- Register a future synchronous controller through `window.signalStudio.registerMLModel(fn)` in the browser console. See [MODEL_INTEGRATION.md](./docs/MODEL_INTEGRATION.md) for the action contract and limits.
- Export the current run as JSON. The file includes the visible simulator snapshot, per-approach observations/actions/rewards, episode metrics, and any strategy comparison report.

## What is implemented

The 50-street map includes two-way connections at S48 in the north, off S16, and S50 in the south, off the west end of S42. Each can start and finish trips. S47 continues the original S16 alignment to the east. The one-way S49 flyover connects S14 to S42 and crosses above S17 and S40. S9 and the S31–S32 bend are distinct approaches with their own stop lines. Incoming trips use congestion and recent street usage to spread traffic across the network.

The map interpolates vehicle motion between simulation updates. Random breakdowns temporarily stop simulated cars and show a countdown on the map and in Street Conditions. A manual breakdown remains until you clear its switch. Traffic in the affected direction queues and passes the obstacle, while traffic in the opposing lane follows its normal rules. Vehicles queued behind a breakdown pull away gradually after clearance. Wet and snowy surfaces affect the selected street. A closure prevents new entries while vehicles already on the street continue out. A bike-only restriction admits bikes and keeps new cars and cranes out.

**Waiting now** counts vehicles currently stopped and shows how long, on average, those vehicles have been stopped in their present queues. **Average trip wait** is the mean total stopped delay of the latest 30 completed trips. It updates as trips finish, so it can keep rising after the current queue starts to clear. `avgWaitLatestSampleAgeSeconds` reports the age of the latest completion. See [Scenario test results](./docs/SCENARIO_TEST_RESULTS.md) for the 20-minute runs at 8×.

The browser simulates eight minutes of arrivals before the visible clock starts at 0:00. Completed trips from that warmup populate the rolling average on the first screen, and vehicles keep their full trip wait through the visible clock rebase. The rolling sample retains the 30 latest completions without a time cutoff; while traffic is active, its mean changes only when a trip completes. The latest completion age makes sample freshness visible. The display mean is suppressed when no vehicles are active. The map opens at 8:30 AM with the steady arrival profile. Typical (1×), Busy (2×), and Heavy (3×) are calibrated demand settings. The demand panel shows the actual number of entry requests per simulated minute. Turn on **Daily demand** under **Scenarios → Traffic demand** to vary arrivals by simulated time of day. Set the start time and watch the live clock and effective demand. The profile ranges from 0.35× overnight to 1.35× at the morning and evening peaks, and the demand slider scales it. The same profile is available through `engine.setDemandProfile('daily', '08:30')`. Reset preserves the selected profile and start time. Simulation updates use fixed 0.25-second steps, so 4× and 8× playback produce the same results at the same simulated time. Typical demand is calibrated to the network's discharge rate. The controllers use **rules**, not a trained ML/DL model. The queue-aware AI baseline is a hand-written heuristic; the website exports transition records and exposes an adapter for your own synchronous model. See [MODEL_INTEGRATION.md](./docs/MODEL_INTEGRATION.md).

## Files you can edit

| File | Purpose |
| --- | --- |
| index.html | Page text, sections, and controls |
| css/styles.css | Website layout, typography, colours, responsive styling |
| css/map.css | Map roads, vehicle icons, signal styles, labels |
| js/map-data.js | Street geometry, intersections, blocks |
| js/signal-layout.js | Roadside signal positions and matching vehicle stop positions |
| js/map.js | Map drawing, animated vehicle markers and selection, route highlights, pan/zoom |
| js/simulation.js | Vehicle routes, arrivals, queues, signals, traffic rules |
| js/app.js | Connects the controls, map, and simulation |
| js/ml-control.js | Queue-aware baseline, external model adapter, transition logging, rewards, and episode export |
| js/evaluation.js | Runs strategy comparisons using paired seeds and arrival requests |
| assets/ | Included light/dark map edge textures |
| docs/ | Model interface and scenario test report |
| scripts/ | Dataset generation tools |
| data/s2/ | Generated CSV splits, settings, and dataset ZIP |
| tests/ | Simulation checks |

The older traffic-signal-studio folder is a separate earlier prototype. This folder is the full revised website. Edit the source files listed above; there is no generated dist folder or build step.

For headless runs, pass `{ seed: 42, realisticTraffic: true, autoPedestrians: true, autoBreakdowns: true, autoCranes: true }` to `TrafficSim.create` to reproduce the site's boundary demand, junction behavior, and automatic events.

Run `node tests/crane-roadworks.cjs` to compare matched 10-minute simulations at 8×, with and without crane dispatches. It reports vehicle queues, completed car and motorbike trips, work durations, and detours.

## Simulation scope

This synthetic simulator uses simplified traffic and crossing rules. The latest-30-trip mean includes stopped delay at signals, traffic queues, and breakdowns. Unfinished wait is shown separately. At 200 active vehicles, the performance limit defers new admissions. The browser simulation holds pending arrivals at each entry point up to 60 requests and counts overflow separately. The entry counts and in-network queues measure different parts of the same traffic demand. Recent completed journeys and chart history are bounded. Reloading starts a fresh run. Use Export run data to save results.

## Generate the S2 dataset

Run `python3 scripts/generate_s2_dataset.py` from the project folder. The Python script calls a Node adapter to sample the simulator, then writes train, validation, and test CSVs and `s2_dataset.zip` to `data/s2/`. This is a data export step.
