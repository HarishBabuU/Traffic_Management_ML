import { useMemo, useState } from 'react';
import Section from './Section';
import DataTable from './DataTable';
import { BarChart, HBarChart } from './Charts';
import { getTraffic, getLevel8 } from '../services/dataService';
import { displayValue } from '../utils/formatting';

const CLASSES = [
  { key: 'car', valueMetric: 'class_car_stable_count', label: 'Car' },
  { key: 'motorcycle', valueMetric: 'class_motorcycle_stable_count', label: 'Motorcycle' },
  { key: 'bus', valueMetric: 'class_bus_stable_count', label: 'Bus' },
  { key: 'truck', valueMetric: 'class_truck_stable_count', label: 'Truck' },
  { key: 'bicycle', valueMetric: 'class_bicycle_stable_count', label: 'Bicycle' },
];

const VIZ_IMAGES = [
  { src: 'level8/traffic_activity_over_time.png', alt: 'Traffic activity over time per video', caption: 'Traffic activity over time (Phase 8)' },
  { src: 'level8/vehicle_count_by_class.png', alt: 'Vehicle count by class', caption: 'Vehicle count by class (Phase 8)' },
  { src: 'level8/vehicle_count_by_video.png', alt: 'Vehicle count by video', caption: 'Vehicle count by video (Phase 8)' },
  { src: 'level8/class_distribution.png', alt: 'Class distribution', caption: 'Class distribution (Phase 8)' },
  { src: 'level8/class_by_video.png', alt: 'Vehicle class counts by video', caption: 'Class counts by video (Phase 8)' },
  { src: 'level8/conservative_vs_corrected.png', alt: 'Conservative vs corrected counts', caption: 'Conservative vs corrected counts (Phase 8)' },
  { src: 'level8/track_duration_distribution.png', alt: 'Track duration distribution', caption: 'Track duration distribution (Phase 8)' },
  { src: 'level8/level8_visual_summary.png', alt: 'Level 8 visual summary', caption: 'Level 8 visual summary' },
];

