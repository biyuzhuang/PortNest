import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 3. @xterm/xterm@6.0.0 的预压缩 ESM 被 esbuild 二次压缩后，会破坏 requestMode
  //    处理器里的枚举初始化（局部声明丢失），导致终端收到 DECRQM 查询（vim 启动
  //    必发）时抛 ReferenceError，write 回调永不执行、轮询永久挂起。禁用 minify
  //    保留 xterm 原始代码即可修复；本地桌面应用的体积增长可忽略。
  build: {
    minify: false,
  },
  // 4. dev 模式下同样不要让 esbuild 二次压缩 xterm 的预压缩 ESM（optimizeDeps
  //    会重新打包并可能破坏解析器处理器），直接从包内原始模块加载。
  optimizeDeps: {
    exclude: ["@xterm/xterm"],
  },
}));
