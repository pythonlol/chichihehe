import { defineConfig } from 'astro/config';

// GitHub Pages 用 /chichihehe 子路径；自有服务器部署在根路径，用 ASTRO_BASE=/ 覆盖
export default defineConfig({
  site: 'https://pythonlol.github.io',
  base: process.env.ASTRO_BASE || '/chichihehe',
});
