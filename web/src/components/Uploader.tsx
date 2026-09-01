import { useRef, useState } from "react";
import { gradeUpload } from "../lib/api";

type Props = { onGraded: (id: string) => void };

export function Uploader({ onGraded }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await gradeUpload(file);
      onGraded(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="uploader">
      <input
        ref={input}
        type="file"
        accept="application/pdf"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void submit(file);
        }}
      />
      {busy && <span className="muted">Grading… extracting, rendering and marking.</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
