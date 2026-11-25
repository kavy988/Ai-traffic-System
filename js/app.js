(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const data = window.MAP_PREVIEW_DATA;
  if (!data || !window.TrafficSim || !window.TrafficMap || !window.TrafficMLControl) {
    if ($('runStatus')) $('runStatus').textContent = 'Unable to load. Refresh this page.';
    return;
  }
  const engine = window.TrafficSim.create(data, { seed: 42, autoPedestrians: true, autoBreakdowns: true, autoCranes: true, autoBuses: true, schoolTraffic: true, realisticTraffic: true });
  const mlControl = window.TrafficMLControl.create(engine, { seed: 42 });
  // The queue-aware controller is a rules baseline; external models connect through this adapter.
  window.signalStudio = { engine, data, ml: mlControl, version: '2.3' };
  window.signalStudio.simulator = window.TrafficSimulatorInterface.create(engine, data);
  const crossings = new Map((data.pedestrianCrossings || []).map(crossing => [crossing.id, crossing]));
  let selectedStreetId = 'S36';
  let selectedCrossingId = Array.from(crossings.values()).find(crossing => crossing.streetId === selectedStreetId)?.id ?? null;
  let selectedVehicleId = null;
  let trackedPedestrians = null;
  let roadFilter = '';
  let lastUi = -Infinity;
  let lastChart = -Infinity;
  let lastMap = -Infinity;
  let motionSnapshot;
  let stepRemainder = 0;
  let currentSpeed = 1;
  let simulationRunning = true;
  let selectedControllerId = 'adaptive';
  let registeredModel = null;
  let comparisonReport = null;
  let comparisonRunning = false;
  let lastScenarioAction = { time: 0, message: 'Seeded traffic ready' };
  let lastEventKey = '';
  let toastTimer;
  const controllerNames = {
    adaptive: 'Adaptive rules',
    fixed: 'Fixed timing',
    'queue-baseline': 'Queue-aware rules',
    external: 'External ML'
  };
  const surfaceNames = { clear: 'Clear', wet: 'Wet', snow: 'Snow' };
  const trackingEmptyHints = {
    car: 'Track a car when one enters the network.',
    bike: 'Track a bike when one enters the network.',
    pedestrians: 'Wait for pedestrians to arrive or request a crossing.',
    crane: 'Waiting for a crane. You can also dispatch one from Add Activity.',
    bus: 'Waiting for the next city bus. You can also add one from Add Activity.'
  };
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
  const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  function timeOfDayLabel(seconds, withSeconds = true) {
    const hour = Math.floor(seconds / 3600);
    const minuteSecond = clock(seconds % 3600);
    return `${hour % 12 || 12}:${withSeconds ? minuteSecond : minuteSecond.slice(0, 2)} ${hour < 12 ? 'AM' : 'PM'}`;
  }
  const simulatedAge = (seconds, sampleCount) => {
    if (!Number.isFinite(seconds) || seconds < 0) return sampleCount > 0 ? 'age unavailable' : 'no completed trips';
    const age = Math.floor(seconds);
    if (age < 60) return `${age}s simulated ago`;
    const minutes = Math.floor(age / 60);
    if (minutes < 60) return `${minutes}m simulated ago`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m simulated ago`;
  };
  const setText = (id, value) => { const el = $(id); if (el && el.textContent !== String(value)) el.textContent = value; };
  const on = (id, event, fn) => $(id)?.addEventListener(event, fn);

  function rememberScenarioAction(message, time) {
    lastScenarioAction = { message, time };
  }

  function announce(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  const map = window.TrafficMap.create({
    svg: $('cityMap'), frame: $('mapFrame'), tooltip: $('mapTooltip'), data,
    onStreetSelect: selectRoad,
    onVehicleSelect: selectVehicle,
    onCrossingSelect: selectCrossing,
    onSignalSelect: () => {}
  });
  window.signalStudio.map = map;

  function setStreetSelection(id) {
    selectedStreetId = id || null;
    if (crossings.get(selectedCrossingId)?.streetId !== selectedStreetId) {
      selectedCrossingId = Array.from(crossings.values()).find(crossing => crossing.streetId === selectedStreetId)?.id ?? null;
      setText('crossingFeedback', '');
    }
  }

  function selectRoad(id) {
    setStreetSelection(id);
    roadFilter = '';
    if ($('roadSearch')) $('roadSearch').value = '';
    populateRoads();
    $('roadSelect').value = id || '';
    refreshUi();
    renderMap();
  }

  function selectCrossing(id) {
    const crossing = crossings.get(id);
    if (id && !crossing) return;
    selectedCrossingId = crossing?.id ?? null;
    setText('crossingFeedback', '');
    if (crossing) selectRoad(crossing.streetId);
    else {
      refreshUi();
      renderMap();
    }
  }

  function populateCrossings() {
    const select = $('crossingSelect');
    for (const crossing of crossings.values()) {
      const option = document.createElement('option');
      option.value = crossing.id;
      option.textContent = `${crossing.streetId} crossing`;
      select.appendChild(option);
    }
  }

  function updateCrossingControls(snapshot) {
    const select = $('crossingSelect');
    const crossing = snapshot.crossings?.find(item => item.id === selectedCrossingId);
    select.value = crossing?.id ?? '';
    $('requestPedestrians').disabled = !crossing;
    if (!crossing) {
      setText('crossingStatus', 'Choose a marked crossing.');
      return;
    }
    const waiting = crossing.waiting ? `${fmt(crossing.waiting)} waiting` : '';
    const status = crossing.state === 'walk'
      ? [`WALK · ${fmt(crossing.crossing)} crossing · ${Math.ceil(crossing.remaining)}s left`, waiting].filter(Boolean).join(' · ')
      : waiting ? `WAIT · ${waiting}` : 'No pedestrians waiting.';
    setText('crossingStatus', status);
  }

  function populateRoads() {
    const select = $('roadSelect');
    const roads = engine.getSnapshot().roads.filter((r) => !roadFilter || r.id.toLowerCase().includes(roadFilter));
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = roads.length ? 'Choose a street' : 'No matching street';
    select.appendChild(placeholder);
    for (const road of roads) {
      const option = document.createElement('option');
      option.value = road.id;
      option.textContent = roadOptionLabel(road);
      select.appendChild(option);
    }
    if (roads.some((r) => r.id === selectedStreetId)) select.value = selectedStreetId;
    select.disabled = !roads.length;
  }

  function roadOptionLabel(road) {
    const direction = road.flyover ? 'One-way flyover' : road.oneWay ? 'One-way entry' : null;
    const status = road.workClosed ? 'Roadwork closure' : road.closed ? 'Closed' : road.bikeOnly ? 'Bikes only'
      : road.breakdown ? 'Breakdown' : road.breakdownRecovering ? 'Clearing queue' : 'Open';
    const surface = road.surfaceWeather && road.surfaceWeather !== 'clear' ? ` · ${road.surfaceWeather}` : '';
    return `${road.id} — ${direction ? `${direction} · ` : ''}${status}${surface} · ${road.count} vehicle${road.count === 1 ? '' : 's'}`;
  }

  function refreshRoadOptionLabels(snapshot) {
    const roads = new Map(snapshot.roads.map((road) => [road.id, road]));
    for (const option of $('roadSelect').options) {
      const road = roads.get(option.value);
      if (road) {
        const label = roadOptionLabel(road);
        if (option.textContent !== label) option.textContent = label;
      }
    }
  }

  function updateDemandDisplay(value) {
    const numeric = Math.max(0, Math.min(3, Number(value) || 0));
    const range = $('demandRange');
    range.style.setProperty('--range-value', String(numeric / 3 * 100));
    const preset = ['', 'Typical', 'Busy', 'Heavy'][numeric] || (numeric === 0 ? 'Quiet' : '');
    setText('demandValue', `${preset ? `${preset} · ` : ''}${numeric.toFixed(1)}×`);
    range.setAttribute('aria-valuetext', `Traffic demand level ${numeric.toFixed(1)}${preset ? `, ${preset}` : ''}`);
    document.querySelectorAll('[data-demand-preset]').forEach((button) => {
      const active = numeric === Number(button.dataset.demandPreset);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function updateDemandProfile(snapshot) {
    const daily = snapshot.demandProfileMode === 'daily';
    const input = $('demandStartTime');
    $('dailyDemand').checked = daily;
    $('dailyDemandPanel').hidden = !daily;
    if (input.defaultValue !== snapshot.demandProfileStartTime) {
      input.defaultValue = snapshot.demandProfileStartTime;
      input.value = snapshot.demandProfileStartTime;
    }
    const seconds = snapshot.timeOfDaySeconds;
    const time = Number.isFinite(seconds)
      ? `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${clock(seconds % 3600)}`
      : snapshot.timeOfDay;
    for (const id of ['mapClock', 'demandClock']) {
      setText(id, Number.isFinite(seconds) ? timeOfDayLabel(seconds) : time);
      const readout = $(id);
      if (readout.dateTime !== time) readout.dateTime = time;
    }
    setText('effectiveDemand', `${snapshot.metrics.effectiveDemand.toFixed(2)}×`);
    if (snapshot.boundaryDemand?.length) {
      const m = snapshot.metrics;
      const rate = snapshot.boundaryDemand.reduce((sum, gate) => sum + gate.ratePerMinute, 0);
      setText('boundaryDemandSummary', `About ${fmt(rate)} entry requests per simulated minute · ${fmt(m.boundaryQueued)} waiting to enter${m.boundaryDropped ? ` · ${fmt(m.boundaryDropped)} overflowed this run` : ''}.`);
    }
  }

  function updateSurfaceWeatherButtons(road = currentRoad()) {
    const selectedSurface = road?.surfaceWeather || 'clear';
    document.querySelectorAll('[data-surface-weather]').forEach((button) => {
      const active = button.dataset.surfaceWeather === selectedSurface;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !road;
    });
  }

  function renderWeatherRoads(snapshot = engine.getSnapshot()) {
    const container = $('weatherRoadChips');
    const roads = snapshot.roads.filter((road) => road.surfaceWeather && road.surfaceWeather !== 'clear');
    container.replaceChildren();
    if (!roads.length) {
      const empty = document.createElement('span');
      empty.className = 'weather-road-empty';
      empty.textContent = 'No wet or snowy roads yet.';
      container.appendChild(empty);
    } else {
      for (const road of roads) {
        const chip = document.createElement('div');
        chip.className = 'weather-road-chip';
        const label = document.createElement('span');
        label.className = 'weather-road-chip-label';
        label.textContent = road.id;
        const surface = document.createElement('select');
        surface.className = 'weather-road-chip-select';
        surface.setAttribute('aria-label', `Surface on ${road.id}`);
        Object.entries(surfaceNames).forEach(([value, text]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          surface.appendChild(option);
        });
        surface.value = road.surfaceWeather;
        surface.addEventListener('change', () => applySurfaceWeather(road.id, surface.value));
        chip.append(label, surface);
        container.appendChild(chip);
      }
    }
    updateSurfaceWeatherButtons(currentRoad(snapshot) || null);
  }

  function applySurfaceWeather(streetId, value) {
    if (!streetId) return announce('Choose a street in Street Conditions first.');
    const before = engine.getSnapshot().roads.find((road) => road.id === streetId);
    const result = engine.setRoadWeather(streetId, value);
    if (!result?.ok) return announce(result?.message || `Could not update ${streetId}.`);
    const snapshot = engine.getSnapshot();
    if (before?.surfaceWeather !== value) {
      rememberScenarioAction(`${streetId} surface set to ${value}`, snapshot.time);
    }
    renderWeatherRoads(snapshot);
    refreshUi(snapshot);
    renderMap(snapshot);
    announce(`${streetId} surface set to ${surfaceNames[value]}.`);
  }

  function roadFeedback(result, fallback, action) {
    const snapshot = engine.getSnapshot();
    if (result?.ok && action) rememberScenarioAction(action, snapshot.time);
    const message = result?.message || fallback;
    setText('roadFeedback', message);
    announce(message);
    refreshUi(snapshot);
    renderMap(snapshot);
  }

  function currentRoad(snapshot = engine.getSnapshot()) { return snapshot.roads.find((r) => r.id === selectedStreetId); }

  function roadworkTiming(work) {
    if (work.state === 'clearing') return 'Road closed · traffic clearing';
    if (work.state === 'working') return `${Math.ceil(Math.max(0, work.remaining))}s of work left`;
    if (!Number.isFinite(work.eta)) return 'Closure starts when the crane can reach the site';
    return work.eta > 0 ? `Est. closure in ${Math.ceil(work.eta)}s` : 'Closing as the crane arrives';
  }

  function breakdownTiming(incident) {
    return `Breakdown clears in ${Math.ceil(incident.remaining)}s`;
  }

  function roadSwitchValue(road, key) {
    if (key === 'closed') return Boolean(road?.manualClosed);
    if (key === 'breakdown') return Boolean(road?.manualBreakdown);
    return Boolean(road?.[key]);
  }

  function updateRoadworkSummary(snapshot) {
    const jobs = snapshot.roadworks || [];
    const job = jobs.find((item) => item.streetId === selectedStreetId && item.state !== 'enroute')
      || jobs.find((item) => item.streetId === selectedStreetId)
      || jobs.find((item) => item.state !== 'enroute') || jobs[0];
    const summary = $('roadworkSummary');
    summary.dataset.state = job?.state || 'idle';
    $('roadworkStreet').disabled = !job;
    $('roadworkTrack').disabled = !job;
    if (!job) {
      delete $('roadworkStreet').dataset.streetId;
      delete $('roadworkTrack').dataset.vehicleId;
      setText('roadworkStreet', 'Crane roadwork');
      setText('roadworkTiming', 'No crane job active.');
      $('roadworkProgress').hidden = true;
      $('roadworkProgress').value = 0;
      $('roadworkOther').hidden = true;
      return;
    }
    $('roadworkStreet').dataset.streetId = job.streetId;
    $('roadworkTrack').dataset.vehicleId = job.vehicleId;
    setText('roadworkStreet', `${job.streetId} roadwork`);
    setText('roadworkTiming', roadworkTiming(job));
    const progress = $('roadworkProgress');
    progress.hidden = job.state !== 'working';
    progress.value = Number.isFinite(job.progress) ? job.progress : 0;
    $('roadworkOther').hidden = jobs.length === 1;
    setText('roadworkOther', `+ ${jobs.length - 1} other ${jobs.length === 2 ? 'job' : 'jobs'}`);
  }

  function applyRoad(key, value) {
    if (!selectedStreetId) return announce('Choose a street first.');
    const road = currentRoad();
    const actions = {
      closed: value ? 'closed manually' : 'manual closure lifted',
      breakdown: value ? 'breakdown started' : 'breakdown cleared',
      bikeOnly: value ? 'set to bikes only' : 'bike-only restriction lifted'
    };
    const previous = roadSwitchValue(road, key);
    const action = previous === value ? null : `${selectedStreetId} ${actions[key]}`;
    roadFeedback(engine.setRoad(selectedStreetId, { [key]: value }), `${selectedStreetId} updated.`, action);
    populateRoads();
  }

  on('roadSearch', 'input', (event) => {
    roadFilter = event.target.value.trim().toLowerCase();
    populateRoads();
    if ($('roadSelect').value !== selectedStreetId) {
      setStreetSelection($('roadSelect').options[1]?.value);
      $('roadSelect').value = selectedStreetId || '';
      refreshUi();
      renderMap();
    }
  });
  on('roadSelect', 'change', (event) => selectRoad(event.target.value));
  on('crossingSelect', 'change', (event) => selectCrossing(event.target.value));
  on('requestPedestrians', 'click', () => {
    if (!selectedCrossingId) return;
    const input = $('pedestrianAmount');
    if (!input.reportValidity()) return;
    const result = engine.requestCrossing(selectedCrossingId, input.valueAsNumber);
    const snapshot = engine.getSnapshot();
    if (result.ok) rememberScenarioAction(result.message, snapshot.time);
    setText('crossingFeedback', result.message);
    refreshUi(snapshot);
    renderMap(snapshot);
  });
  on('clearStreet', 'click', () => selectRoad(null));
  on('roadClosed', 'change', (event) => applyRoad('closed', event.target.checked));
  on('roadBreakdown', 'change', (event) => applyRoad('breakdown', event.target.checked));
  on('roadBikeOnly', 'change', (event) => applyRoad('bikeOnly', event.target.checked));
  on('roadworkStreet', 'click', (event) => selectRoad(event.currentTarget.dataset.streetId));
  on('roadworkTrack', 'click', (event) => {
    const id = event.currentTarget.dataset.vehicleId;
    const snapshot = engine.getSnapshot();
    const crane = snapshot.vehicles.find((vehicle) => String(vehicle.id) === id)
      || snapshot.completed.find((vehicle) => String(vehicle.id) === id);
    if (!crane) return;
    selectVehicle(crane.id, { centerMap: false, snapshot });
    $('vehicleInspector').scrollIntoView({ block: 'nearest' });
    $('vehicleInspectorHeading').focus({ preventScroll: true });
  });
  on('vehicleType', 'change', (event) => {
    const crane = event.target.value === 'crane';
    setText('addTrafficLabel', crane ? 'Dispatch cranes' : 'Add vehicles');
    $('craneDispatchHelp').hidden = !crane;
  });
  on('addTraffic', 'click', () => {
    if (!selectedStreetId) return announce('Choose a street first.');
    const count = Math.max(1, Math.min(50, Math.floor(Number($('trafficAmount').value) || 10)));
    $('trafficAmount').value = count;
    const result = engine.addTraffic(selectedStreetId, count, $('vehicleType').value);
    roadFeedback(result, `Added ${count} vehicles on ${selectedStreetId}.`, result.message);
  });
  on('playToggle', 'click', () => {
    engine.setRunning(!engine.getSnapshot().running);
    refreshUi();
  });
  on('speedSelect', 'change', (event) => {
    engine.setSpeed(Number(event.target.value));
    announce(`Simulation at ${event.target.value}× speed.`);
    refreshUi();
  });
  on('resetButton', 'click', () => {
    mlControl.endEpisode(engine.getSnapshot(), 'reset');
    const snapshot = engine.reset(42);
    $('demandStartTime').value = snapshot.demandProfileStartTime;
    rememberScenarioAction('Network reset', snapshot.time);
    stepRemainder = 0;
    selectedControllerId = 'adaptive';
    mlControl.beginEpisode(42, snapshot, 'adaptive_rules');
    setStreetSelection('S36');
    setText('crossingFeedback', '');
    selectedVehicleId = null;
    trackedPedestrians = null;
    lastEventKey = ''; lastChart = -Infinity;
    if ($('roadSearch')) $('roadSearch').value = '';
    $('vehicleSearch').value = '';
    $('searchResults').hidden = true;
    roadFilter = '';
    map.resetView();
    populateRoads();
    renderWeatherRoads(snapshot);
    refreshUi(snapshot);
    renderMap(snapshot);
    announce('Fresh network. Traffic, weather, and incidents have been reset.');
  });

  document.querySelectorAll('[data-surface-weather]').forEach((button) => {
    button.addEventListener('click', () => applySurfaceWeather(selectedStreetId, button.dataset.surfaceWeather));
  });
  on('demandRange', 'input', (event) => {
    const previous = engine.getSnapshot().demand;
    const value = Number(event.target.value);
    const result = engine.setDemand(value);
    const snapshot = engine.getSnapshot();
    if (result.ok && snapshot.demand !== previous) {
      rememberScenarioAction(`Demand set to ${snapshot.demand.toFixed(1)}×`, snapshot.time);
    }
    refreshUi(snapshot);
    renderMap(snapshot);
    if (result.message.includes('vehicles added')) announce(result.message);
  });
  document.querySelectorAll('[data-demand-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const range = $('demandRange');
      range.value = button.dataset.demandPreset;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  function applyDemandProfile(mode, startTime) {
    const result = engine.setDemandProfile(mode, startTime);
    const snapshot = engine.getSnapshot();
    if (result.ok) {
      $('demandStartTime').value = snapshot.demandProfileStartTime;
      rememberScenarioAction(mode === 'daily' ? `Daily demand set to ${timeOfDayLabel(snapshot.timeOfDaySeconds, false)}` : 'Steady demand resumed', snapshot.time);
    }
    refreshUi(snapshot);
    announce(result.message);
  }

  on('dailyDemand', 'change', (event) => {
    if (event.target.checked) applyDemandProfile('daily', $('demandStartTime').defaultValue);
    else applyDemandProfile('steady');
  });
  on('demandTimeForm', 'submit', (event) => {
    event.preventDefault();
    applyDemandProfile('daily', $('demandStartTime').value);
  });

  function chooseController(value, announceChange = true) {
    const previous = selectedControllerId;
    const labels = {
      adaptive: 'Adaptive rules baseline',
      fixed: 'Fixed timing baseline',
      'queue-baseline': 'Queue-aware AI baseline (rules-based, not trained)',
      external: 'External ML model'
    };
    let result;
    if (value === 'adaptive' || value === 'fixed') {
      result = engine.setMode(value);
      mlControl.setRunController(value === 'adaptive' ? 'adaptive_rules' : 'fixed_timing');
    } else if (value === 'queue-baseline') {
      result = mlControl.setPolicy('baseline');
      if (result.ok) result = engine.setMode('custom');
    } else if (value === 'external') {
      result = mlControl.setPolicy('external');
      if (result.ok) result = engine.setMode('custom');
    } else {
      result = { ok: false, message: 'Unknown controller.' };
    }
    if (result?.ok === false) {
      $('controllerMode').value = selectedControllerId;
      return announce(result.message);
    }
    selectedControllerId = value;
    const snapshot = engine.getSnapshot();
    if (value !== previous) rememberScenarioAction(`Signal strategy set to ${controllerNames[value].toLowerCase()}`, snapshot.time);
    $('externalControllerOption').disabled = !mlControl.hasExternalModel();
    if (announceChange) announce(`${labels[value]} selected.`);
    refreshUi(snapshot);
    renderMap(snapshot);
    return result;
  }
  on('controllerMode', 'change', (event) => chooseController(event.target.value));

  let theme = 'light';
  try { theme = localStorage.getItem('signal-studio-theme') || 'light'; } catch {}
  function setTheme(next) {
    theme = next === 'dark' ? 'dark' : 'light';
    document.body.dataset.theme = theme;
    map.setTheme(theme);
    $('themeToggle').setAttribute('aria-pressed', String(theme === 'dark'));
    $('themeToggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    setText('themeLabel', theme === 'dark' ? 'Light mode' : 'Dark mode');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151b1c' : '#f8f9f7');
    try { localStorage.setItem('signal-studio-theme', theme); } catch {}
  }
  on('themeToggle', 'click', () => setTheme(theme === 'light' ? 'dark' : 'light'));
  on('zoomIn', 'click', () => map.zoomBy(1.25));
  on('zoomOut', 'click', () => map.zoomBy(0.8));
  on('fitMap', 'click', () => map.resetView());
  ['showCounts', 'showSignals', 'showLabels'].forEach((id) => on(id, 'change', () => renderMap()));

  function selectVehicle(id, { centerMap = true, snapshot = engine.getSnapshot() } = {}) {
    const vehicle = snapshot.vehicles.find((item) => item.id === id) || snapshot.completed.find((item) => item.id === id);
    if (!vehicle) return;
    selectedVehicleId = id;
    trackedPedestrians = null;
    $('vehicleSearch').value = vehicle.plate;
    $('searchResults').hidden = true;
    updateInspector(snapshot);
    renderMap(snapshot);
    if (centerMap) map.focusVehicle(id);
  }
  function clearTracking() {
    selectedVehicleId = null;
    trackedPedestrians = null;
    $('vehicleSearch').value = '';
    $('searchResults').hidden = true;
    updateInspector();
    renderMap();
  }

  function trackingTarget(snapshot, type) {
    if (type === 'pedestrians') {
      const occupied = snapshot.crossings.filter((crossing) => crossing.waiting || crossing.crossing);
      return occupied.find((crossing) => crossing.id === selectedCrossingId)
        || occupied.find((crossing) => crossing.crossing) || occupied[0];
    }
    const vehicles = snapshot.vehicles.filter((vehicle) => vehicle.type === type);
    return vehicles.find((vehicle) => vehicle.roadwork?.state === 'working')
      || vehicles.find((vehicle) => !vehicle.waiting && vehicle.routeIndex + 1 < vehicle.route.length)
      || vehicles.find((vehicle) => !vehicle.waiting) || vehicles[0];
  }
  function normalizePlate(value) { return value.replace(/[^a-z0-9]/gi, '').toLowerCase(); }
  function showSearch() {
    const query = normalizePlate($('vehicleSearch').value);
    const list = $('searchResults'); list.replaceChildren();
    const snap = engine.getSnapshot();
    const liveIds = new Set(snap.vehicles.map((v) => v.id));
    const matches = [...snap.vehicles, ...snap.completed].filter((v) => !query || normalizePlate(v.plate).includes(query)).slice(0, 7);
    list.hidden = false;
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = 'No matching plate. Try part of a plate, such as RJ 14.';
      list.appendChild(empty);
      return;
    }
    for (const vehicle of matches) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'search-result';
      const plate = document.createElement('strong'); plate.textContent = vehicle.plate;
      const detail = document.createElement('span');
      detail.textContent = liveIds.has(vehicle.id) ? `${vehicle.streetId} · ${vehicle.waiting ? 'Waiting' : 'On the move'}` : 'Journey complete';
      button.append(plate, detail);
      button.addEventListener('click', () => selectVehicle(vehicle.id));
      list.appendChild(button);
    }
  }
  on('vehicleSearch', 'input', showSearch);
  on('vehicleSearch', 'focus', showSearch);
  on('vehicleSearch', 'keydown', (event) => {
    if (event.key === 'Escape') $('searchResults').hidden = true;
    if (event.key === 'ArrowDown') {
      $('searchResults').querySelector('button')?.focus(); event.preventDefault();
    }
  });
  on('vehicleSearchForm', 'submit', (event) => {
    event.preventDefault();
    showSearch();
    $('searchResults').querySelector('button')?.click();
  });
  on('searchResults', 'keydown', (event) => {
    const buttons = [...$('searchResults').querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
    if (event.key === 'Escape') { $('searchResults').hidden = true; $('vehicleSearch').focus(); }
  });
  on('trackingType', 'change', () => updateInspector());
  on('trackLiveSelection', 'click', () => {
    const snapshot = engine.getSnapshot();
    const type = $('trackingType').value;
    const target = trackingTarget(snapshot, type);
    if (!target) return;
    if (type === 'pedestrians') {
      const count = target.crossing || target.waiting;
      trackedPedestrians = { crossingId: target.id, count, finishAt: target.completedPedestrians + count };
      selectedVehicleId = null;
      $('vehicleSearch').value = '';
      $('searchResults').hidden = true;
      selectCrossing(target.id);
    } else {
      selectVehicle(target.id, { centerMap: false, snapshot });
    }
    $('vehicleInspectorHeading').focus({ preventScroll: true });
  });
  on('showTrackedCrossing', 'click', () => {
    if (trackedPedestrians) selectCrossing(trackedPedestrians.crossingId);
  });
  on('clearVehicle', 'click', () => {
    $('vehicleSearch').focus({ preventScroll: true });
    clearTracking();
  });
  on('closeVehicle', 'click', () => {
    clearTracking();
    $('trackingType').focus({ preventScroll: true });
  });
  on('vehicleRoute', 'click', (event) => {
    const streetId = event.target.closest('.route-step')?.dataset.streetId;
    if (streetId) selectRoad(streetId);
  });
  document.addEventListener('click', (event) => {
    if (!$('vehicleSearchForm').contains(event.target)) $('searchResults').hidden = true;
  });

  function setRouteStreet(step, streetId) {
    step.dataset.streetId = streetId;
    step.title = `Select street ${streetId}`;
    step.textContent = streetId;
  }

  function renderRouteChain(list, entries, { firstIndex, arrows = false, statuses = [] } = {}) {
    list.replaceChildren(...entries.map(({ streetId }, index) => {
      const leg = document.createElement('li');
      leg.className = 'route-leg';
      if (arrows && index > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'route-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';
        leg.append(arrow);
      }

      const step = document.createElement('button');
      step.type = 'button';
      step.className = 'route-step';
      setRouteStreet(step, streetId);
      if (firstIndex !== undefined) step.dataset.routeIndex = firstIndex + index;
      leg.append(step);

      const status = statuses[index];
      if (status) {
        leg.dataset.roadStatus = status.toLowerCase();
        step.setAttribute('aria-label', `${streetId}, ${status}`);
        if (status === 'Closed') {
          const cross = document.createElement('span');
          cross.setAttribute('aria-hidden', 'true');
          cross.textContent = '×';
          const roadId = document.createElement('s');
          roadId.textContent = streetId;
          step.replaceChildren(cross, roadId);
        }
        const badge = document.createElement('span');
        badge.className = 'route-road-status';
        badge.textContent = status;
        badge.setAttribute('aria-hidden', 'true');
        leg.append(badge);
      }
      return leg;
    }));
  }

  function updateVehicleRoute(vehicle, currentIndex, roads) {
    const route = $('vehicleRoute');
    const { route: journey, closureDetour } = vehicle;
    const forkIndex = closureDetour?.routeIndex;
    const hasFork = Boolean(journey[forkIndex]) && (currentIndex !== null || journey.length > forkIndex + 1);
    const flat = $('vehicleRouteFlat');
    const fork = $('vehicleRouteFork');
    const signature = JSON.stringify([vehicle.id, journey.map((leg) => leg.streetId), hasFork ? forkIndex : null]);

    if (route.dataset.signature !== signature) {
      route.dataset.signature = signature;
      flat.hidden = hasFork;
      fork.hidden = !hasFork;
      if (hasFork) {
        const history = $('vehicleRouteHistory');
        history.hidden = forkIndex === 0;
        $('vehicleRouteAnchorArrow').hidden = forkIndex === 0;
        renderRouteChain(history, journey.slice(0, forkIndex), { firstIndex: 0, arrows: true });
        const anchor = $('vehicleRouteAnchor');
        setRouteStreet(anchor, journey[forkIndex].streetId);
        anchor.dataset.routeIndex = forkIndex;
        const steps = $('vehicleDetourSteps');
        steps.hidden = journey.length === forkIndex + 1;
        $('vehicleDetourWaiting').hidden = !steps.hidden;
        renderRouteChain(steps, journey.slice(forkIndex + 1), { firstIndex: forkIndex + 1, arrows: true });
      } else {
        renderRouteChain(flat, journey, { firstIndex: 0, arrows: true });
      }
    }

    if (hasFork) {
      setText('vehicleRouteAnchorLabel', currentIndex === forkIndex ? 'Current street' : 'Detour start');
      const originalSteps = $('vehicleOriginalRouteSteps');
      const { originalRoute, closedRoadIds } = closureDetour;
      const statuses = originalRoute.map(({ streetId }) => {
        const road = roads.get(streetId);
        if (road?.closed) return 'Closed';
        return road && closedRoadIds.includes(streetId) ? 'Reopened' : '';
      });
      const originalSignature = JSON.stringify([originalRoute.map((leg) => leg.streetId), statuses]);
      if (originalSteps.dataset.signature !== originalSignature) {
        originalSteps.dataset.signature = originalSignature;
        renderRouteChain(originalSteps, originalRoute, { arrows: true, statuses });
      }
    }

    const visibleRoute = hasFork ? fork : flat;
    for (const step of visibleRoute.querySelectorAll('[data-route-index]')) {
      const index = Number(step.dataset.routeIndex);
      const current = index === currentIndex;
      step.classList.toggle('passed', currentIndex === null || index < currentIndex);
      step.classList.toggle('current', current);
      if (current && !step.hasAttribute('aria-current')) step.setAttribute('aria-current', 'step');
      if (!current && step.hasAttribute('aria-current')) step.removeAttribute('aria-current');
    }
  }

  function setTrackerTiming(value) {
    $('trackerTiming').hidden = !value;
    if (value) setText('trackerTiming', value);
  }

  function updateInspector(snap = engine.getSnapshot()) {
    const active = selectedVehicleId && snap.vehicles.find((v) => v.id === selectedVehicleId);
    const vehicle = active || (selectedVehicleId && snap.completed.find((v) => v.id === selectedVehicleId));
    const crossing = trackedPedestrians && snap.crossings.find((item) => item.id === trackedPedestrians.crossingId);
    $('vehicleEmptyState').hidden = Boolean(vehicle || crossing);
    $('vehicleJourney').hidden = !vehicle && !crossing;
    $('clearVehicle').hidden = !vehicle;
    $('trackedRouteDetails').hidden = !vehicle;
    $('trackedCrossingDetails').hidden = !crossing;
    if (crossing) {
      const complete = crossing.completedPedestrians >= trackedPedestrians.finishAt;
      const walking = !complete && crossing.state === 'walk';
      setText('vehiclePlate', `${crossing.streetId} crossing`);
      setText('inspectorVehicleType', 'Pedestrians');
      setText('vehicleStatus', complete ? 'Crossing complete' : walking ? 'Crossing now' : 'Waiting for WALK');
      setTrackerTiming(walking ? `${Math.ceil(crossing.remaining)}s left to cross` : '');
      $('vehicleRoadClosure').hidden = true;
      setText('trackerDetailLabel', 'People');
      setText('vehicleWait', fmt(trackedPedestrians.count));
      return;
    }
    if (!vehicle) {
      trackedPedestrians = null;
      if (selectedVehicleId) {
        selectedVehicleId = null;
        $('vehicleSearch').value = '';
        $('searchResults').hidden = true;
      }
      const type = $('trackingType').value;
      const available = Boolean(trackingTarget(snap, type));
      $('trackLiveSelection').disabled = !available;
      setText('vehicleTrackingHint', available ? 'Follow a live trip or a pedestrian crossing.' : trackingEmptyHints[type]);
      return;
    }
    setText('vehiclePlate', vehicle.plate);
    const roads = new Map(snap.roads.map((road) => [road.id, road]));
    const currentRoad = active && roads.get(active.streetId);
    const incident = snap.incidents?.find((item) => item.vehicleId === vehicle.id);
    const work = snap.roadworks?.find((item) => item.vehicleId === vehicle.id);
    let status = vehicle.breakdownPassing ? 'Passing a breakdown on' : vehicle.waiting ? 'Waiting on' : 'Travelling on';
    if (vehicle.waitingReason === 'breakdown') {
      status = currentRoad?.breakdownRecovering ? 'Waiting for the breakdown queue to clear on' : 'Queued behind a breakdown on';
    }
    const workStatus = work?.state === 'working' ? `Repairing ${work.streetId}`
      : work?.state === 'clearing' ? `Preparing ${work.streetId}` : work ? `Heading to ${work.streetId}` : '';
    let tripStatus = active ? `${status} ${vehicle.streetId}` : 'Journey complete';
    let timing = work ? roadworkTiming(work) : '';
    if (vehicle.type === 'crane' && !work) {
      tripStatus = active ? `${vehicle.waiting ? 'Waiting to exit on' : 'Exiting via'} ${vehicle.streetId}` : 'Exited network';
      if (vehicle.roadwork?.state === 'finished') timing = `Work on ${vehicle.roadwork.streetId} complete`;
      if (vehicle.roadwork?.state === 'incomplete') timing = `Work window on ${vehicle.roadwork.streetId} ended`;
      if (vehicle.roadwork?.state === 'cancelled') timing = 'Work cancelled · site unavailable';
    }
    if (vehicle.bus) {
      if (active && vehicle.bus.stage === 'boarding') {
        tripStatus = `Boarding at ${vehicle.bus.stopName}`;
        timing = `${Math.ceil(vehicle.bus.remaining)}s until departure`;
      } else if (active && vehicle.bus.stage === 'rejoining') {
        tripStatus = 'Waiting for space to pull away';
      } else if (active) timing = vehicle.bus.nextStopName
        ? `Next stop: ${vehicle.bus.nextStopName} · ${vehicle.bus.nextStopStreetId}` : 'Heading to the route exit';
      timing += `${timing ? ' · ' : ''}${vehicle.bus.onboard}/${vehicle.bus.capacity} aboard`;
      if (vehicle.bus.stage === 'boarding') timing += ` · ${vehicle.bus.boardedHere} boarded, ${vehicle.bus.alightedHere} got off`;
      else if (vehicle.bus.nextStopName) timing += ` · ${vehicle.bus.nextStopWaiting} waiting at next stop`;
      timing += ` · ${Math.round(vehicle.bus.passengerSeconds)}s passenger stops`;
    }
    if (vehicle.school && active) {
      tripStatus = vehicle.school.state === 'stopped' ? `${vehicle.school.phase === 'pickup' ? 'School pickup' : 'School drop-off'} at ${vehicle.school.name}`
        : vehicle.school.state === 'approaching' ? `Heading to ${vehicle.school.name}` : `Leaving ${vehicle.school.name}`;
      if (vehicle.school.state === 'stopped') timing = `${Math.ceil(vehicle.school.remaining)}s until departure · ${vehicle.school.children} students`;
    }
    setText('vehicleStatus', incident ? `Broken down on ${incident.streetId}` : workStatus || tripStatus);
    setTrackerTiming(incident ? breakdownTiming(incident) : timing);
    $('vehicleRoadClosure').hidden = !currentRoad?.closed || Boolean(work);
    setText('vehicleRoadClosure', currentRoad?.workClosed ? 'Closed for roadwork' : 'Current street closed');
    setText('inspectorVehicleType', vehicle.type === 'bus' ? `City bus · ${vehicle.bus?.serviceName || 'City service'}`
      : vehicle.type === 'crane' ? 'Mobile crane' : vehicle.type === 'bike' ? 'Motorbike' : 'Car');
    setText('trackerDetailLabel', vehicle.type === 'bus' ? 'Traffic wait' : 'Total wait');
    setText('vehicleWait', `${Math.round(vehicle.waitTime || 0)}s`);
    updateVehicleRoute(vehicle, active ? active.routeIndex : null, roads);
  }

  function updateScenario(snapshot) {
    const controller = snapshot.mode === 'custom'
      ? (selectedControllerId === 'external' || selectedControllerId === 'queue-baseline' ? controllerNames[selectedControllerId] : 'Custom controller')
      : controllerNames[snapshot.mode];
    const conditions = [
      [snapshot.roads.filter((road) => road.workClosed), 'closed for work', 'roadwork closures'],
      [snapshot.roads.filter((road) => road.closed && !road.workClosed), 'closed', 'roads closed'],
      [snapshot.roads.filter((road) => road.breakdown), 'breakdown', 'breakdowns'],
      [snapshot.roads.filter((road) => road.breakdownRecovering), 'clearing queue', 'roads clearing queues'],
      [snapshot.roads.filter((road) => road.craneCount), 'crane', 'roads with cranes'],
      [snapshot.roads.filter((road) => road.bikeOnly), 'bikes only', 'bike-only roads'],
      [snapshot.roads.filter((road) => road.surfaceWeather === 'wet'), 'wet', 'wet roads'],
      [snapshot.roads.filter((road) => road.surfaceWeather === 'snow'), 'snow', 'snowy roads']
    ];
    const roadChanges = conditions.filter(([roads]) => roads.length).map(([roads, single, multiple]) =>
      roads.length === 1 ? `${roads[0].id} ${single}` : `${fmt(roads.length)} ${multiple}`);
    const demand = snapshot.demandProfileMode === 'daily'
      ? `Daily ${timeOfDayLabel(snapshot.timeOfDaySeconds, false)} · ${snapshot.metrics.effectiveDemand.toFixed(2)}× typical arrivals`
      : `${snapshot.demand.toFixed(1)}× demand`;
    setText('scenarioSettings', `${demand} · ${controller}`);
    setText('scenarioRoads', roadChanges.join(' · ') || 'No road changes');
    setText('scenarioActionTime', `${clock(lastScenarioAction.time)} sim`);
    setText('scenarioAction', lastScenarioAction.message);
  }

  function refreshUi(snap = engine.getSnapshot()) {
    refreshRoadOptionLabels(snap);
    const metrics = snap.metrics;
    setText('activeCount', fmt(metrics.active));
    setText('activeCountContext', `of ${fmt(metrics.activeLimit)} vehicles`);
    $('activeLimitNotice').hidden = !metrics.atActiveLimit;
    setText('queuedCount', fmt(metrics.queued));
    setText('queueWaitContext', `Avg. current stop ${Number.isFinite(metrics.currentQueueAvgWait) ? `${metrics.currentQueueAvgWait.toFixed(1)}s` : '—'}`);
    setText('completedCount', fmt(metrics.completed));
    const hasDisplayAverage = Number.isFinite(metrics.avgWait);
    const waitSampleCount = metrics.avgWaitSampleCount;
    const waitSampleLimit = metrics.avgWaitWindowTrips;
    const lastCompletionAge = simulatedAge(metrics.avgWaitLatestSampleAgeSeconds, waitSampleCount);
    setText('avgWait', hasDisplayAverage ? `${Math.round(metrics.avgWait)}s` : '—');
    const waitWindow = waitSampleCount === waitSampleLimit
      ? `Latest ${waitSampleLimit} completed trips`
      : `${waitSampleCount}/${waitSampleLimit} completed trips`;
    const includesWarmup = metrics.completed < waitSampleCount;
    setText('avgWaitContext', hasDisplayAverage
      ? `${waitWindow}${includesWarmup ? ' · includes warmup' : ''}`
      : metrics.active ? 'No completed trips yet' : 'No active traffic');
    setText('avgWaitAge', hasDisplayAverage ? `Last trip ${lastCompletionAge}` : '');
    updateScenario(snap);
    setText('simTime', clock(snap.time));
    setText('runStatusText', snap.running ? 'Simulation live' : 'Simulation paused');
    setText('mapLiveLabel', snap.running ? 'Network live' : 'Network paused');
    setText('livePillLabel', snap.running ? 'LIVE SIMULATION' : 'SIMULATION PAUSED');
    $('runStatus').dataset.state = snap.running ? 'live' : 'paused';
    $('runStatus').classList.toggle('is-running', snap.running);
    document.body.dataset.runState = snap.running ? 'live' : 'paused';
    setText('playLabel', snap.running ? 'Pause' : 'Resume');
    $('playToggle').dataset.running = String(snap.running);
    $('playToggle').setAttribute('aria-label', snap.running ? 'Pause simulation' : 'Resume simulation');
    $('speedSelect').value = String(snap.speed);
    currentSpeed = snap.speed;
    simulationRunning = snap.running;
    const oneWayRoads = data.streets.filter((street) => street.oneWay).length;
    setText('mapSummary', `${data.streets.length} streets · ${oneWayRoads} one-way links · ${fmt(snap.metrics.active)} vehicles`);
    setText('selectedStreetLabel', selectedStreetId ? `${selectedStreetId} selected` : 'Select a street to explore');
    $('clearStreet').hidden = !selectedStreetId;
    const road = currentRoad(snap);
    updateCrossingControls(snap);
    updateSurfaceWeatherButtons(road || null);
    $('demandRange').value = String(snap.demand);
    updateDemandDisplay(snap.demand);
    updateDemandProfile(snap);
    $('controllerMode').value = selectedControllerId;
    $('externalControllerOption').disabled = !mlControl.hasExternalModel();
    const controllerNotes = {
      adaptive: 'Adaptive timing uses built-in queue rules. It is a heuristic baseline, not a trained model.',
      fixed: 'Fixed timing uses an 18-second green proposal. Run with matching scenarios and duration to compare.',
      'queue-baseline': 'Queue-aware AI baseline: a hand-written heuristic allocates green within legal bounds. It is not trained ML.',
      external: 'A registered external model proposes green duration. The simulator still applies legal timing bounds and transitions.'
    };
    setText('controllerNote', controllerNotes[selectedControllerId]);
    const roadDirection = road?.flyover ? ' · one-way flyover' : road?.oneWay ? ' · one-way entry' : '';
    const surface = road ? ` · ${road.surfaceWeather || 'clear'} surface` : '';
    const incident = snap.incidents?.find((item) => item.streetId === selectedStreetId);
    const condition = road?.workClosed ? 'Closed for roadwork' : road?.closed ? 'Closed' : road?.bikeOnly ? 'Bikes only'
      : road?.breakdown ? `Breakdown in ${incident?.reverse ? 'reverse' : 'forward'} lane`
        : road?.breakdownRecovering ? 'Clearing queue after breakdown' : 'Open to traffic';
    setText('roadStatus', road ? `${road.id}${roadDirection}${surface} · ${condition}` : 'Choose a street');
    $('roadBreakdownTiming').hidden = !incident;
    if (incident) setText('roadBreakdownTiming', breakdownTiming(incident));
    const craneCount = road?.craneCount || 0;
    setText('roadCount', road ? `${fmt(road.count)}${craneCount ? ` · ${fmt(craneCount)} crane${craneCount === 1 ? '' : 's'}` : ''}` : '—');
    setText('roadQueue', road ? `${fmt(road.queue)} waiting` : '—');
    for (const [id, key] of [['roadClosed', 'closed'], ['roadBreakdown', 'breakdown'], ['roadBikeOnly', 'bikeOnly']]) {
      $(id).checked = roadSwitchValue(road, key);
      $(id).disabled = !road;
    }
    $('addTraffic').disabled = !road;
    updateRoadworkSummary(snap);
    setText('throughput', `${Math.round(snap.metrics.throughput)} / min`);
    setText('totalArrived', fmt(snap.metrics.totalArrived));
    const episode = mlControl.getSummary();
    const activeTripWait = snap.vehicles.reduce((sum, vehicle) => sum + Math.max(0, Number(vehicle.runWaitTime ?? vehicle.waitTime) || 0), 0);
    const completedMean = hasDisplayAverage
      ? `${Math.round(metrics.avgWait)}s (${waitSampleCount}/${waitSampleLimit} latest completed trips · ${lastCompletionAge})`
      : metrics.active ? 'waiting for completed trips' : 'no active traffic';
    setText('mlDataIndicator', `${episode.transitionCount} transitions · ${episode.completedTransitionCount} scored`);
    setText('mlDataSummary', `Completed-trip rolling mean: ${completedMean}. In-network accumulated wait is ${Math.round(activeTripWait)} vehicle-seconds. ${fmt(metrics.queued)} vehicles are queued. Episode reward: ${episode.cumulativeReward.toFixed(2)}.`);
    updateInspector(snap);
    updateEvents(snap);
  }

  function updateEvents(snap) {
    const recent = snap.events.slice(-6).reverse();
    const key = recent.map((e) => `${e.time}:${e.text}`).join('|');
    if (key === lastEventKey) return;
    lastEventKey = key;
    const list = $('eventList'); list.replaceChildren();
    if (!recent.length) {
      const li = document.createElement('li'); li.textContent = 'Network ready. Add a scenario to see what changes.'; list.appendChild(li);
    }
    for (const event of recent) {
      const li = document.createElement('li'); li.className = `event event-${event.type}`;
      const time = document.createElement('time'); time.textContent = clock(event.time);
      const detail = document.createElement('span'); detail.textContent = event.text;
      li.append(time, detail); list.appendChild(li);
    }
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  function chartNode(tag, attrs) {
    const el = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }
  function updateChart(snap = engine.getSnapshot()) {
    const history = snap.history.slice(-60);
    const chart = $('historyChart');
    chart.replaceChildren();
    const chartWidth = Math.max(260, Math.round(chart.getBoundingClientRect().width || 800));
    const right = chartWidth - 16;
    chart.setAttribute('viewBox', `0 0 ${chartWidth} 180`);
    $('chartEmpty').hidden = history.length > 1;
    if (history.length < 2) return;
    const max = Math.max(10, ...history.map((h) => h.active));
    const x = (i) => 44 + i / Math.max(1, history.length - 1) * (right - 44);
    const y = (v) => 146 - v / max * 120;
    [0, .5, 1].forEach((fraction) => {
      const yy = y(max * fraction);
      chart.appendChild(chartNode('line', { x1: 44, x2: right, y1: yy, y2: yy, class: 'chart-grid' }));
      const label = chartNode('text', { x: 32, y: yy + 4, 'text-anchor': 'end', class: 'chart-label' });
      label.textContent = String(Math.round(max * fraction)); chart.appendChild(label);
    });
    for (const [field, cls] of [['active', 'chart-active'], ['queued', 'chart-queued']]) {
      chart.appendChild(chartNode('polyline', { points: history.map((h, i) => `${x(i).toFixed(1)},${y(h[field]).toFixed(1)}`).join(' '), class: cls, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    [0, history.length - 1].forEach((i) => {
      const label = chartNode('text', { x: x(i), y: 174, 'text-anchor': i ? 'end' : 'start', class: 'chart-label' });
      label.textContent = clock(history[i].time); chart.appendChild(label);
    });
  }

  function showComparison(report) {
    const container = $('comparisonResults');
    container.replaceChildren();
    const labels = new Map(report.controllers.map(controller => [controller.id, controller.label]));
    const number = (value, suffix = '') => Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '—';
    for (const scenario of report.scenarios) {
      const title = document.createElement('h4');
      title.textContent = `${scenario.label} · ${scenario.demand.toFixed(1)}× demand`;
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headings = document.createElement('tr');
      for (const label of ['Strategy', 'Avg. queued', 'Trips completed', 'Completed trip wait', 'Unfinished wait total', 'Waiting to enter', 'Avg. pedestrians waiting', 'Runs']) {
        const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; headings.appendChild(th);
      }
      head.appendChild(headings); table.appendChild(head);
      const body = document.createElement('tbody');
      for (const summary of report.summaries.filter(item => item.scenarioId === scenario.id)) {
        const row = document.createElement('tr');
        const metrics = summary.metrics || {};
        for (const value of [labels.get(summary.controllerId) || summary.controllerId, number(metrics.averageQueue), number(metrics.completedTrips), number(metrics.completedTripWaitSeconds, ' s'), number(metrics.unfinishedWaitSeconds, ' s'), number(metrics.boundaryQueued), number(metrics.averagePedestrianQueue), `${summary.successfulSeeds}/${summary.totalSeeds}`]) {
          const td = document.createElement('td'); td.textContent = value; row.appendChild(td);
        }
        body.appendChild(row);
      }
      table.appendChild(body); container.append(title, table);
    }
    const explanation = document.createElement('p');
    explanation.className = 'weather-help';
    explanation.textContent = `Values are averages across ${report.seeds.length} seeds over ${Math.round(report.durationSeconds / 60)} simulated minutes per run. Completed-trip wait excludes unfinished journeys; vehicles waiting outside the network are listed separately. Arrival requests match for the same scenario and seed; later incidents may differ.`;
    container.appendChild(explanation);
    container.hidden = false;
  }

  on('compareStrategies', 'click', async () => {
    const button = $('compareStrategies');
    if (!window.TrafficEvaluation) {
      setText('comparisonStatus', 'Comparison could not load. Refresh the page and try again.');
      return;
    }
    button.disabled = true;
    comparisonRunning = true;
    $('comparisonResults').hidden = true;
    comparisonReport = null;
    try {
      const evaluation = window.TrafficEvaluation;
      const current = evaluation.scenarioFromSnapshot(engine.getSnapshot(), { id: 'current', label: 'Current settings' });
      const alternateDemand = current.demand > 0 && current.demand < 3 ? Math.min(3, current.demand * 1.5) : 1;
      const second = { ...current, id: 'alternate', label: current.demand > 0 && current.demand < 3 ? 'Busier demand' : 'Typical demand', demand: alternateDemand };
      setText('comparisonStatus', 'Preparing comparison…');
      const report = await evaluation.run(data, {
        scenarios: [current, second],
        externalModel: registeredModel,
        onProgress: progress => setText('comparisonStatus', `Running comparison: ${progress.completedRuns} of ${progress.totalRuns} runs complete.`)
      });
      comparisonReport = report;
      showComparison(report);
      const failures = report.results.filter(result => result.status !== 'complete').length;
      setText('comparisonStatus', failures ? `Comparison complete with ${failures} failed run${failures === 1 ? '' : 's'}; see the exported data for details.` : `Comparison complete.${report.externalModelIncluded ? ' Connected model included.' : ' No trained model was connected.'}`);
    } catch (error) {
      setText('comparisonStatus', `Comparison failed: ${error.message || error}`);
    } finally {
      comparisonRunning = false;
      button.disabled = false;
    }
  });

  on('exportButton', 'click', () => {
    const payload = {
      ...engine.exportRun(),
      mlDataset: mlControl.exportDataset(),
      mlEpisodeSummary: mlControl.getSummary(),
      strategyComparison: comparisonReport
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `signal-studio-${Math.floor(engine.getSnapshot().time)}s.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Run and ML transition data exported as JSON.');
  });

  window.signalStudio.connectController = (fn) => {
    const result = mlControl.registerExternalModel(fn);
    if (result?.ok === false) return announce(result.message);
    registeredModel = typeof fn === 'function' ? fn : null;
    if (!comparisonRunning) setText('comparisonStatus', registeredModel ? 'Ready to compare, including the connected model.' : 'Ready to compare the three rules-based strategies.');
    if (typeof fn === 'function') {
      mlControl.setPolicy('external');
      engine.setMode('custom');
      selectedControllerId = 'external';
      $('externalControllerOption').disabled = false;
      announce('External model connected and activated. It must return { holdSeconds }.');
    } else {
      engine.setMode('adaptive');
      selectedControllerId = 'adaptive';
      mlControl.setRunController('adaptive_rules');
      announce('External model disconnected; adaptive rules selected.');
    }
    const snapshot = engine.getSnapshot();
    rememberScenarioAction(typeof fn === 'function' ? 'External model activated' : 'External model disconnected', snapshot.time);
    refreshUi(snapshot);
    renderMap(snapshot);
  };
  window.signalStudio.registerMLModel = window.signalStudio.connectController;
  window.signalStudio.setControllerMode = (mode) => chooseController(mode);

  function captureMotion(motion) {
    motionSnapshot = motion;
    map.setMotion(motion);
  }

  function renderMap(snapshot = engine.getSnapshot(), useLatestMotion = true) {
    // The dashboard snapshot rounds to tenths; motion keeps exact quarter ticks.
    if (useLatestMotion || !motionSnapshot || Math.abs(motionSnapshot.time - snapshot.time) > .051) {
      const latest = engine.getMotionSnapshot();
      stepRemainder = latest.stepRemainder;
      captureMotion(latest);
    }
    mlControl.observeSnapshot(snapshot);
    map.render(snapshot, {
      selectedStreetId, selectedVehicleId, selectedCrossingId,
      showCounts: $('showCounts').checked,
      showSignals: $('showSignals').checked,
      showLabels: $('showLabels').checked
    }, motionSnapshot);
    map.animate(stepRemainder / motionSnapshot.stepSeconds);
  }
  populateRoads();
  populateCrossings();
  renderWeatherRoads();
  setTheme(theme);
  refreshUi();
  updateChart();
  renderMap();
  let previous;
  document.addEventListener('visibilitychange', () => { previous = undefined; });
  function frame(now) {
    const delta = previous === undefined || document.hidden ? 0 : Math.min((now - previous) / 1000, 0.15);
    previous = now;
    if (delta > 0 && simulationRunning) stepRemainder = engine.step(delta * currentSpeed, captureMotion);
    const updateMap = simulationRunning && now - lastMap >= 100;
    const updateUi = now - lastUi >= 250;
    const updateHistory = now - lastChart >= 1500;
    if (updateMap || updateUi || updateHistory) {
      const snapshot = engine.getSnapshot();
      if (updateMap) { renderMap(snapshot, false); lastMap = now; }
      if (updateUi) { refreshUi(snapshot); lastUi = now; }
      if (updateHistory) { updateChart(snapshot); lastChart = now; }
    }
    map.animate(stepRemainder / motionSnapshot.stepSeconds);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
