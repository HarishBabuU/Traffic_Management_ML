import Section from './Section';
import StatusBadge from './StatusBadge';
import { analysisMessageFor } from '../services/controlCenter';
import { MAP_PROVIDERS } from '../services/locationProviders';

const EXAMPLE_TRIPS = [
  { origin: 'Chennai', destination: 'Madurai' },
  { origin: 'Madurai', destination: 'Dindigul' },
  { origin: 'Chennai', destination: 'Rameswaram' },
];

/**
 * Command Centre Layer 0 — the journey box.
 *
 * Locations are plain user-provided text (the assistant can also fill them via
 * SET_TRIP). On "Analyze Route" the parent resolves them through the real
 * geocoder + router and reports status back here as `analysisStatus`. The
 * example trips are real, geocodable places — not invented data.
 *
 * Inputs are fully controlled by the parent, so inputs here stay the single
 * source of truth for the whole trip flow.
 */
export default function TripPlanningSection({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  onAnalyze,
  trip,
  analysisStatus = 'idle',
  locationCard = null,
  originFromLocation = false,
  onUseLocation,
  onOpenVoice,
  geocodeCandidates = [],
  onPickGeocodeCandidate,
  docked = false,
}) {
  const canAnalyze = destination.trim() !== '';
  const busy = analysisStatus === 'geocoding' || analysisStatus === 'routing';
  const ready = analysisStatus === 'ready';
  const pending = analysisStatus !== 'idle' && analysisStatus !== 'ready';
  const locationLive = !!(locationCard && locationCard.coords);
  const ambiguous = analysisStatus === 'geocode-ambiguous' && geocodeCandidates.length > 0;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!canAnalyze || busy) return;
    onAnalyze(origin, destination);
  };

  return (
    <div id="trip" className={`trip-panel-card${docked ? ' trip-panel-docked' : ''}`}>
      <div className="trip-panel-header">
        <div className="trip-title-row">
          <span className="trip-icon" aria-hidden="true">📍</span>
          <h2 className="trip-panel-title">Where do you want to go?</h2>
        </div>
        {locationLive && !originFromLocation ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm use-location-chip assistant-prompt-chip"
            onClick={onUseLocation}
            title="Use current GPS position as origin"
          >
            📍 Use my location
          </button>
        ) : null}
      </div>

      {locationCard && originFromLocation ? (
        <div className="location-quick-badge" aria-live="polite">
          <StatusBadge status="LIVE" note="Origin: Current Location" />
        </div>
      ) : null}

      {locationLive ? (
        <p
          className={`location-accuracy-note${locationCard.isApproximate ? ' location-accuracy-approximate' : ''}`}
          aria-live="polite"
        >
          {locationCard.note}
        </p>
      ) : locationCard && locationCard.note && locationCard.status !== 'STATIC' ? (
        <p className="location-accuracy-note" aria-live="polite">
          {locationCard.note}
        </p>
      ) : null}

      {trip && docked ? (
        <div className="trip-summary-chip" aria-live="polite">
          <span className="trip-summary-pair">
            {trip.origin || origin} <span aria-hidden="true">→</span> {trip.destination || destination}
          </span>
          <span
            className={`ls-chip${analysisStatus === 'ready' ? ' ls-live' : ' ls-mock'}`}
          >
            {analysisStatus === 'ready' ? 'ANALYSIS READY' : String(analysisStatus).toUpperCase()}
          </span>
        </div>
      ) : null}

      <form className="trip-form" onSubmit={handleSubmit} aria-label="Plan a trip">
        <div className="trip-inputs-stack">
          <div className="trip-field-group">
            <span className="field-marker origin-marker" aria-hidden="true">●</span>
            <div className="trip-field">
              <label htmlFor="trip-origin">Origin</label>
              <input
                id="trip-origin"
                type="text"
                value={origin}
                onChange={(e) => onOriginChange(e.target.value)}
                placeholder="Current location or city place"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="trip-inputs-divider" aria-hidden="true">
            <span className="divider-line"></span>
            <span className="divider-arrow">↓</span>
          </div>

          <div className="trip-field-group">
            <span className="field-marker dest-marker" aria-hidden="true">▼</span>
            <div className="trip-field">
              <label htmlFor="trip-destination">Destination</label>
              <input
                id="trip-destination"
                type="text"
                value={destination}
                onChange={(e) => onDestinationChange(e.target.value)}
                placeholder="Where to? (e.g. Madurai)"
                autoComplete="off"
              />
            </div>
          </div>
        </div>

        <div className="trip-actions-row">
          <button
            type="submit"
            className="btn btn-primary trip-submit-btn"
            disabled={!canAnalyze || busy}
          >
            {busy
              ? analysisStatus === 'geocoding'
                ? 'Resolving...'
                : 'Routing...'
              : 'Analyze Route'}
          </button>
          {onOpenVoice ? (
            <button
              type="button"
              className="btn btn-ghost trip-voice-btn"
              onClick={onOpenVoice}
              aria-label="Use voice command to plan trip"
              title="Speak destination"
            >
              🎙️ Voice
            </button>
          ) : null}
        </div>

        {ambiguous ? (
          <div className="geocode-candidates" role="group" aria-label="Matching locations">
            <span className="trip-hint">Matching locations — pick one:</span>
            {geocodeCandidates.map((candidate, index) => (
              <button
                key={`${candidate.name}-${candidate.lat}-${candidate.lon}-${index}`}
                type="button"
                className="assistant-prompt-chip geocode-candidate-chip"
                disabled={busy}
                data-geocode-candidate={candidate.name}
                onClick={() => onPickGeocodeCandidate(candidate)}
                title={candidate.region || candidate.name}
              >
                {candidate.name}
                {candidate.region ? <span className="geocode-candidate-region"> — {candidate.region}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        {docked ? null : (
          <div className="trip-examples" aria-label="Example trips">
            <span className="trip-hint">Quick trips:</span>
            {EXAMPLE_TRIPS.map((ex) => (
              <button
                key={`${ex.origin}-${ex.destination}`}
                type="button"
                className="assistant-prompt-chip trip-example-chip"
                disabled={busy}
                onClick={() => onAnalyze(ex.origin, ex.destination)}
              >
                {ex.origin} → {ex.destination}
              </button>
            ))}
          </div>
        )}

        {pending ? (
          <div className="trip-status-line" aria-live="polite">
            <span className="status-line">{analysisMessageFor(analysisStatus)}</span>
          </div>
        ) : null}
      </form>
    </div>
  );
}