export default function TrafficSection() {
  const traffic = getTraffic();
  const level8 = getLevel8();

  const [video, setVideo] = useState('all');
  const [cls, setCls] = useState('all');

  const videos = useMemo(
    () => level8.classByVideo.map((r) => r.video),
    [level8.classByVideo]
  );

  const overviewRows = useMemo(
    () =>
      video === 'all'
        ? traffic.overview
        : traffic.overview.filter((r) => r.video === video),
    [video, traffic.overview]
  );

  const intervalRows = useMemo(
    () =>
      video === 'all'
        ? traffic.intervals
        : traffic.intervals.filter((r) => r.video === video),
    [video, traffic.intervals]
  );

  const classCount = (key) => {
    if (video === 'all') {
      const def = CLASSES.find((c) => c.key === key);
      return level8.metrics[def.valueMetric] || 'UNKNOWN';
    }
    const row = level8.classByVideo.find((r) => r.video === video);
    return row ? row[key] ?? 'UNKNOWN' : 'UNKNOWN';
  };

  const classChartItems = useMemo(
    () =>
      CLASSES.map((c) => ({
        label: c.label,
        value: displayValue(level8.metrics[c.valueMetric]),
      })),
    [level8.metrics]
  );

  const videoChartItems = useMemo(
    () =>
      level8.classByVideo.map((r) => ({
        label: r.video.replace(/\.mp4$/, ''),
        value: displayValue(r.total),
      })),
    [level8.classByVideo]
  );

  const activityChartItems = useMemo(
    () =>
      traffic.overview.map((r) => ({
        label: r.video.replace(/\.mp4$/, ''),
        value: Number(r.activity_rate_ids_per_sec).toFixed(2),
        sub: String(r.traffic_condition || ''),
      })),
    [traffic.overview]
  );

  const correctedConservativeItems = useMemo(
    () => [
      { label: 'Corrected vehicles', value: displayValue(level8.metrics.total_corrected_identities) },
      { label: 'Conservative count', value: displayValue(level8.metrics.total_conservative_identities) },
    ],
    [level8.metrics]
  );

  const classTableColumns = useMemo(() => {
    const base = [{ key: 'video', label: 'Video' }];
    if (cls === 'all') {
      CLASSES.forEach((c) => base.push({ key: c.key, label: c.label }));
      base.push({ key: 'total', label: 'Total' });
    } else {
      base.push({ key: cls, label: CLASSES.find((c) => c.key === cls).label });
      base.push({ key: 'total', label: 'Total' });
    }
    return base;
  }, [cls]);

  const overviewColumns = [
    { key: 'video', label: 'Video' },
    { key: 'traffic_condition', label: 'Activity' },
    { key: 'activity_rate_ids_per_sec', label: 'Activity rate (ids/s)' },
    { key: 'support_margin_to_boundary', label: 'Margin to boundary' },
  ];

  const intervalColumns = [
    { key: 'video', label: 'Video' },
    { key: 'interval_seconds', label: 'Interval (s)' },
    { key: 'unique_active_identities', label: 'Active ids' },
    { key: 'trajectory_observations', label: 'Trajectory rows' },
    { key: 'activity_rate_ids_per_sec', label: 'Activity rate (ids/s)' },
    { key: 'traffic_condition', label: 'Activity' },
  ];

  return (
    <Section
      id="traffic"
      title="Traffic Analysis"
      subtitle="Processed from the original traffic videos (historical dataset)"
      status={traffic.status}
    >
      {/* Compact summary — global Phase 8 values, unchanged */}
      <div className="stat-row">
        <div className="stat-chip">
          <span className="stat-label">Total vehicles (corrected)</span>
          <span className="stat-value">{displayValue(level8.metrics.total_corrected_identities)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Conservative count</span>
          <span className="stat-value">{displayValue(level8.metrics.total_conservative_identities)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Videos analysed</span>
          <span className="stat-value">{displayValue(level8.metrics.number_of_videos)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Trajectory rows</span>
          <span className="stat-value">{displayValue(level8.metrics.total_trajectory_rows)}</span>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-bar" role="group" aria-label="Traffic filters">
        <div className="filter-group">
          <span className="filter-label">Video</span>
          <button
            type="button"
            className={`filter-btn${video === 'all' ? ' filter-btn-active' : ''}`}
            onClick={() => setVideo('all')}
          >
            All
          </button>
          {videos.map((v) => (
            <button
              key={v}
              type="button"
              className={`filter-btn${video === v ? ' filter-btn-active' : ''}`}
              onClick={() => setVideo(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-label">Class</span>
          <button
            type="button"
            className={`filter-btn${cls === 'all' ? ' filter-btn-active' : ''}`}
            onClick={() => setCls('all')}
          >
            All
          </button>
          {CLASSES.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`filter-btn${cls === c.key ? ' filter-btn-active' : ''}`}
              onClick={() => setCls(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <p className="filter-scope-note">
        Video filter applies to the activity and interval tables. Class filter only narrows which
        columns appear in the class-counts table — global totals (122 / 108), the summary chips
        and the charts are always the full dataset.
      </p>

      {/* Vehicle class counts (updates with the video filter) */}
      <h3>Vehicle class summary {video === 'all' ? '(all videos)' : `(${video})`}</h3>
      <div className="class-summary">
        {CLASSES.map((c) => (
          <div
            key={c.key}
            className={`class-chip${cls === c.key ? ' class-chip-selected' : ''}`}
          >
            <span className="class-chip-label">{c.label}</span>
            <span className="class-chip-value">{displayValue(classCount(c.key))}</span>
          </div>
        ))}
      </div>

      <h3>Traffic visual summary</h3>
      <div className="charts-grid">
        <div className="chart-panel">
          <h4>Vehicle count by class</h4>
          <BarChart title="Vehicle count by class" items={classChartItems} />
        </div>
        <div className="chart-panel">
          <h4>Vehicle count by video</h4>
          <BarChart title="Vehicle count by video" items={videoChartItems} />
        </div>
        <div className="chart-panel">
          <h4>Traffic activity by video (ids/s)</h4>
          <BarChart title="Traffic activity by video" items={activityChartItems} />
        </div>
        <div className="chart-panel">
          <h4>Corrected vs conservative count</h4>
          <HBarChart title="Corrected vs conservative count" items={correctedConservativeItems} />
        </div>
      </div>
      <p className="section-sub">
        Charts are rendered from the prepared JSON values (Phase 8 / 9A data). Values are
        never hardcoded in the UI.
      </p>

      <h3>Class counts by video</h3>
      <DataTable
        columns={classTableColumns}
        rows={level8.classByVideo}
        emptyMessage="No class data available."
      />

      <h3>Traffic activity per video (dataset-relative)</h3>
      <p className="section-sub">
        Activity labels (LOW / MODERATE / HEAVY / CONGESTED) are relative to this dataset.
        They are NOT real-world congestion, travel time or speed.
      </p>
      <DataTable columns={overviewColumns} rows={overviewRows} emptyMessage="No traffic activity data available." />

      <h3>Interval activity detail</h3>
      <DataTable columns={intervalColumns} rows={intervalRows} emptyMessage="No interval data available." />

      <h3>Visualisations (Phase 8, unchanged copies)</h3>
      <div className="viz-grid">
        {VIZ_IMAGES.map((img) => (
          <figure key={img.src}>
            <img src={img.src} alt={img.alt} loading="lazy" />
            <figcaption>{img.caption}</figcaption>
          </figure>
        ))}
      </div>

      <p className="placeholder-note">
        Filtering only changes what is displayed; the underlying data is never modified.
        Further visualisations and live-data integration are planned for later phases
        (Phase 9F-2 additional parts / Phase 9F-3).
      </p>
    </Section>
  );
}