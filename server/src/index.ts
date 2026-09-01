import cors from "cors";
import express from "express";
import { config } from "./config.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: config.gradeProvider,
    mockMode: config.gradeProvider === "mock" ? config.mockMode : null,
  });
});

app.listen(config.port, () => {
  console.log(`gradesense server listening on http://localhost:${config.port}`);
  console.log(`grade provider: ${config.gradeProvider}`);
});
