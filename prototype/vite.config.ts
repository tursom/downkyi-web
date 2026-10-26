import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        optimization: "optimization.html",
        redesign: "redesign.html",
      },
    },
  },
});
