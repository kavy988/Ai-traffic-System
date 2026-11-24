# Signal Studio 20-minute traffic tests

**397 independent runs passed with zero invariant failures.** The suite covers 19 network-wide runs, 350 street runs at Typical demand, and 28 street runs at true MAX demand. All scenarios ran for 20 simulated minutes at 8× playback, with one extra Typical baseline at 1× for comparison. The street tests then ran five additional minutes with the selected street restored. A separate demand recovery run continued for 20 additional simulated minutes.

The network starts from the same ten-minute warmup with seed 42 unless a different seed is listed. The runner checks vehicle continuity, direction, and restricted entry every 0.25 simulated seconds. Every five seconds it reconciles active vehicles, network and street queues, completions, wait averages, the active limit, and projected signal waits against engine snapshots. In the street matrix, additions at eight points exercise roads that receive little automatic traffic. Closed roads receive no manual additions. Cars are excluded from the manual schedule while bike-only is active. This report supersedes the earlier four-minute street tests.

## Demand controls and 20-minute checkpoints

Each cell gives **active vehicles / queued vehicles / last-30-trip wait in seconds / current stop mean in seconds / completed trips**. The trip average includes the stopped delay of the last 30 completed trips. The current stop mean measures how long vehicles still in the queue have been stopped in their current stop. The starting trip average uses warmup samples, while the displayed completed-trip counter starts at zero.

| Run | 0:00 | 5:00 | 10:00 | 15:00 | 20:00 |
| --- | --- | --- | --- | --- | --- |
| Steady baseline | 77 / 21 / 48.7 / 12.8 / 0 | 102 / 31 / 50 / 15.6 / 107 | 81 / 16 / 73.8 / 10.1 / 232 | 69 / 12 / 64.6 / 12.9 / 330 | 73 / 15 / 29.4 / 9.6 / 432 |
| Quiet preset | 77 / 21 / 48.7 / 12.8 / 0 | 7 / 2 / 55.3 / 19.1 / 70 | 0 / 0 / — / — / 77 | 0 / 0 / — / — / 77 | 0 / 0 / — / — / 77 |
| Typical preset | 77 / 21 / 48.7 / 12.8 / 0 | 102 / 31 / 50 / 15.6 / 107 | 81 / 16 / 73.8 / 10.1 / 232 | 69 / 12 / 64.6 / 12.9 / 330 | 73 / 15 / 29.4 / 9.6 / 432 |
| Intermediate demand slider | 77 / 21 / 48.7 / 12.8 / 0 | 132 / 30 / 59.3 / 10 / 109 | 116 / 31 / 72.6 / 6.3 / 277 | 128 / 41 / 78.3 / 10.5 / 418 | 135 / 39 / 86.7 / 14.5 / 558 |
| Heavy preset | 77 / 21 / 48.7 / 12.8 / 0 | 179 / 79 / 73.1 / 13.4 / 138 | 180 / 86 / 119.3 / 16.2 / 308 | 180 / 66 / 107.8 / 13.6 / 485 | 180 / 68 / 83 / 8.1 / 663 |
| MAX endpoint | 77 / 21 / 48.7 / 12.8 / 0 | 179 / 79 / 73.1 / 13.4 / 138 | 180 / 86 / 119.3 / 16.2 / 308 | 180 / 66 / 107.8 / 13.6 / 485 | 180 / 68 / 83 / 8.1 / 663 |
| MAX with S26 and S36 closed | 77 / 21 / 48.7 / 12.8 / 0 | 180 / 79 / 62.8 / 17.2 / 126 | 180 / 70 / 142.2 / 17.4 / 265 | 180 / 65 / 176.9 / 8.2 / 399 | 180 / 105 / 161.9 / 20.2 / 546 |

The Quiet preset sets demand to 0.0× and all 77 warmed vehicles completed by 10:00. Both wait fields became empty when their populations reached zero. Typical matches the untouched steady baseline. The intermediate slider test used 1.5×. Heavy and the MAX slider endpoint both set 3.0× and matched in the recorded traces. The 1× and 8× Typical baselines also matched. All 50 streets carried traffic during each five-minute window in the free-running Typical and MAX baselines for seeds 42, 7, and 109.

