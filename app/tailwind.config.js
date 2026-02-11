/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0a',
        surface: '#111111',
        'surface-alt': '#1a1a1a',
        primary: '#00ff41',
        'primary-dim': '#00cc33',
        text: '#e0e0e0',
        'text-muted': '#999999',
        border: '#222222',
        status: {
          resting: '#555555',
          working: '#00ff41',
          'needs-input': '#ffaa00',
          error: '#ff4444',
          success: '#22c55e',
        },
      },
      fontFamily: {
        mono: ['Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '2px',
      },
    },
  },
  plugins: [],
};
