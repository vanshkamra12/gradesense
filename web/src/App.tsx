import { useEffect, useState } from "react";

type Health = { ok: boolean; provider: string; mockMode: string | null };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>GradeSense</h1>
      {error && <p className="error">Server unreachable: {error}</p>}
      {health && (
        <p>
          Server up. Grading provider: <strong>{health.provider}</strong>
          {health.mockMode ? ` (${health.mockMode})` : ""}
        </p>
      )}
      {!health && !error && <p>Checking server…</p>}
    </main>
  );
}
