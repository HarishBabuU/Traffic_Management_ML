import { displayValue } from '../utils/formatting';

export default function DataTable({ columns, rows, emptyMessage = 'No data available' }) {
  if (!rows || rows.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">
          Table: {columns.map((col) => col.label).join(', ')}
        </caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx}>
              {columns.map((col) => (
                <td key={col.key}>{displayValue(row[col.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}