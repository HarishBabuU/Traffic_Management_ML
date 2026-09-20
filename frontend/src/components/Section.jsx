import StatusBadge from './StatusBadge';

export default function Section({ id, title, subtitle, status, children }) {
  return (
    <section className="section" id={id}>
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="section-sub">{subtitle}</p> : null}
        </div>
        {status ? <StatusBadge status={status.status} note={status.note} /> : null}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}