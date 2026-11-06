import { describe, it, expect } from 'vitest';
import { composeAttachmentMessage } from '../attachments';

describe('composeAttachmentMessage', () => {
  it('returns the text alone when nothing is attached', () => {
    expect(composeAttachmentMessage('  hello ', [], [])).toBe('hello');
  });

  it('appends attachments to the text', () => {
    expect(composeAttachmentMessage('look at this', ['/u/a.png'], [])).toBe('look at this [attached image: /u/a.png]');
  });

  it('lists images and files separately', () => {
    expect(composeAttachmentMessage('check', ['/u/a.png', '/u/b.png'], ['/s/x.tar.gz'])).toBe(
      'check [attached images: /u/a.png /u/b.png; file (in the session uploads folder): /s/x.tar.gz]',
    );
  });

  it('describes attachments sent without text', () => {
    expect(composeAttachmentMessage('', [], ['/s/a', '/s/b'])).toBe(
      'I attached files (in the session uploads folder): /s/a /s/b',
    );
  });

  it('stays on one line', () => {
    expect(composeAttachmentMessage('hi', ['/u/a.png'], ['/s/b'])).not.toContain('\n');
  });
});
