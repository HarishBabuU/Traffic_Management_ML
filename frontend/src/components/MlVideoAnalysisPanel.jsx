import { useRef, useState } from 'react';
import StatusBadge from './StatusBadge';
import {
  ACCEPTED_VIDEO_ATTRIBUTE,
  ACCEPTED_VIDEO_EXTENSIONS,
  analyzeVideo,
  apiBaseUrl,
  validateVideoFile,
} from '../services/mlApi';

/**
 * Step 4 — live ML analysis panel.
 *
 * Uploads a user-selected video to the project's own FastAPI backend, which runs
 * the EXISTING YOLOv8n + ByteTrack pipeline, and renders exactly what the API
 * returned. Nothing is computed, averaged or substituted here: a field the
 * backend did not return is shown as "unavailable".
 *
 * This is a separate, additive panel. It does not change the recorded-demo CCTV
 * registry, its playback, its evidence, or any map/routing/weather/assistant
 * behaviour.
 */

const COUNT_KEYS = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];

function value(v, suffix = '') {
  return v === null || v === undefined || v === '' ? 'unavailable' : `${v}${suffix}`;
}

function CountList({ counts, emptyLabel }) {
  if (!counts) {
    return <span className="section-sub">{emptyLabel}</span>;
  }
  return (
    <ul className="cctv-meta">
      {COUNT_KEYS.map((key) => (
        <li key={key}>
          <span className="stat-label">{key}</span>
          <span>{value(counts[key] === undefined ? null : counts[key])}</span>
        </li>
      ))}
    </ul>
  );
}

export default function MlVideoAnalysisPanel({ env = import.meta.env, fetchImpl = null }) {
  const [status, setStatus] = useState('idle');
  const [fileName, setFileName] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const busy = status === 'uploading' || status === 'processing';

  const run = async (file) => {
    const check = validateVideoFile(file);
    if (!check.ok) {
      setStatus('error');
      setError(check.message);
      setResult(null);
      return;
    }
    setFileName(typeof file.name === 'string' ? file.name : 'selected video');
    setStatus('uploading');
    setError(null);
    setResult(null);

    const outcome = await analyzeVideo(file, {
      env,
      fetchImpl: fetchImpl || undefined,
    });

    if (!outcome.ok) {
      setStatus('error');
      setError(outcome.message);
      return;
    }
    setStatus('ready');
    setResult(outcome.analysis);
  };

  const onSelect = (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) run(file);
    // Allow re-selecting the same file after an error.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="panel ml-analysis-panel" aria-labelledby="ml-analysis-title">
      <header className="section-head">
        <div>
          <h3 id="ml-analysis-title">On-demand video analysis</h3>
          <p className="section-sub">
            Runs the project&apos;s own YOLOv8n + ByteTrack pipeline on a video you
            select, through the FastAPI ML backend. Every value below comes from
            the backend response.
          </p>
        </div>
        <div className="investigation-badges">
          <StatusBadge
            status={busy ? 'LIVE' : status === 'ready' ? 'LIVE' : 'STATIC'}
            note={busy ? 'Processing' : status === 'ready' ? 'ML result' : 'Idle'}
          />
        </div>
      </header>

      <div className="cctv-meta">
        <li>
          <span className="stat-label">Backend</span>
          <span>{apiBaseUrl(env)}</span>
        </li>
        <li>
          <span className="stat-label">Accepted formats</span>
          <span>{ACCEPTED_VIDEO_EXTENSIONS.join(', ')}</span>
        </li>
      </div>

      <div className="route-chip">
        <strong>Select a video:</strong>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_VIDEO_ATTRIBUTE}
          onChange={onSelect}
          disabled={busy}
          data-testid="ml-video-input"
          aria-label="Select a video for ML analysis"
        />
      </div>

      <p className="section-sub" aria-live="polite" data-testid="ml-analysis-status">
        {busy
          ? `Uploading and processing${fileName ? ` ${fileName}` : ''} — this runs the real YOLOv8n + ByteTrack pipeline and can take a while.`
          : status === 'ready' && fileName
            ? `Analysed ${fileName}.`
            : 'No video analysed yet.'}
      </p>

      {error ? (
        <p className="empty-state" role="alert" data-testid="ml-analysis-error">
          {error}
        </p>
      ) : null}

      {status === 'ready' && result ? (
        <div data-testid="ml-analysis-result">
          <ul className="cctv-meta">
            <li>
              <span className="stat-label">Video</span>
              <span>{value(result.videoName)}</span>
            </li>
            <li>
              <span className="stat-label">Model</span>
              <span>{value(result.model)}</span>
            </li>
            <li>
              <span className="stat-label">Tracker</span>
              <span>{value(result.tracker)}</span>
            </li>
            <li>
              <span className="stat-label">Resolution</span>
              <span>{value(result.resolution)}</span>
            </li>
            <li>
              <span className="stat-label">FPS</span>
              <span>{value(result.fps)}</span>
            </li>
            <li>
              <span className="stat-label">Duration</span>
              <span>{value(result.durationSeconds === null ? null : `${result.durationSeconds} s`)}</span>
            </li>
            <li>
              <span className="stat-label">Frames processed</span>
              <span>{value(result.framesProcessed)}</span>
            </li>
            <li>
              <span className="stat-label">Total frames</span>
              <span>{value(result.totalFrames)}</span>
            </li>
            <li>
              <span className="stat-label">Unique tracks</span>
              <span>{value(result.uniqueTracks)}</span>
            </li>
            <li>
              <span className="stat-label">Conservative tracks</span>
              <span>{value(result.conservativeTracks)}</span>
            </li>
            <li>
              <span className="stat-label">Activity rate</span>
              <span>
                {value(result.activityRate === null ? null : `${result.activityRate} ids/sec`)}
              </span>
            </li>
            <li>
              <span className="stat-label">Traffic condition</span>
              <span>{value(result.trafficCondition)}</span>
            </li>
            <li>
              <span className="stat-label">Processing time</span>
              <span>{value(result.elapsedSeconds === null ? null : `${result.elapsedSeconds} s`)}</span>
            </li>
          </ul>

          <h4>Vehicle counts (all tracks)</h4>
          <CountList counts={result.vehicleCounts} emptyLabel="Counts not returned by the backend." />

          <h4>Vehicle counts (conservative tracks)</h4>
          <CountList
            counts={result.conservativeCounts}
            emptyLabel="Conservative counts not returned by the backend."
          />

          <p className="footnote-note">
            Traffic condition is an activity-rate classification produced by the
            backend from distinct tracked vehicles per second of footage. It is
            not a ground-truth congestion measurement.
          </p>
        </div>
      ) : null}
    </section>
  );
}