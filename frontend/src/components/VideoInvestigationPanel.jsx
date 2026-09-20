import StatusBadge from './StatusBadge';
import { demoVideoUrl, RECORDED_LABEL, DEMO_LABEL } from '../services/controlCenter';

/**
 * Video investigation view for a demo CCTV resource. The video is a recorded
 * dataset clip and is always labelled "Recorded dataset / simulated CCTV" —
 * never "live CCTV". No detection or tracking is ever run here.
 */
export default function VideoInvestigationPanel({ resource, route, onClose }) {
  return (
    <section
      className="panel investigation-panel"
      aria-labelledby="investigation-title"
    >
      <header className="section-head">
        <div>
          <h3 id="investigation-title">Investigation — {resource.id}</h3>
          <p className="section-sub">{resource.title}</p>
        </div>
        <div className="investigation-badges">
          <StatusBadge status="MOCK" note={DEMO_LABEL} />
          <StatusBadge status="STATIC" note={RECORDED_LABEL} />
        </div>
      </header>

      <div className="investigation-meta">
        <span className="route-chip">
          <strong>Investigation context:</strong>{' '}
          {route ? `demo route ${route.route_id} (MOCK)` : 'selected real trip'}
        </span>
        <span className="route-chip">
          <strong>Related dataset:</strong> {resource.video}
        </span>
        <span className="route-chip">
          <strong>Association:</strong> demo only — no real camera location
        </span>
      </div>

      <figure className="video-frame">
        <video
          controls
          preload="metadata"
          title={resource.video}
          aria-label={`Recorded dataset clip: ${resource.video}. Not live CCTV.`}
        >
          <source src={demoVideoUrl(resource.video)} type="video/mp4" />
          Your browser does not support the video element.
        </video>
        <figcaption className="video-caption">
          Recorded dataset / simulated CCTV — this is a recording from the
          project dataset, NOT a live camera feed.
        </figcaption>
      </figure>

      <div className="investigation-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close investigation
        </button>
      </div>
    </section>
  );
}