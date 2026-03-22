/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--color-background)',
        surface: 'var(--color-surface)',
        'surface-alt': 'var(--color-surface-alt)',
        primary: 'var(--color-primary)',
        'primary-dim': 'var(--color-primary-dim)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        border: 'var(--color-border)',
        status: {
          resting: 'var(--color-status-resting)',
          working: 'var(--color-status-working)',
          'needs-input': 'var(--color-status-needs-input)',
          error: 'var(--color-status-error)',
          success: 'var(--color-status-success)',
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
  plugins: [require('@tailwindcss/typography')],
};
