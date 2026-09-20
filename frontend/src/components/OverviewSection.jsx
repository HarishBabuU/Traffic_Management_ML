import Card from './Card';
import { getOverview } from '../services/dataService';

export default function OverviewSection() {
  const overview = getOverview();
  const cards = [
    overview.totalVehicles,
    overview.conservativeCount,
    overview.trafficCondition,
    overview.weatherImpact,
    overview.roadScore,
    overview.recommendedRoute,
  ];
  return (
    <section className="section" id="overview">
      <header className="section-head">
        <div>
          <h2>Overview</h2>
          <p className="section-sub">
            Main system outputs from the analysed dataset. All MOCK / LIVE / STATIC labels are
            displayed truthfully.
          </p>
        </div>
      </header>
      <div className="cards-grid">
        {cards.map((card) => (
          <Card
            key={card.label}
            title={card.label}
            value={card.value}
            sub={card.sub}
            status={card.status}
          />
        ))}
      </div>
    </section>
  );
}