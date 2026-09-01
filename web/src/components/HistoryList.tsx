import type { HistoryEntry } from "../lib/api";

type Props = {
  entries: HistoryEntry[];
  currentId: string | null;
  onOpen: (id: string) => void;
};

export function HistoryList({ entries, currentId, onOpen }: Props) {
  if (entries.length === 0) return <p className="muted">Nothing graded yet.</p>;

  return (
    <ul className="history">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className={entry.id === currentId ? "is-current" : ""}
            onClick={() => onOpen(entry.id)}
          >
            <span className="history-score">
              {entry.total}/{entry.maxTotal}
            </span>
            <span className="history-name">{entry.filename}</span>
            <span className="muted">
              {new Date(entry.createdAt).toLocaleString()} · {entry.provider}
              {entry.needsHumanReview && <span className="flag-on"> · review</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
