import { useRef, useState } from "react";
import { gradeUpload } from "../lib/api";

type Props = { onGraded: (id: string) => void };

/**
 * Three inputs, because a marking run has three documents. Only the student
 * answer is required: leaving the other two empty marks against the bundled
 * question paper and marking scheme, which is what makes a one-file demo work.
 */
export function Uploader({ onGraded }: Props) {
  const student = useRef<HTMLInputElement>(null);
  const questionPaper = useRef<HTMLInputElement>(null);
  const modelAnswer = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const answer = student.current?.files?.[0];
    if (!answer) {
      setError("Choose a student answer PDF to mark.");
      return;
    }

    setError(null);
    try {
      setBusy("Uploading…");
      const { id } = await gradeUpload(answer, {
        questionPaper: questionPaper.current?.files?.[0],
        modelAnswer: modelAnswer.current?.files?.[0],
      });
      onGraded(id);
      for (const input of [student, questionPaper, modelAnswer]) {
        if (input.current) input.current.value = "";
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="uploader">
      <div className="uploader-inputs">
        <label>
          <span>Question paper <em>optional</em></span>
          <input ref={questionPaper} type="file" accept="application/pdf" disabled={!!busy} />
        </label>
        <label>
          <span>Model answer / rubric <em>optional</em></span>
          <input ref={modelAnswer} type="file" accept="application/pdf" disabled={!!busy} />
        </label>
        <label>
          <span>Student answer <strong>required</strong></span>
          <input ref={student} type="file" accept="application/pdf" disabled={!!busy} />
        </label>
      </div>

      <button type="button" className="grade-button" disabled={!!busy} onClick={() => void submit()}>
        {busy ?? "Grade"}
      </button>

      {busy && <span className="muted">Extracting, rendering and marking…</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
