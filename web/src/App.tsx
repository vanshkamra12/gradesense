import { useCallback, useEffect, useState } from "react";
import { HistoryList } from "./components/HistoryList";
import { PageViewer } from "./components/PageViewer";
import { ResultPanel } from "./components/ResultPanel";
import { Uploader } from "./components/Uploader";
import { fetchHistory, fetchResult, pdfUrl, type HistoryEntry, type StoredResult } from "./lib/api";

export default function App() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [current, setCurrent] = useState<StoredResult | null>(null);
  const [selectedCriterionId, setSelectedCriterionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(() => {
    fetchHistory().then(setHistory, (cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(refreshHistory, [refreshHistory]);

  const open = useCallback((id: string) => {
    setSelectedCriterionId(null);
    fetchResult(id).then(setCurrent, (cause: unknown) => setError(String(cause)));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>GradeSense</h1>
        <Uploader
          onGraded={(id) => {
            refreshHistory();
            open(id);
          }}
        />
      </header>

      {error && <p className="error">{error}</p>}

      <div className="app-body">
        <main className="viewer">
          {current ? (
            <PageViewer
              pdfHref={pdfUrl(current.id)}
              pages={current.document.pages}
              annotations={current.annotations}
              selectedCriterionId={selectedCriterionId}
              onSelectCriterion={setSelectedCriterionId}
            />
          ) : (
            <p className="muted empty">
              Upload a student answer PDF, or open a past grading from the list.
            </p>
          )}
        </main>

        <aside className="sidebar">
          {current ? (
            <ResultPanel
              stored={current}
              selectedCriterionId={selectedCriterionId}
              onSelectCriterion={setSelectedCriterionId}
            />
          ) : null}

          <section className="panel">
            <h3 className="section-heading">History</h3>
            <HistoryList entries={history} currentId={current?.id ?? null} onOpen={open} />
          </section>
        </aside>
      </div>
    </div>
  );
}
