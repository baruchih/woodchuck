import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Woodchuck',
        short_name: 'Woodchuck',
        description: 'Monitor and control Claude Code sessions',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
  server: {
    host: '0.0.0.0', // Listen on all interfaces for Tailscale access
    // For HTTPS in dev mode, place your Tailscale certs in app/certs/ and uncomment:
    // https: {
    //   key: fs.readFileSync(path.resolve(__dirname, 'certs/your-machine.tailnet.ts.net.key')),
    //   cert: fs.readFileSync(path.resolve(__dirname, 'certs/your-machine.tailnet.ts.net.crt')),
    // },
    proxy: {
      '/api': 'http://localhost:1212',
      '/ws': {
        target: 'ws://localhost:1212',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
