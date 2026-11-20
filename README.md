# Signal Studio — ML lab v2.3

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
- Use **Street Conditions** beside the map to select a street, close it manually, add a breakdown, reserve it for motorbikes, or add vehicles. Choose **Cranes** and **Dispatch cranes** to send mobile cranes on one- or two-street trips. Each crane picks a work street along its route.
- Follow the scheduled closure and work time in **Street Conditions** or track the crane in the regular vehicle inspector. The work street closes to newcomers and lets existing traffic clear. The darker part of the road shows how much the crane has covered. The street reopens on completion unless a manual closure is also active.
- Pedestrians arrive automatically in small groups at marked crossings. Select a crossing on the map or in **Add Activity** to request an additional group. People wait at the curb and cross during the dedicated **WALK** phase, when the junction stops vehicle traffic. People arriving during **WALK** wait for the next eligible phase.
- In Scenarios, choose a street and apply Clear, Wet, or Snow. Each surface change affects only that street, so you can give different roads different conditions. Wet roads slow traffic; snow slows it further. Bike-only streets show a highlighted lane and bicycle marking.
- Simulated time of day appears beside the vehicle plate search. Switch on **Daily demand** in Scenarios to see the same clock with the effective demand. Enter a 24-hour time and choose **Set time** to update both clocks.
- Change incoming traffic demand and watch the queue counts and network chart respond. **Heavy** and the slider's highest setting both use 3.0× demand. The summary at the top shows the active scenario and the most recent traffic change.
- Compare the Adaptive rules, Fixed timing, and Queue-aware AI baseline controllers. The queue-aware baseline is hand-written control logic, not a trained model. Reset the network to repeat the same seeded starting conditions.
- Register a future synchronous controller through `window.signalStudio.registerMLModel(fn)` in the browser console. See [MODEL_INTEGRATION.md](./MODEL_INTEGRATION.md) for the action contract and limits.
- Export the current run as JSON. The file includes the visible simulator snapshot, per-approach observations/actions/rewards, and episode metrics for future training or evaluation.

## What is implemented

The 50-street map includes two-way connections at S48 in the north, off S16, and S50 in the south, off the west end of S42. Each can start and finish trips. S47 continues the original S16 alignment to the east. The one-way S49 flyover connects S14 to S42 and crosses above S17 and S40. S9 and the S31–S32 bend are distinct approaches with their own stop lines. Incoming trips use congestion and recent street usage to spread traffic across the network.

The map interpolates vehicle motion between simulation updates. A breakdown adds a stalled car on one lane and meters vehicles past the obstacle one at a time. Traffic in the opposing lane follows its normal rules. Vehicles queued behind the breakdown pull away gradually after clearance. Wet and snowy surfaces affect the selected street. A closure prevents new entries while vehicles already on the street continue out. A bike-only restriction admits bikes and keeps new cars and cranes out.

**Waiting now** counts vehicles currently stopped and shows how long, on average, those vehicles have been stopped in their present queues. **Average trip wait** is the mean total stopped delay of the latest 30 completed trips. It updates as trips finish, so it can keep rising after the current queue starts to clear. `avgWaitLatestSampleAgeSeconds` reports the age of the latest completion. See [Scenario test results](./SCENARIO_TEST_RESULTS.md) for the 20-minute runs at 8×.

The network silently runs a 10-minute baseline before the visible clock starts at 0:00. Its valid completed-trip samples populate the rolling average on the first screen, and vehicles keep their full trip wait through the visible clock rebase. The rolling sample retains the 30 latest completions without a time cutoff; while traffic is active, its mean changes only when a trip completes. The latest completion age makes sample freshness visible. The display mean is suppressed when no vehicles are active. The default arrival profile is steady. Turn on **Daily demand** under **Scenarios → Traffic demand** to vary arrivals by simulated time of day. Set the start time and watch the live clock and effective demand. The profile ranges from 0.35× overnight to 1.35× at the morning and evening peaks, and the demand slider scales it. The same profile is available through `engine.setDemandProfile('daily', '07:00')`. Reset preserves the selected profile and start time. Simulation updates use fixed 0.25-second steps, so 4× and 8× playback produce the same results at the same simulated time. Typical demand is calibrated to the network's discharge rate. The controllers use **rules**, not a trained ML/DL model. The queue-aware AI baseline is a hand-written heuristic; the website exports transition records and exposes an adapter for your own synchronous model. See [MODEL_INTEGRATION.md](./MODEL_INTEGRATION.md).

## Files you can edit

| File | Purpose |
| --- | --- |
| index.html | Page text, sections, and controls |
| styles.css | Website layout, typography, colours, responsive styling |
| map.css | Map roads, vehicle icons, signal styles, labels |
| map-data.js | Street geometry, intersections, blocks |
| signal-layout.js | Roadside signal positions and matching vehicle stop positions |
| map.js | Map drawing, animated vehicle markers and selection, route highlights, pan/zoom |
| simulation.js | Vehicle routes, arrivals, queues, signals, traffic rules |
| app.js | Connects the controls, map, and simulation |
| ml-control.js | Queue-aware baseline, external model adapter, transition logging, rewards, and episode export |
| assets/ | Included light/dark map edge textures |

The older traffic-signal-studio folder is a separate earlier prototype. This folder is the full revised website. Edit the source files listed above; there is no generated dist folder or build step.

For headless runs, pass `{ seed: 42, autoPedestrians: true }` to `TrafficSim.create` to reproduce the site's pedestrian arrivals.

Run `node tests/crane-roadworks.cjs` to compare matched 10-minute simulations at 8×, with and without crane dispatches. It reports vehicle queues, completed car and motorbike trips, work durations, and detours.

## Simulation scope

This is a synthetic portfolio simulator with simplified traffic and crossing rules. Counts represent simulated vehicles, not camera detections or real traffic data. The latest-30-trip mean includes stopped delay at signals, traffic queues, and breakdowns; unfinished trips are shown separately, because long-delayed vehicles cannot appear in a completed-trip average until they finish. The simulator caps the network at 180 active vehicles for performance; when it is full, new arrivals pause at the network boundary instead of forming a modeled upstream queue, so overload beyond that cap is outside this prototype's scope. Recent completed journeys and chart history are also bounded to keep the page responsive. Reloading the website starts a fresh run; theme preference is saved when the browser allows local storage. Use Export run to save results.
