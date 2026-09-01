import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { annotationsRouter } from "./routes/annotations.js";
import { gradeRouter } from "./routes/grade.js";
import { historyRouter } from "./routes/history.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
// The grade route takes the PDF as the request body.
app.use(express.raw({ type: "application/pdf", limit: "25mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: config.gradeProvider,
    mockMode: config.gradeProvider === "mock" ? config.mockMode : null,
  });
});

app.use(gradeRouter);
app.use(historyRouter);
app.use(annotationsRouter);

app.listen(config.port, () => {
  console.log(`gradesense server listening on http://localhost:${config.port}`);
  console.log(`grade provider: ${config.gradeProvider}`);
});
