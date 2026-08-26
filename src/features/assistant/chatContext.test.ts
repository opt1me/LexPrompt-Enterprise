import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractableText,
  buildChatContext,
  capHistory,
  sendChatMessage,
  UNREADABLE_MESSAGE,
  NEEDS_IMAGE_MODEL_MESSAGE,
  type ChatMessage,
} from './chatContext';
import type { DocumentFile, Settings } from '../../types';

vi.mock('../../lib/openrouter', () => ({ chatStream: vi.fn() }));
const { chatStream } = await import('../../lib/openrouter');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

function doc(overrides: Partial<DocumentFile> = {}): DocumentFile {
  return {
    id: 'd1',
    name: 'lease.pdf',
    kind: 'pdf',
    text: 'This lease runs for twelve months.',
    file: new File([''], 'lease.pdf'),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('extractableText', () => {
  it('returns the text unchanged when there are no page markers', () => {
    expect(extractableText(doc({ text: 'Hello world' }))).toBe('Hello world');
  });

  it('strips [Page N] markers', () => {
    expect(extractableText(doc({ text: '[Page 1]\nHello\n\n[Page 2]\nworld\n\n' }))).toBe('Hello\n\n\nworld');
  });

  it('reduces a fully scanned document (markers only, no real content) to empty', () => {
    expect(extractableText(doc({ text: '[Page 1]\n\n\n[Page 2]\n\n\n' }))).toBe('');
  });
});

describe('buildChatContext', () => {
  it('uses the document text when present', () => {
    const ctx = buildChatContext([doc()], false, 10_000);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') {
      expect(ctx.text).toContain('twelve months');
      expect(ctx.images).toEqual([]);
    }
  });

  it('falls back to page images when there is no text and the model supports images', () => {
    const scan = doc({ text: '[Page 1]\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const ctx = buildChatContext([scan], true, 10_000);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') {
      expect(ctx.text).toBe('');
      expect(ctx.images).toEqual([{ mime: 'image/jpeg', data: 'AAA' }]);
    }
  });

  it('declines with needs-image-model when the scan has images but the model cannot read them', () => {
    const scan = doc({ text: '[Page 1]\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const ctx = buildChatContext([scan], false, 10_000);
    expect(ctx.kind).toBe('needs-image-model');
  });

  it('declines with unreadable when there is neither text nor images', () => {
    const blank = doc({ text: '[Page 1]\n\n' });
    const ctx = buildChatContext([blank], true, 10_000);
    expect(ctx.kind).toBe('unreadable');
  });

  it('declines with unreadable (not needs-image-model) when there are no images to speak of, regardless of model support', () => {
    const blank = doc({ text: '' });
    expect(buildChatContext([blank], false, 10_000).kind).toBe('unreadable');
  });

  it('truncates combined text to the given budget', () => {
    const long = doc({ text: 'x'.repeat(100) });
    const ctx = buildChatContext([long], false, 20);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') expect(ctx.text.length).toBe(20);
  });

  it('uses text from one document and does not require every document to have text', () => {
    const textDoc = doc({ id: 'd1', name: 'a.txt', text: 'this is a perfectly readable document' });
    const scanDoc = doc({ id: 'd2', name: 'b.pdf', text: '[Page 1]\n\n' });
    const ctx = buildChatContext([textDoc, scanDoc], false, 10_000);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') expect(ctx.text).toContain('readable');
  });

  // Regression coverage for the truthy-check bug: a page that yielded a
  // few characters of OCR noise (below SCAN_TEXT_THRESHOLD) must NOT count
  // as "has text" — that would silently skip the page images captured for
  // that very page and send the model a near-empty prompt instead.
  it('treats sub-threshold junk text as unreadable and sends the page images instead', () => {
    const junkScan = doc({ text: '[Page 1]\nAB\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const ctx = buildChatContext([junkScan], true, 10_000);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') {
      expect(ctx.text).toBe('');
      expect(ctx.text).not.toContain('AB');
      expect(ctx.images).toEqual([{ mime: 'image/jpeg', data: 'AAA' }]);
    }
  });

  it('declines rather than sending sub-threshold junk text when there are no images to fall back on', () => {
    const junkScan = doc({ text: '[Page 1]\nAB\n\n' });
    const ctx = buildChatContext([junkScan], true, 10_000);
    expect(ctx.kind).toBe('unreadable');
  });

  it('declines with needs-image-model for sub-threshold junk text when images exist but the model cannot read them', () => {
    const junkScan = doc({ text: '[Page 1]\nAB\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const ctx = buildChatContext([junkScan], false, 10_000);
    expect(ctx.kind).toBe('needs-image-model');
  });

  it('keeps a good page\'s text and drops only the sparse page in a mixed document', () => {
    const mixed = doc({ text: '[Page 1]\nThis is a perfectly readable cover page.\n\n[Page 2]\nAB\n\n' });
    const ctx = buildChatContext([mixed], false, 10_000);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind === 'ok') {
      expect(ctx.text).toContain('readable cover page');
      expect(ctx.text).not.toContain('AB');
    }
  });
});

describe('capHistory', () => {
  const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

  it('keeps everything when under budget', () => {
    const history = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c'), msg('assistant', 'd')];
    expect(capHistory(history, 1000)).toEqual(history);
  });

  it('drops the oldest turns first when over budget', () => {
    const history = [
      msg('user', 'x'.repeat(50)),
      msg('assistant', 'y'.repeat(50)),
      msg('user', 'recent question'),
      msg('assistant', 'recent answer'),
    ];
    const capped = capHistory(history, 40);
    expect(capped).toEqual([msg('user', 'recent question'), msg('assistant', 'recent answer')]);
  });

  it('always keeps the most recent exchange intact even if it alone exceeds the budget', () => {
    const history = [msg('user', 'q'), msg('assistant', 'x'.repeat(500))];
    const capped = capHistory(history, 10);
    expect(capped).toEqual(history);
  });

  it('returns an empty array for empty history', () => {
    expect(capHistory([], 1000)).toEqual([]);
  });
});

describe('sendChatMessage', () => {
  const baseParams = {
    query: 'What is the term?',
    history: [] as ChatMessage[],
    contextLength: 100_000,
    settings,
    onDelta: vi.fn(),
  };

  it('declines without calling the model when there is no readable text or images', async () => {
    const blank = doc({ text: '' });
    const result = await sendChatMessage({ ...baseParams, documents: [blank], modelSupportsImages: false });

    expect(result).toBe(UNREADABLE_MESSAGE);
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('declines without calling the model when images exist but the model cannot read them', async () => {
    const scan = doc({ text: '[Page 1]\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const result = await sendChatMessage({ ...baseParams, documents: [scan], modelSupportsImages: false });

    expect(result).toBe(NEEDS_IMAGE_MODEL_MESSAGE);
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('sends page images to the model when there is no text and the model supports images', async () => {
    vi.mocked(chatStream).mockResolvedValue('It runs for one year.');
    const scan = doc({ text: '[Page 1]\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });

    const result = await sendChatMessage({ ...baseParams, documents: [scan], modelSupportsImages: true });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatStream).mock.calls[0][0].images).toEqual([{ mime: 'image/jpeg', data: 'AAA' }]);
    expect(result).toBe('It runs for one year.');
  });

  it('calls the model with the document text and no images when text is available', async () => {
    vi.mocked(chatStream).mockResolvedValue('Twelve months.');
    const result = await sendChatMessage({ ...baseParams, documents: [doc()], modelSupportsImages: false });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatStream).mock.calls[0][0].images).toBeUndefined();
    expect(vi.mocked(chatStream).mock.calls[0][0].user).toContain('twelve months');
    expect(result).toBe('Twelve months.');
  });

  // Regression coverage at the sendChatMessage level (not just
  // buildChatContext): sub-threshold OCR noise must route to the images
  // that were actually captured for that page, not leak into the prompt
  // as if it were real content.
  it('sends the page images, not sub-threshold junk text, to the model', async () => {
    vi.mocked(chatStream).mockResolvedValue('Answer from the image.');
    const junkScan = doc({ text: '[Page 1]\nAB\n\n', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });

    const result = await sendChatMessage({ ...baseParams, documents: [junkScan], modelSupportsImages: true });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatStream).mock.calls[0][0].images).toEqual([{ mime: 'image/jpeg', data: 'AAA' }]);
    expect(vi.mocked(chatStream).mock.calls[0][0].user).not.toContain('AB');
    expect(result).toBe('Answer from the image.');
  });

  it('declines without calling the model when the only text is sub-threshold junk and there are no images', async () => {
    const junkScan = doc({ text: '[Page 1]\nAB\n\n' });
    const result = await sendChatMessage({ ...baseParams, documents: [junkScan], modelSupportsImages: true });

    expect(result).toBe(UNREADABLE_MESSAGE);
    expect(chatStream).not.toHaveBeenCalled();
  });
});