## What happened at MAX

| Seed | First reached 180 active | Time at 180 (s of 1,200) | Peak sampled queue | Queued at 20:00 | Completed at 20:00 | Last-30-trip wait at 20:00 (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 42 | 1:13.00 | 798.25 | 96 | 68 | 663 | 83 |
| 7 | 1:47.25 | 766.75 | 105 | 76 | 666 | 114 |
| 109 | 1:52.50 | 752.5 | 91 | 77 | 699 | 124.3 |

At 180 active vehicles, the simulator pauses new arrivals and rejects manual additions. MAX therefore tests the network under the simulator's admission ceiling. These queue measurements cover the vehicles already admitted to the map. For seed 42, 68 vehicles were stopped at 20:00. Their ongoing stops averaged 8.1 seconds, while the completed-trip card averaged 83 seconds. Both values describe the same snapshot and reflect different wait intervals.

### Return to Typical with streets open

| Time | Demand | Active | Queued | Last 30 trips (s) | Current stop mean (s) | Trips completed | Streets occupied |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20:00 | 3.0× | 180 | 68 | 83 | 8.1 | 663 | 43 |
| 21:00 | 1.0× | 171 | 73 | 116.8 | 10.8 | 692 | 45 |
| 25:00 | 1.0× | 103 | 28 | 105.1 | 8 | 837 | 39 |
| 30:00 | 1.0× | 84 | 20 | 139.9 | 10.9 | 965 | 34 |
| 35:00 | 1.0× | 63 | 18 | 51.8 | 14.2 | 1078 | 37 |
| 40:00 | 1.0× | 68 | 19 | 34.8 | 14 | 1181 | 34 |

The 3.0× run switched to 1.0× immediately after the 20:00 sample. The queue reached 28 at 25:00 and 19 at 40:00. The rolling trip mean rose to 139.9 seconds by 30:00 as delayed trips finished, then fell to 34.8 seconds by 40:00. The live queue changed sooner because it responds to vehicles still in the network.

### Close S26 and S36 at MAX

| Time | Demand | Active | Queued | Last 30 trips (s) | Current stop mean (s) | Trips completed | Streets occupied |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20:00 | 3.0× | 180 | 105 | 161.9 | 20.2 | 546 | 39 |
| 21:00 | 3.0× | 180 | 115 | 111.6 | 21.4 | 578 | 41 |
| 25:00 | 3.0× | 180 | 99 | 167.5 | 11.3 | 690 | 42 |

The two closures blocked all new entries throughout the 20-minute hold. The first empty samples were at 15 seconds for S26 and 70 seconds for S36. Both roads reopened immediately after 20:00 with demand held at MAX. New entries reached S26 70 seconds later and S36 268 seconds later. With both roads closed, the peak sampled queue was 114 and 546 trips completed by 20:00, compared with 96 and 663 on the open network.

## S48 and S50 boundary traffic

Counts are observed crossings at the north and south map boundaries. The closure and bike-only rows use Typical demand and show the condition on the listed link only. A vehicle already on a link when it closes can still exit. The reopening rows cover the five minutes following each independent closure.

| Run | S48 entered | S48 exited | S50 entered | S50 exited |
| --- | --- | --- | --- | --- |
| Steady baseline | 40 | 36 | 50 | 56 |
| MAX endpoint | 74 | 71 | 88 | 79 |
| MAX with S26 and S36 closed | 55 | 62 | 63 | 71 |
| Closed · each boundary tested independently | 0 | 1 | 0 | 0 |
| Reopened · each boundary tested independently | 13 | 8 | 6 | 3 |
| Bike only · each boundary tested independently | 6 | 19 | 7 | 26 |

## Manual additions and signal strategies

Each row is a fresh 20-minute run at Typical demand. The two Add vehicles runs each started with five manually added vehicles on S36. All five cars and all five bikes completed their respective runs. The external adapter was exercised with a deterministic 18-second proposal, which matched the fixed timing trace. The external selector requires an adapter to be registered. Pedestrian requests are available through the engine API.

| Run | 0:00 | 5:00 | 10:00 | 15:00 | 20:00 |
| --- | --- | --- | --- | --- | --- |
| Add cars | 82 / 21 / 48.7 / 12.8 / 0 | 71 / 19 / 46.3 / 9.4 / 101 | 62 / 10 / 49.1 / 10.4 / 208 | 59 / 9 / 40 / 6 / 299 | 57 / 12 / 33.3 / 11.4 / 393 |
| Add bikes | 82 / 21 / 48.7 / 12.8 / 0 | 83 / 16 / 48.1 / 9.8 / 101 | 69 / 15 / 57.5 / 9.2 / 220 | 81 / 15 / 60.8 / 14.8 / 308 | 66 / 14 / 33.4 / 7.6 / 428 |
| Adaptive rules | 77 / 21 / 48.7 / 12.8 / 0 | 102 / 34 / 50.1 / 14 / 107 | 80 / 18 / 73.7 / 9.2 / 233 | 72 / 17 / 49.3 / 17.3 / 342 | 58 / 17 / 42.8 / 10.8 / 444 |
| Fixed timing | 77 / 21 / 48.7 / 12.8 / 0 | 104 / 29 / 54.4 / 7.2 / 109 | 89 / 20 / 70 / 9.9 / 224 | 73 / 14 / 66.9 / 6.8 / 336 | 50 / 8 / 46.3 / 10.4 / 436 |
| Queue-aware rules | 77 / 21 / 48.7 / 12.8 / 0 | 102 / 34 / 51.7 / 11.2 / 106 | 84 / 26 / 65.7 / 10.5 / 224 | 77 / 19 / 58.9 / 9.5 / 331 | 65 / 18 / 46.2 / 10.9 / 444 |
| External integration test | 77 / 21 / 48.7 / 12.8 / 0 | 104 / 29 / 54.4 / 7.2 / 109 | 89 / 20 / 70 / 9.9 / 224 | 73 / 14 / 66.9 / 6.8 / 336 | 50 / 8 / 46.3 / 10.4 / 436 |

## Street controls at Typical demand

Each cell gives the **mean network queue / mean displayed trip wait in seconds** across the 50 independent runs for that control at that checkpoint. The recovery column is five minutes after each street was cleared, reopened, or returned to all traffic. The all-street detail below shows the local effect, which can move in a different direction from the network queue as traffic reroutes.

| Control | 0:00 | 5:00 | 10:00 | 15:00 | 20:00 | 25:00 recovery |
| --- | --- | --- | --- | --- | --- | --- |
| Clear | 21 / 48.7 | 18.5 / 44.5 | 16.4 / 48.2 | 17.9 / 45.3 | 17.5 / 45.3 | 13.8 / 49.3 |
| Closed | 21 / 48.7 | 18.5 / 50.2 | 14.3 / 49.8 | 16.8 / 45 | 14.5 / 45.8 | 13.6 / 43.6 |
| Breakdown | 21 / 48.7 | 23.2 / 49.1 | 17.2 / 64.2 | 19 / 54 | 18.1 / 47.2 | 15.9 / 49.8 |
| Bike only | 21 / 48.7 | 18.5 / 45.4 | 15 / 50.4 | 18.6 / 46.5 | 17.2 / 46.6 | 14.9 / 50.1 |
| Wet | 21 / 48.7 | 20 / 47 | 16.4 / 50.4 | 17.2 / 48.8 | 19.2 / 46.2 | 14.8 / 51.5 |
| Snow | 21 / 48.7 | 20 / 47.5 | 16.8 / 50.8 | 15.9 / 48.6 | 17.4 / 46.3 | 15.2 / 48.9 |
| Bike only + wet | 21 / 48.7 | 18.1 / 46.7 | 14.7 / 47.9 | 16.3 / 47.5 | 17.1 / 44.9 | 14.9 / 49.5 |

- **Closure.** No vehicle entered any of the 50 closed streets. All 50 streets emptied by 20:00 and carried traffic again during the five-minute reopening period. The latest observed reentry was 113.75 seconds after reopening.
- **Breakdown.** All 50 runs formed a forward-lane incident queue. The queue reached nine vehicles on S49. The opposite direction kept moving in every two-way case. Mean local queue rose on 44 streets compared with Clear. Thirty streets still had a breakdown cohort when cleared. Every cohort left its incident street within 90.5 seconds, with tracked first moves staggered where more than one vehicle was waiting.
- **Bike only and bike only + wet.** All 100 runs recorded bikes traversing the road, with no new car entries. Cars already on a restricted street could leave it. All dry cases and 49 wet cases saw cars return within five minutes of reopening.
- **Wet and snow.** The affected street's car speed factor was 0.78 in wet conditions and 0.56 in snow. On two-way streets both directions received the same surface factor. Only the selected street changed surface. Restoring Clear restored a factor of 1.0 on every affected street. S49 received no new entries in the five-minute period after snow cleared, although its surface and speed state both restored.

'
## Street controls at MAX demand

The suite repeated all seven street settings on S5, S18, S48, and S50 for 20 minutes each at 3.0×, then cleared the setting for five minutes while keeping MAX demand. Every cell gives **network queue / last-30-trip wait in seconds** at a checkpoint. Manual additions can be rejected when the network is full. The matches below start from the same seed and warmed state.

| Street and control | 0:00 | 5:00 | 10:00 | 15:00 | 20:00 | 25:00 recovery |
| --- | --- | --- | --- | --- | --- | --- |
| S5 · Clear | 21 / 48.7 | 73 / 82.6 | 68 / 114.6 | 64 / 120.4 | 75 / 105.2 | 76 / 119.8 |
| S5 · Closed | 21 / 48.7 | 90 / 77.7 | 68 / 145.9 | 78 / 167.4 | 92 / 153.4 | 100 / 146.2 |
| S5 · Breakdown | 21 / 48.7 | 69 / 67.7 | 63 / 121 | 44 / 129.7 | 80 / 151.3 | 75 / 100 |
| S5 · Bike only | 21 / 48.7 | 90 / 83.2 | 87 / 114.6 | 73 / 138.1 | 83 / 171.8 | 81 / 137.3 |
| S5 · Wet | 21 / 48.7 | 85 / 96.6 | 70 / 142.7 | 63 / 103.5 | 89 / 92 | 70 / 103.3 |
| S5 · Snow | 21 / 48.7 | 89 / 81.9 | 80 / 144.7 | 59 / 101.5 | 58 / 73.3 | 64 / 110.8 |
| S5 · Bike only + wet | 21 / 48.7 | 76 / 82.2 | 83 / 140.7 | 66 / 114.5 | 78 / 106.8 | 59 / 183.6 |
| S18 · Clear | 21 / 48.7 | 71 / 71.1 | 74 / 94.9 | 88 / 111.9 | 73 / 101.4 | 68 / 140.3 |
| S18 · Closed | 21 / 48.7 | 69 / 70 | 79 / 118.7 | 91 / 132.1 | 59 / 123 | 87 / 121.9 |
| S18 · Breakdown | 21 / 48.7 | 64 / 65.1 | 86 / 128 | 47 / 104.6 | 70 / 93.6 | 87 / 106.5 |
| S18 · Bike only | 21 / 48.7 | 72 / 70.8 | 73 / 90.7 | 60 / 109.5 | 73 / 137.4 | 69 / 88.3 |
| S18 · Wet | 21 / 48.7 | 74 / 76.6 | 66 / 95.4 | 68 / 127.6 | 61 / 94.7 | 78 / 118.3 |
| S18 · Snow | 21 / 48.7 | 81 / 70.3 | 78 / 94.6 | 76 / 99.4 | 59 / 96.6 | 59 / 99.6 |
| S18 · Bike only + wet | 21 / 48.7 | 75 / 81.9 | 60 / 144.3 | 44 / 149.3 | 45 / 99.5 | 93 / 102.9 |
| S48 · Clear | 21 / 48.7 | 85 / 76.1 | 75 / 119 | 83 / 148.9 | 70 / 116.3 | 77 / 110 |
| S48 · Closed | 21 / 48.7 | 79 / 68.2 | 70 / 124 | 75 / 113.6 | 80 / 141.9 | 77 / 98.5 |
| S48 · Breakdown | 21 / 48.7 | 83 / 70 | 84 / 109.5 | 55 / 113.8 | 58 / 127.6 | 72 / 119.2 |
| S48 · Bike only | 21 / 48.7 | 72 / 81.8 | 66 / 156.8 | 63 / 122 | 78 / 126.6 | 64 / 119.8 |
| S48 · Wet | 21 / 48.7 | 65 / 66.9 | 61 / 116 | 75 / 74.9 | 80 / 177.8 | 67 / 152.6 |
| S48 · Snow | 21 / 48.7 | 65 / 74 | 80 / 98.9 | 70 / 104.1 | 62 / 138.3 | 60 / 144.1 |
| S48 · Bike only + wet | 21 / 48.7 | 85 / 72.7 | 67 / 122.9 | 78 / 108.9 | 59 / 109.4 | 73 / 110.5 |
| S50 · Clear | 21 / 48.7 | 89 / 75.4 | 74 / 99.8 | 84 / 133.4 | 82 / 131.2 | 65 / 107.2 |
| S50 · Closed | 21 / 48.7 | 73 / 91 | 62 / 114.9 | 63 / 121.2 | 70 / 99 | 86 / 91.9 |
| S50 · Breakdown | 21 / 48.7 | 59 / 71.2 | 84 / 100.5 | 67 / 161.7 | 94 / 136.4 | 63 / 81.4 |
| S50 · Bike only | 21 / 48.7 | 78 / 75.9 | 83 / 117.3 | 47 / 123.9 | 81 / 98.8 | 55 / 89.2 |
| S50 · Wet | 21 / 48.7 | 77 / 79.4 | 62 / 92.4 | 67 / 160.7 | 82 / 128.7 | 68 / 133.9 |
| S50 · Snow | 21 / 48.7 | 70 / 64.7 | 70 / 107 | 72 / 106.1 | 92 / 128.3 | 83 / 115.4 |
| S50 · Bike only + wet | 21 / 48.7 | 72 / 73.8 | 90 / 120.2 | 75 / 123.8 | 63 / 130.9 | 81 / 113.1 |

## All 50 streets at Typical demand

Each cell gives **peak local queue / mean network queue during the 20-minute hold / network queue at 25:00**. Peak and mean values use the five-second snapshots. The run JSON records every street and control's five checkpoints and the one- and five-minute recovery checkpoints.

| Street | Clear | Closed | Breakdown | Bike only | Wet | Snow | Bike only + wet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 4 / 16.5 / 14 | 0 / 17.4 / 22 | 4 / 16.3 / 13 | 1 / 16 / 10 | 3 / 15.3 / 11 | 4 / 19.7 / 29 | 0 / 20.2 / 8 |
| S2 | 4 / 14.4 / 8 | 0 / 13.9 / 18 | 5 / 17 / 13 | 3 / 13.4 / 21 | 4 / 16.1 / 12 | 5 / 17.3 / 5 | 3 / 14.4 / 13 |
| S3 | 7 / 17.2 / 14 | 0 / 14.9 / 3 | 7 / 17.3 / 7 | 3 / 19.4 / 8 | 8 / 17.7 / 14 | 8 / 17.9 / 14 | 4 / 19 / 22 |
| S4 | 7 / 19.4 / 15 | 1 / 25.6 / 25 | 8 / 20.4 / 19 | 3 / 31.3 / 23 | 7 / 18.8 / 17 | 8 / 23 / 21 | 3 / 28 / 41 |
| S5 | 2 / 17.8 / 16 | 0 / 17.2 / 11 | 4 / 16.3 / 10 | 1 / 19.9 / 4 | 4 / 18.2 / 18 | 4 / 19.9 / 7 | 2 / 20.3 / 17 |
| S6 | 8 / 14.5 / 20 | 1 / 13.1 / 14 | 6 / 17.3 / 13 | 4 / 15.8 / 16 | 7 / 17.6 / 13 | 11 / 17.5 / 13 | 3 / 17.9 / 14 |
| S7 | 12 / 20.1 / 21 | 2 / 16.6 / 12 | 12 / 20.2 / 15 | 4 / 16.7 / 18 | 11 / 19.2 / 8 | 12 / 21.7 / 12 | 5 / 16.1 / 15 |
| S8 | 8 / 15.8 / 5 | 1 / 18.7 / 13 | 10 / 15 / 26 | 2 / 15.5 / 13 | 7 / 18.7 / 7 | 9 / 18.9 / 12 | 4 / 16.3 / 18 |
| S9 | 4 / 14.8 / 13 | 0 / 13.5 / 20 | 5 / 17.6 / 13 | 2 / 16.8 / 17 | 4 / 16.1 / 19 | 4 / 16.4 / 17 | 2 / 16.8 / 19 |
| S10 | 3 / 14.7 / 11 | 0 / 15.4 / 14 | 4 / 19.5 / 8 | 1 / 17 / 16 | 2 / 18.9 / 13 | 3 / 17.8 / 19 | 1 / 14.9 / 14 |
| S11 | 2 / 15.6 / 5 | 0 / 21.1 / 6 | 3 / 21.2 / 11 | 2 / 16.2 / 28 | 2 / 17 / 19 | 3 / 21 / 11 | 1 / 14.1 / 6 |
| S12 | 3 / 17.2 / 15 | 0 / 16.5 / 13 | 5 / 17.4 / 23 | 2 / 17.4 / 18 | 3 / 17 / 9 | 4 / 16.5 / 11 | 2 / 16.7 / 12 |
| S13 | 2 / 18.1 / 5 | 0 / 14.3 / 9 | 2 / 18.6 / 18 | 1 / 15.7 / 15 | 2 / 15.5 / 7 | 2 / 16.4 / 12 | 2 / 16.3 / 13 |
| S14 | 2 / 17.6 / 15 | 0 / 14.7 / 9 | 3 / 20.8 / 15 | 1 / 16.8 / 9 | 2 / 19.4 / 14 | 2 / 16.2 / 14 | 1 / 16.7 / 11 |
| S15 | 2 / 16.2 / 16 | 0 / 15.8 / 23 | 3 / 16.1 / 21 | 0 / 16.2 / 18 | 4 / 14.9 / 6 | 2 / 16.2 / 13 | 2 / 16.7 / 12 |
| S16 | 3 / 18 / 17 | 0 / 27 / 24 | 5 / 18.8 / 11 | 1 / 26.7 / 31 | 5 / 17.2 / 20 | 3 / 18 / 11 | 1 / 29.3 / 38 |
| S17 | 6 / 17.9 / 15 | 0 / 17 / 19 | 7 / 21 / 14 | 3 / 18.7 / 13 | 8 / 15.8 / 15 | 13 / 20.7 / 25 | 4 / 16.8 / 14 |
| S18 | 15 / 19.3 / 9 | 3 / 17.8 / 11 | 12 / 21.6 / 9 | 4 / 17.7 / 12 | 14 / 19.3 / 9 | 15 / 17.9 / 13 | 4 / 15.7 / 17 |
| S19 | 4 / 18.2 / 4 | 0 / 14.6 / 12 | 7 / 21.4 / 15 | 2 / 17.5 / 7 | 5 / 17.6 / 12 | 5 / 21.3 / 10 | 3 / 14.8 / 13 |
| S20 | 5 / 16.8 / 16 | 2 / 16.1 / 8 | 4 / 18.1 / 24 | 2 / 17.4 / 15 | 5 / 15.8 / 7 | 4 / 17.5 / 16 | 2 / 17.3 / 17 |
| S21 | 6 / 15.9 / 4 | 0 / 15.7 / 15 | 6 / 18.7 / 17 | 1 / 17 / 7 | 3 / 17.2 / 15 | 3 / 16.3 / 26 | 1 / 16.3 / 7 |
| S22 | 7 / 16.4 / 18 | 3 / 16.2 / 16 | 6 / 22.9 / 6 | 3 / 16.9 / 10 | 6 / 16.8 / 7 | 6 / 19.6 / 15 | 3 / 16.4 / 19 |
| S23 | 8 / 16.6 / 12 | 4 / 17.3 / 16 | 13 / 24.6 / 17 | 4 / 14.8 / 6 | 9 / 19 / 17 | 8 / 17 / 16 | 4 / 14.3 / 9 |
| S24 | 8 / 19.7 / 12 | 1 / 15.8 / 11 | 11 / 20.5 / 17 | 2 / 16.9 / 17 | 6 / 15.6 / 14 | 7 / 16.3 / 15 | 3 / 18.9 / 9 |
| S25 | 4 / 18.3 / 12 | 1 / 15.7 / 11 | 7 / 17.5 / 13 | 2 / 14.7 / 18 | 2 / 15.6 / 15 | 2 / 15.2 / 18 | 1 / 15.9 / 11 |
| S26 | 3 / 17.4 / 16 | 1 / 16.1 / 20 | 4 / 17.4 / 6 | 1 / 21.5 / 13 | 5 / 20.2 / 16 | 4 / 16.7 / 20 | 2 / 17.1 / 24 |
| S27 | 6 / 18.1 / 12 | 0 / 19.9 / 17 | 6 / 24.4 / 13 | 3 / 20.7 / 11 | 5 / 16.8 / 8 | 8 / 18.2 / 13 | 3 / 20.5 / 10 |
| S28 | 4 / 14.5 / 14 | 0 / 18.4 / 12 | 7 / 18.7 / 18 | 2 / 19.2 / 11 | 5 / 15.7 / 14 | 4 / 16.1 / 21 | 2 / 17.6 / 21 |
| S29 | 3 / 18.1 / 12 | 0 / 15.6 / 21 | 3 / 17.1 / 15 | 1 / 17.1 / 10 | 3 / 19.5 / 15 | 3 / 17.6 / 9 | 0 / 17.6 / 17 |
| S30 | 5 / 15 / 17 | 0 / 16.7 / 7 | 8 / 20.8 / 14 | 2 / 14.5 / 18 | 3 / 18.2 / 18 | 5 / 16 / 17 | 2 / 13.9 / 8 |
| S31 | 1 / 15.7 / 5 | 0 / 14 / 10 | 4 / 18.9 / 22 | 1 / 16.3 / 11 | 1 / 16.8 / 22 | 2 / 15.6 / 8 | 1 / 16.1 / 21 |
| S32 | 4 / 18.3 / 17 | 1 / 15 / 11 | 4 / 19.4 / 19 | 2 / 16.8 / 25 | 4 / 19 / 18 | 5 / 17.1 / 10 | 2 / 16.7 / 13 |
| S33 | 2 / 17.2 / 9 | 0 / 15 / 14 | 4 / 20 / 19 | 1 / 13.7 / 9 | 2 / 19 / 20 | 2 / 18.6 / 5 | 2 / 15.6 / 7 |
| S34 | 6 / 13.9 / 13 | 2 / 15.5 / 6 | 8 / 18.7 / 13 | 2 / 15.7 / 19 | 6 / 16.2 / 15 | 8 / 18.4 / 18 | 3 / 16.3 / 10 |
| S35 | 5 / 17 / 19 | 0 / 17 / 14 | 9 / 20.2 / 13 | 3 / 13.8 / 19 | 3 / 16.8 / 10 | 6 / 16.1 / 14 | 2 / 15.5 / 15 |
| S36 | 10 / 20.3 / 11 | 4 / 20.1 / 21 | 11 / 21.2 / 11 | 5 / 25.9 / 33 | 11 / 26.8 / 16 | 12 / 23.6 / 23 | 5 / 20.1 / 24 |
| S37 | 4 / 25.2 / 13 | 0 / 16 / 14 | 7 / 21 / 17 | 2 / 18.2 / 13 | 4 / 20.2 / 15 | 5 / 20 / 25 | 3 / 16.8 / 11 |
| S38 | 6 / 20.2 / 15 | 0 / 13.9 / 17 | 7 / 23.2 / 16 | 2 / 16.3 / 7 | 2 / 18.3 / 12 | 4 / 20.1 / 20 | 1 / 17.2 / 15 |
| S39 | 3 / 17.3 / 8 | 0 / 16.1 / 10 | 10 / 18.9 / 24 | 1 / 14.2 / 10 | 4 / 16 / 8 | 4 / 14.8 / 17 | 1 / 15 / 21 |
| S40 | 7 / 19.3 / 12 | 2 / 17.3 / 19 | 7 / 34.4 / 20 | 3 / 17.8 / 26 | 8 / 21.2 / 15 | 8 / 19.9 / 16 | 3 / 18 / 17 |
| S41 | 3 / 19.4 / 34 | 0 / 16.7 / 8 | 5 / 19.8 / 22 | 2 / 17.6 / 15 | 5 / 24.1 / 20 | 2 / 19.6 / 19 | 2 / 18.7 / 12 |
| S42 | 6 / 24.8 / 11 | 1 / 16.5 / 13 | 6 / 21.9 / 25 | 3 / 19.8 / 13 | 6 / 22.2 / 22 | 4 / 22.3 / 9 | 3 / 18.7 / 10 |
| S43 | 7 / 21.9 / 18 | 0 / 17.6 / 14 | 8 / 21.9 / 17 | 3 / 17.2 / 18 | 9 / 22.5 / 23 | 5 / 24.2 / 10 | 2 / 16.8 / 10 |
| S44 | 6 / 24.9 / 18 | 1 / 13.9 / 14 | 5 / 24.4 / 7 | 2 / 16.9 / 12 | 5 / 19.1 / 10 | 5 / 23.5 / 20 | 3 / 16.3 / 22 |
| S45 | 5 / 20.4 / 16 | 1 / 15.6 / 11 | 3 / 16.8 / 16 | 4 / 19 / 11 | 6 / 21.5 / 16 | 5 / 17.6 / 16 | 3 / 19 / 10 |
| S46 | 8 / 17.6 / 15 | 1 / 14.7 / 9 | 8 / 22.2 / 23 | 4 / 16.4 / 15 | 9 / 24.2 / 19 | 9 / 21.9 / 23 | 4 / 18.8 / 16 |
| S47 | 2 / 14.1 / 14 | 0 / 17.2 / 15 | 6 / 18.1 / 12 | 2 / 19.7 / 9 | 3 / 17.1 / 19 | 2 / 16.2 / 6 | 2 / 18 / 19 |
| S48 | 4 / 17.4 / 20 | 0 / 14.8 / 13 | 4 / 18.8 / 15 | 1 / 15.6 / 10 | 4 / 16.2 / 18 | 4 / 16.6 / 15 | 2 / 16.8 / 2 |
| S49 | 3 / 17.9 / 20 | 0 / 14.7 / 13 | 9 / 20.3 / 20 | 2 / 15.6 / 22 | 6 / 16.7 / 28 | 8 / 18.2 / 13 | 3 / 16.3 / 7 |
| S50 | 1 / 15.1 / 20 | 0 / 13.9 / 3 | 6 / 24.6 / 29 | 0 / 14.4 / 17 | 1 / 17.1 / 24 | 3 / 18.3 / 20 | 1 / 15.8 / 14 |

## Verification and reproduction

The long runs used the production simulation and signal strategy code under Node. A Node DOM harness loaded the page markup and exercised pause, reset, playback speed, the demand controls, road conditions, weather, additions, controller selection, and the header at capacity and with an empty network. A separate SVG harness checked opposite direction arrows on S48 and S50, the one-way grade-separated S49 crossing, the fit controls, and all 33 cached signal placements. A live-browser screenshot was unavailable in this session.

Run the included [scenario runner](tests/traffic-scenarios.cjs) from the project root to reproduce the suite and save the per-run checkpoints.

```sh
node tests/traffic-scenarios.cjs > scenario-results.json
```
