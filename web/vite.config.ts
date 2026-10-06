import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
  "/api": {
    target: "http://127.0.0.1:4300",
    rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ""),
  },
  "/evidence": {
    target: "http://127.0.0.1:4200",
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: [".up.railway.app"],
    proxy,
  },
});
