declare module 'ansi-to-html' {
  interface AnsiToHtmlOptions {
    fg?: string;
    bg?: string;
    colors?: Record<number, string>;
    escapeXML?: boolean;
    newline?: boolean;
    stream?: boolean;
  }

  class AnsiToHtml {
    constructor(options?: AnsiToHtmlOptions);
    toHtml(input: string): string;
  }

  export default AnsiToHtml;
}
