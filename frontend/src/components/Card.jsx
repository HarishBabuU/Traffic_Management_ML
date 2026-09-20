import StatusBadge from './StatusBadge';

export default function Card({ title, value, sub, status, children }) {
  return (
    <article className="card">
      <header className="card-head">
        <h3>{title}</h3>
        {status ? <StatusBadge status={status.status} note={status.note} /> : null}
      </header>
      <div className="card-value">{value}</div>
      {sub ? <p className="card-sub">{sub}</p> : null}
      {children ? <div className="card-body">{children}</div> : null}
    </article>
  );
}