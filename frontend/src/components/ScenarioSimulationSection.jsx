import { useEffect, useMemo, useState } from 'react';
import Section from './Section';
import StatusBadge from './StatusBadge';
import {
  SCENARIO_INPUTS,
  BASELINE_INPUTS,
  SCENARIO_SUMMARY,
  runScenario,
  scenarioUiState,
  isMockRoute,
} from '../services/scenarioSimulator';

const int = (arr) =>
  arr.map((level) => (
    <option key={level} value={level}>
      {level === 'UNKNOWN' ? 'UNKNOWN (not known)' : level}
    </option>
  ));

/**
 * Phase 9F-4 Part 6 — Scenario (WHAT-IF) simulation.
 *
 * A deterministic static-model demonstration, explicitly NOT a real-world
 * traffic prediction. It reuses the documented Phase 9D weighted-layer idea
 * (unknown layers are excluded and known weights renormalised) without touching
 * the Phase 9D engine. If too little is known the panel reports
 * SIMULATION INCOMPLETE instead of inventing a score.
 */
export default function ScenarioSimulationSection({
  trip,
  analysisReady,
  realRoute,
  demoRoute,
  scenarioRequest,
}) {
  const [traffic, setTraffic] = useState('LOW');
  const [weather, setWeather] = useState('CLEAR');
  const [road, setRoad] = useState('LOW');
  const [incident, setIncident] = useState('NONE');
  const [revealed, setRevealed] = useState(false);

  const routeContext = useMemo(
    () => scenarioUiState({ trip, analysisReady, realRoute, demoRoute }),
    [trip, analysisReady, realRoute, demoRoute]
  );

  useEffect(() => {
    if (scenarioRequest && scenarioRequest.traffic) {
      setTraffic(scenarioRequest.traffic);
      setRevealed(true);
    } else if (scenarioRequest) {
      setRevealed(true);
    }
  }, [scenarioRequest]);

  const result = useMemo(
    () => runScenario({ traffic, weather, road, incident }),
    [traffic, weather, road, incident]
  );

  const run = () => setRevealed(true);

  const mockContext = isMockRoute(demoRoute);

  return (
    <Section
      id="scenario"
      title="Scenario Simulation"
      subtitle="WHAT-IF demonstration layer. A deterministic static-model comparison against a documented baseline — it does NOT predict real-world traffic."
      status={{ status: 'SIMULATED', note: 'WHAT-IF · STATIC MODEL · DEMO' }}
    >
      <div className="mock-warning">
        <p className="scenario-banner">{SCENARIO_SUMMARY}</p>
        <StatusBadge status="SIMULATED" note="SIMULATED / WHAT-IF" />
        <StatusBadge status="STATIC" note="STATIC MODEL" />
        <StatusBadge status="MOCK" note="DEMO" />
        <p>
          This simulator is a <strong>static rule-based model</strong> for
          demonstration. It reflects the documented Phase 9D weight rule but is
          fully isolated from the real scoring engine, and its output is{' '}
          <strong>never a real traffic prediction</strong>.
        </p>
      </div>

      <div className="scenario-route-context" aria-live="polite">
        {routeContext.kind === 'real' ? (
          <>
            <StatusBadge status="LIVE" note="Real provider route context" />
            <span className="trip-context-route">
              Simulating the current real route ·{' '}
              {routeContext.realRoute.distanceKm} km · {routeContext.realRoute.durationMin} min
            </span>
          </>
        ) : routeContext.kind === 'mock' ? (
          <>
            <StatusBadge status="MOCK" note="MOCK ROUTE" />
            <span className="trip-context-route">
              No real route exists. The context is the selected Phase 9E{' '}
              <strong>MOCK ROUTE</strong> ({routeContext.demoRoute.route_id}) — a
              fictional demo route that is never drawn on the real map.
            </span>
          </>
        ) : (
          <p className="empty-state">{routeContext.reason}</p>
        )}
      </div>

      <form
        className="scenario-form"
        aria-label="Scenario simulation inputs"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <div className="scenario-inputs">
          <label className="scenario-field">
            <span>Traffic condition</span>
            <select value={traffic} onChange={(e) => setTraffic(e.target.value)}>
              {int(SCENARIO_INPUTS.traffic)}
            </select>
          </label>
          <label className="scenario-field">
            <span>Weather</span>
            <select value={weather} onChange={(e) => setWeather(e.target.value)}>
              {int(SCENARIO_INPUTS.weather)}
            </select>
          </label>
          <label className="scenario-field">
            <span>Road condition</span>
            <select value={road} onChange={(e) => setRoad(e.target.value)}>
              {int(SCENARIO_INPUTS.road)}
            </select>
          </label>
          <label className="scenario-field">
            <span>Incident</span>
            <select value={incident} onChange={(e) => setIncident(e.target.value)}>
              {int(SCENARIO_INPUTS.incident)}
            </select>
          </label>
        </div>
        <div className="trip-actions">
          <button type="submit" className="btn btn-primary">
            Run Simulation
          </button>
          <span className="trip-hint">
            Results update deterministically for the current inputs.
          </span>
        </div>
      </form>

      <div className="scenario-baseline chip-row" aria-label="Documented baseline">
        <StatusBadge status="STATIC" note="Documented baseline" />
        <span className="provider-chip">
          Baseline {result.baseline}/100 · {BASELINE_INPUTS.traffic} traffic ·{' '}
          {BASELINE_INPUTS.weather} weather · {BASELINE_INPUTS.road} road ·{' '}
          {BASELINE_INPUTS.incident} incident
        </span>
      </div>

      {revealed ? (
        <div className="scenario-result" aria-live="polite">
          {result.status === 'INCOMPLETE' ? (
            <div className="scenario-incomplete" role="alert">
              <StatusBadge status="UNKNOWN" note="SIMULATION INCOMPLETE" />
              <p>{result.explanation}</p>
            </div>
          ) : (
            <>
              <div className="scenario-score-grid">
                <div className="scenario-score-card">
                  <span className="stat-label">Baseline</span>
                  <span className="scenario-score-value">{result.baseline}/100</span>
                </div>
                <div className="scenario-score-arrow" aria-hidden="true">
                  →
                </div>
                <div className="scenario-score-card">
                  <span className="stat-label">
                    Scenario ({traffic} traffic · {weather} weather · {road} road · {incident} incident)
                  </span>
                  <span className="scenario-score-value">{result.scenario}/100</span>
                </div>
                <div className="scenario-score-card scenario-score-change">
                  <span className="stat-label">Change</span>
                  <span className={result.change > 0 ? 'scenario-plus' : result.change < 0 ? 'scenario-minus' : 'scenario-neutral'}>
                    {result.change > 0 ? '+' : ''}{result.change}
                  </span>
                </div>
              </div>

              <p className="scenario-explanation">{result.explanation}</p>

              <div className="scenario-layer-list" aria-label="Layer contributions">
                {result.layers.map((layer) => (
                  <div key={layer.key} className="layer-bar-row">
                    <span className="layer-label">
                      {layer.label}
                      {layer.score === null ? (
                        <small className="layer-detail">UNKNOWN — excluded, weighted to 0</small>
                      ) : (
                        <small className="layer-detail">
                          {layer.level} · baseline {layer.baselineScore}/100
                        </small>
                      )}
                    </span>
                    <span className="layer-weight">
                      {layer.score === null
                        ? 'excluded'
                        : `weight ${Math.round(layer.effectiveWeight * 100)}%`}
                    </span>
                    <span className="layer-level">{layer.score === null ? '—' : layer.score}</span>
                  </div>
                ))}
              </div>
              <p className="footnote-note">
                SIMULATED values only. Known weights are renormalised after excluding UNKNOWN
                layers; UNKNOWN is never treated as zero risk. This is a static-model
                demonstration, not a traffic prediction.
              </p>
            </>
          )}
        </div>
      ) : (
        <p className="placeholder-note">
          Set the scenario inputs and press Run Simulation. The result is deterministic.
        </p>
      )}
    </Section>
  );
}