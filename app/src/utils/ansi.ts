import AnsiToHtml from 'ansi-to-html';

// Create a shared converter instance with appropriate options
const converter = new AnsiToHtml({
  fg: '#e0e0e0', // Match our text color
  bg: '#0a0a0a', // Match our background
  colors: {
    0: '#1a1a1a', // Black
    1: '#ff6b6b', // Red
    2: '#51cf66', // Green
    3: '#ffd43b', // Yellow
    4: '#74c0fc', // Blue
    5: '#f783ac', // Magenta
    6: '#66d9e8', // Cyan
    7: '#e0e0e0', // White
    8: '#666666', // Bright black
    9: '#ff8787', // Bright red
    10: '#69db7c', // Bright green
    11: '#ffe066', // Bright yellow
    12: '#91a7ff', // Bright blue
    13: '#f8a5c2', // Bright magenta
    14: '#99e9f2', // Bright cyan
    15: '#ffffff', // Bright white
  },
  escapeXML: true, // Security: escape HTML entities
});

/**
 * Convert ANSI escape codes to HTML spans with inline styles.
 * Safe to use with dangerouslySetInnerHTML since escapeXML is enabled.
 */
export function ansiToHtml(text: string): string {
  return converter.toHtml(text);
}
