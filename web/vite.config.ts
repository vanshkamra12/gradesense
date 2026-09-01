import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Lets the frontend call /api/... with no base URL and no CORS in dev.
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
