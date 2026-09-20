export default function ProvenanceSection() {
  return (
    <section id="provenance" className="panel provenance-panel">
      <h2>Data provenance &amp; limitations</h2>
      <ul className="provenance-list">
        <li>
          <strong>Traffic analysis</strong> is derived from a historical processed video dataset
          (Phases 8 &amp; 9A). It is NOT real-time traffic.
        </li>
        <li>
          <strong>Traffic condition labels</strong> (LOW / MODERATE / HEAVY / CONGESTED) are
          dataset-relative activity classifications — not real-world congestion, travel time or
          speed.
        </li>
        <li>
          <strong>Weather</strong> is a point-in-time observation retrieved from a live provider
          during processing. It is NOT a live stream.
        </li>
        <li>
          <strong>Road conditions</strong> are explicit prototype/mock records (TEST-RD-*), not
          real-world observations.
        </li>
        <li>
          <strong>Road suitability scores</strong> are prototype explainable scores built from
          fictional roads and mocked layers.
        </li>
        <li>
          <strong>Route recommendations</strong> are prototype/mock route outputs (MOCK-ROAD-*)
          and are NOT real navigation.
        </li>
      </ul>
      <p className="footnote-note">
        This prototype is not calibrated for real-world traffic engineering, navigation, or
        safety decisions. All MOCK, STATIC, LIVE, MANUAL and UNKNOWN labels are truthful and
        identify the actual source of each data point.
      </p>
    </section>
  );
}